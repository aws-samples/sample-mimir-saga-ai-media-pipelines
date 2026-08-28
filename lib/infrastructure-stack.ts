import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as stepfunctionsTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import { Construct } from 'constructs';
import * as path from 'path';

export interface InfrastructureStackProps extends cdk.StackProps {
  // Product display name, e.g. "Mimir Saga AI"
  productName: string;
  // Product acronym used to prefix resource names, e.g. "MSAI"
  acronym: string;
}

export class InfrastructureStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: InfrastructureStackProps) {
    super(scope, id, props);

    // Resource naming prefix derived from the product acronym (e.g. "msai")
    const resourcePrefix = props.acronym.toLowerCase();

    // Read configuration from CDK context (populated from parameters.json in bin/)
    const mimirApiKey = this.node.tryGetContext('mimirApiKey') || 'placeholder-update-after-deployment';
    const sagaApiKey = this.node.tryGetContext('sagaApiKey') || 'placeholder-update-after-deployment';
    const sagaApiUrl = this.node.tryGetContext('sagaApiUrl') || 'https://us.mjoll.no';
    const mimirInstance = this.node.tryGetContext('mimirInstance') || 'us';
    const summaryFieldName = this.node.tryGetContext('summaryFieldName') || 'description';
    // Optional: pin the Cognito issuer allowed to invoke custom actions.
    // Leave blank to accept any valid AWS Cognito issuer (token must still be
    // signature-valid, unexpired, and a Cognito ID token).
    const mimirAllowedIssuer = this.node.tryGetContext('mimirAllowedIssuer') || '';
    // When true, the Summarize action runs AWS Transcribe on items that lack a
    // Mimir transcript, publishes the transcript back to Mimir, and uses it in
    // the summary. Set to 'false' to keep summaries visual-only (avoids
    // Transcribe cost). Default: true.
    const enableTranscribeFallback = String(this.node.tryGetContext('enableTranscribeFallback') ?? 'true') !== 'false';

    // S3 bucket for processed video outputs
    const outputBucket = new s3.Bucket(this, 'ReframedVideoBucket', {
      bucketName: `${resourcePrefix}-reframed-videos-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      versioned: true,
      enforceSSL: true,
    });


    // Create Mimir API key secret (for us to call Mimir)
    const mimirApiKeySecret = new secretsmanager.Secret(this, 'MimirApiKey', {
      description: 'API key for calling Mimir API',
      secretStringValue: cdk.SecretValue.unsafePlainText(mimirApiKey),
    });

    // Create Saga API secrets
    const sagaApiKeySecret = new secretsmanager.Secret(this, 'SagaApiKey', {
      description: 'API key for calling Saga API',
      secretStringValue: cdk.SecretValue.unsafePlainText(sagaApiKey),
    });

    const sagaApiUrlSecret = new secretsmanager.Secret(this, 'SagaApiUrl', {
      description: 'Base URL for Saga API',
      secretStringValue: cdk.SecretValue.unsafePlainText(sagaApiUrl),
    });

    // Auto-generated key that Saga sends as the `x-api-key` header when triggering
    // story actions. After deploy, retrieve this value from Secrets Manager and set
    // it in Saga's "Configure Auth" dialog (Auth type: API key) when creating each
    // Saga custom action. See the deployment guide.
    const sagaActionsApiKeySecret = new secretsmanager.Secret(this, 'SagaActionsApiKey', {
      description: 'Shared x-api-key for authenticating Saga story action requests. Set this value in Saga Configure Auth.',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'apiKey',
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    // Lambda function for getting Mimir item details
    const mimirDetailsHandler = new lambda.Function(this, 'MimirDetailsHandler', {
      functionName: `${resourcePrefix}-mimir-details-handler-infra`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/mimir-details-handler'),
      timeout: cdk.Duration.seconds(30),
      environment: {
        MIMIR_API_KEY_SECRET_ARN: mimirApiKeySecret.secretArn,
      },
    });

    // Lambda function for Mimir asset creation
    const mimirAssetHandler = new lambda.Function(this, 'MimirAssetHandler', {
      functionName: `${resourcePrefix}-mimir-asset-handler-infra`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/mimir-asset-handler'),
      timeout: cdk.Duration.seconds(30),
      environment: {
        MIMIR_API_KEY_SECRET_ARN: mimirApiKeySecret.secretArn,
        OUTPUT_BUCKET_NAME: outputBucket.bucketName,
        // Optional JSON map of content provider -> Mimir visibility group id,
        // e.g. {"ABC":"mytenant:GROUP-ABC","*":"mytenant:GROUP-DEFAULT"}.
        // When empty, created items use the tenant's default visibility.
        VISIBILITY_GROUP_MAP: this.node.tryGetContext('visibilityGroupMap') || '',
      },
    });

    // Video Staging Bucket (shared across summarizer, embeddings, transcription)
    const videoStagingBucket = new s3.Bucket(this, 'VideoEmbeddingStagingBucket', {
      bucketName: `${resourcePrefix}-video-embedding-staging-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      // Transient staging: staged video copies and embedding intermediates are
      // large and short-lived, so expire everything here after 7 days. Durable
      // derived metadata (e.g. camera-stability maps) must NOT live here — it
      // goes in the mediaAnalysisBucket below.
      lifecycleRules: [{
        expiration: cdk.Duration.days(7),
      }],
    });

    // Durable derived-metadata bucket. Analysis outputs like camera-stability
    // maps are small but must persist for the life of the clip — the rough cut
    // agent reads them at generation time to keep shaky footage out of B-roll.
    // They intentionally do NOT live in the transient staging bucket (7-day
    // expiry), which may also be barely used in customer-account deployments
    // that read source video directly from S3. Layout mirrors the Mimir item
    // id: stability/{itemId}/segments.json.
    const mediaAnalysisBucket = new s3.Bucket(this, 'MediaAnalysisBucket', {
      bucketName: `${resourcePrefix}-media-analysis-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
    });

    // Lambda function for Bedrock summarization
    const summarizerHandler = new lambda.Function(this, 'SummarizerHandler', {
      functionName: `${resourcePrefix}-summarizer-handler-infra`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/summarizer-handler'),
      timeout: cdk.Duration.minutes(15),
      memorySize: 10240,
      ephemeralStorageSize: cdk.Size.mebibytes(10240),
      environment: {
        MIMIR_API_KEY_SECRET_ARN: mimirApiKeySecret.secretArn,
        MIMIR_API_BASE: `https://${mimirInstance}.mjoll.no`,
        VIDEO_STAGING_BUCKET: videoStagingBucket.bucketName,
        SUMMARIZER_MODEL_ID: 'us.amazon.nova-pro-v1:0',
      },
    });

    // Lambda function for updating Mimir with summary
    const mimirUpdateHandler = new lambda.Function(this, 'MimirUpdateHandler', {
      functionName: `${resourcePrefix}-mimir-update-handler-infra`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/mimir-update-handler'),
      timeout: cdk.Duration.seconds(30),
      environment: {
        MIMIR_API_KEY_SECRET_ARN: mimirApiKeySecret.secretArn,
        SUMMARY_FIELD_NAME: summaryFieldName,
      },
    });

    // Lambda function for chapterizing content
    const chapterizeHandler = new lambda.Function(this, 'ChapterizeHandler', {
      functionName: `${resourcePrefix}-chapterize-handler`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/chapterize-handler'),
      timeout: cdk.Duration.minutes(15),
      memorySize: 10240,
      ephemeralStorageSize: cdk.Size.mebibytes(10240),
      environment: {
        MIMIR_API_KEY_SECRET_ARN: mimirApiKeySecret.secretArn,
        MIMIR_API_BASE: `https://${mimirInstance}.mjoll.no`,
        VIDEO_STAGING_BUCKET: videoStagingBucket.bucketName,
        CHAPTERIZE_MODEL_ID: 'us.amazon.nova-pro-v1:0',
      },
    });

    // Lambda function for updating Mimir with chapters
    const mimirLoggingHandler = new lambda.Function(this, 'MimirLoggingHandler', {
      functionName: `${resourcePrefix}-mimir-logging-handler`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/mimir-logging-handler'),
      timeout: cdk.Duration.seconds(30),
      environment: {
        MIMIR_API_KEY_SECRET_ARN: mimirApiKeySecret.secretArn,
      },
    });

    // Grant Lambda permissions
    mimirDetailsHandler.grantInvoke(new iam.ServicePrincipal('states.amazonaws.com'));
    summarizerHandler.grantInvoke(new iam.ServicePrincipal('states.amazonaws.com'));
    mimirUpdateHandler.grantInvoke(new iam.ServicePrincipal('states.amazonaws.com'));
    chapterizeHandler.grantInvoke(new iam.ServicePrincipal('states.amazonaws.com'));
    mimirLoggingHandler.grantInvoke(new iam.ServicePrincipal('states.amazonaws.com'));
    
    mimirApiKeySecret.grantRead(mimirDetailsHandler);
    mimirApiKeySecret.grantRead(mimirAssetHandler);
    mimirApiKeySecret.grantRead(summarizerHandler);
    videoStagingBucket.grantReadWrite(summarizerHandler);
    mimirApiKeySecret.grantRead(mimirUpdateHandler);
    mimirApiKeySecret.grantRead(chapterizeHandler);
    videoStagingBucket.grantReadWrite(chapterizeHandler);
    mimirApiKeySecret.grantRead(mimirLoggingHandler);
    outputBucket.grantRead(mimirAssetHandler);

    // Grant Bedrock permissions to summarizer and chapterize
    summarizerHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: ['*'],
    }));

    chapterizeHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: ['*'],
    }));

    // Video staging + Transcribe Lambdas — declared before the Summarizer state
    // machine so they can be referenced by the transcribe-fallback branch. They
    // are also used later by the rough cut and embedding state machines.
    const videoToS3Handler = new lambda.Function(this, 'VideoToS3Handler', {
      functionName: `${resourcePrefix}-video-to-s3-handler`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/video-to-s3-handler'),
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: {
        VIDEO_STAGING_BUCKET: videoStagingBucket.bucketName,
        MIMIR_API_KEY_SECRET_ARN: mimirApiKeySecret.secretArn,
      },
    });

    // Transcribe Handler Lambda for transcript generation pipeline
    const transcribeHandler = new lambda.Function(this, 'TranscribeHandler', {
      functionName: `${resourcePrefix}-transcribe-handler`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/transcribe-handler'),
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        VIDEO_STAGING_BUCKET: videoStagingBucket.bucketName,
        MIMIR_API_KEY_SECRET_ARN: mimirApiKeySecret.secretArn,
        MIMIR_API_BASE: `https://${mimirInstance}.mjoll.no`,
      },
    });

    // Transcribe handler IAM permissions
    videoStagingBucket.grantReadWrite(transcribeHandler);
    videoStagingBucket.grantWrite(videoToS3Handler);
    mimirApiKeySecret.grantRead(videoToS3Handler);

    transcribeHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'transcribe:StartTranscriptionJob',
        'transcribe:GetTranscriptionJob',
        'transcribe:DeleteTranscriptionJob',
      ],
      resources: ['*'],
    }));

    mimirApiKeySecret.grantRead(transcribeHandler);

    // Transcribe service role — allows Amazon Transcribe to read/write the staging bucket
    const transcribeServiceRole = new iam.Role(this, 'TranscribeServiceRole', {
      assumedBy: new iam.ServicePrincipal('transcribe.amazonaws.com'),
    });
    videoStagingBucket.grantRead(transcribeServiceRole);
    videoStagingBucket.grantWrite(transcribeServiceRole);

    // Summarizer State Machine
    const storeVariablesSummarizer = new stepfunctions.Pass(this, 'StoreVariablesSummarizer', {
      parameters: {
        'items.$': '$.items',
        'userToken.$': '$.userToken',
        'actionData.$': '$.actionData',
        'userId.$': '$.userId',
        'userEmail.$': '$.userEmail',
        'mimirApiKey.$': '$.mimirApiKey',
        'actionType.$': '$.actionType'
      }
    });

    const getMimirDetailsSummarizer = new stepfunctionsTasks.LambdaInvoke(this, 'GetMimirDetailsSummarizer', {
      lambdaFunction: mimirDetailsHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'id.$': '$.id',
        'itemType.$': '$.itemType',
        'metadata.$': '$.metadata',
        'mimirApiKey.$': '$$.Execution.Input.mimirApiKey'
      }),
      outputPath: '$.Payload'
    });

    const summarizeContent = new stepfunctionsTasks.LambdaInvoke(this, 'SummarizeContent', {
      lambdaFunction: summarizerHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'itemDetails.$': '$',
        'mimirApiKey.$': '$$.Execution.Input.mimirApiKey'
      }),
      outputPath: '$.Payload'
    });

    const updateMimirWithSummary = new stepfunctionsTasks.LambdaInvoke(this, 'UpdateMimirWithSummary', {
      lambdaFunction: mimirUpdateHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'itemId.$': '$.id',
        'summary.$': '$.summary',
        'mimirApiKey.$': '$$.Execution.Input.mimirApiKey'
      })
    });

    const summaryFailed = new stepfunctions.Pass(this, 'SummaryFailed', {
      result: stepfunctions.Result.fromObject({ status: 'failed', reason: 'Summarization failed' })
    });

    const skipItemSummarizer = new stepfunctions.Pass(this, 'SkipItemSummarizer', {
      result: stepfunctions.Result.fromObject({ status: 'skipped', reason: 'Item type not supported for summarization' })
    });

    // Establish the summarize tail once. Several predecessors (the "already has a
    // transcript" path, the post-Transcribe path, and the "Transcribe failed"
    // fallback) all transition into SummarizeContent.
    summarizeContent.addCatch(summaryFailed);
    summarizeContent.next(updateMimirWithSummary);

    // The node that GetMimirDetails flows into. With the fallback enabled this is
    // a Choice that runs Transcribe when the item has no Mimir transcript;
    // otherwise it is simply SummarizeContent.
    let postDetailsSummarizer: stepfunctions.IChainable = summarizeContent;

    if (enableTranscribeFallback) {
      // ---- Transcribe fallback branch (runs when an item has no Mimir transcript) ----
      // Every task uses resultPath so the enriched item (id, proxyUrl,
      // mimirDetails, ...) stays at the root. After the transcript is published to
      // Mimir, SummarizeContent re-fetches it from Mimir by item id (decoupled
      // from the state's now-stale mimirDetails snapshot).
      const checkVideoForTranscript = new stepfunctionsTasks.LambdaInvoke(this, 'CheckVideoForTranscript', {
        lambdaFunction: transcribeHandler,
        payload: stepfunctions.TaskInput.fromObject({
          action: 'check-video',
          'itemId.$': '$.id',
        }),
        payloadResponseOnly: true,
        resultPath: '$.videoCheck',
      });

      const downloadVideoForTranscript = new stepfunctionsTasks.LambdaInvoke(this, 'DownloadVideoForTranscript', {
        lambdaFunction: videoToS3Handler,
        payload: stepfunctions.TaskInput.fromObject({
          'proxyUrl.$': '$.proxyUrl',
          'id.$': '$.id',
        }),
        payloadResponseOnly: true,
        resultPath: '$.videoStaging',
      });

      // Normalize the staged video URI (from either check-video or the fresh
      // download) into a single path the start-transcribe task reads.
      const useStagedVideoUri = new stepfunctions.Pass(this, 'UseStagedVideoUri', {
        parameters: { 'value.$': '$.videoCheck.s3Uri' },
        resultPath: '$.transcribeVideo',
      });
      const useDownloadedVideoUri = new stepfunctions.Pass(this, 'UseDownloadedVideoUri', {
        parameters: { 'value.$': '$.videoStaging.s3Uri' },
        resultPath: '$.transcribeVideo',
      });
      // Direct-access path: point Transcribe straight at the customer's source
      // object (no download needed).
      const useSourceVideoUri = new stepfunctions.Pass(this, 'UseSourceVideoUri', {
        parameters: { 'value.$': '$.transcribeSource.value' },
        resultPath: '$.transcribeVideo',
      });

      // Build the customer's source S3 URI from the Mimir ingest fields, then test
      // whether this account can read it directly. When deployed in the customer's
      // own account this succeeds and we skip staging; when the custom action runs
      // in a separate account (our current test setup) access is denied and we
      // fall back to downloading the pre-signed proxy into the staging bucket.
      const buildSourceUriForTranscript = new stepfunctions.Pass(this, 'BuildSourceUriForTranscript', {
        parameters: {
          'value.$': "States.Format('s3://{}/{}', $.ingestSourceS3Bucket, $.ingestSourceFullPath)",
        },
        resultPath: '$.transcribeSource',
      });

      const checkSourceAccessForTranscript = new stepfunctionsTasks.LambdaInvoke(this, 'CheckSourceAccessForTranscript', {
        lambdaFunction: transcribeHandler,
        payload: stepfunctions.TaskInput.fromObject({
          action: 'check-access',
          's3Uri.$': '$.transcribeSource.value',
        }),
        payloadResponseOnly: true,
        resultPath: '$.sourceAccess',
      });

      const startTranscribeForSummary = new stepfunctionsTasks.LambdaInvoke(this, 'StartTranscribeForSummary', {
        lambdaFunction: transcribeHandler,
        payload: stepfunctions.TaskInput.fromObject({
          action: 'start-transcribe',
          'itemId.$': '$.id',
          's3Uri.$': '$.transcribeVideo.value',
        }),
        payloadResponseOnly: true,
        resultPath: '$.transcribeJob',
      });

      const waitForTranscribe = new stepfunctions.Wait(this, 'WaitForTranscribe', {
        time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(20)),
      });

      const pollTranscribeForSummary = new stepfunctionsTasks.LambdaInvoke(this, 'PollTranscribeForSummary', {
        lambdaFunction: transcribeHandler,
        payload: stepfunctions.TaskInput.fromObject({
          action: 'poll-transcribe',
          'itemId.$': '$.id',
          'jobName.$': '$.transcribeJob.jobName',
        }),
        payloadResponseOnly: true,
        resultPath: '$.transcribeStatus',
      });

      const publishTranscript = new stepfunctionsTasks.LambdaInvoke(this, 'PublishTranscript', {
        lambdaFunction: transcribeHandler,
        payload: stepfunctions.TaskInput.fromObject({
          action: 'publish-transcript',
          'itemId.$': '$.id',
          'mimirApiKey.$': '$$.Execution.Input.mimirApiKey',
        }),
        payloadResponseOnly: true,
        resultPath: '$.transcribePublish',
      });

      // Poll loop: IN_PROGRESS -> wait and re-poll; COMPLETED -> publish to Mimir;
      // anything else (FAILED/unexpected) -> fall through to a visual-only summary.
      const transcribeCompleteChoice = new stepfunctions.Choice(this, 'TranscribeCompleteChoice')
        .when(stepfunctions.Condition.stringEquals('$.transcribeStatus.status', 'IN_PROGRESS'), waitForTranscribe)
        .when(stepfunctions.Condition.stringEquals('$.transcribeStatus.status', 'COMPLETED'), publishTranscript)
        .otherwise(summarizeContent);

      startTranscribeForSummary.next(waitForTranscribe);
      waitForTranscribe.next(pollTranscribeForSummary);
      pollTranscribeForSummary.next(transcribeCompleteChoice);
      publishTranscript.next(summarizeContent);

      // Stage the video first if it isn't already in the staging bucket.
      const videoStagedChoice = new stepfunctions.Choice(this, 'VideoStagedForTranscript')
        .when(
          stepfunctions.Condition.booleanEquals('$.videoCheck.exists', true),
          useStagedVideoUri.next(startTranscribeForSummary)
        )
        .otherwise(
          downloadVideoForTranscript.next(useDownloadedVideoUri).next(startTranscribeForSummary)
        );
      checkVideoForTranscript.next(videoStagedChoice);

      // If we can read the customer's source object directly, transcribe it in
      // place; otherwise fall back to the staging path (check staging bucket,
      // download the proxy if needed).
      const sourceAccessChoice = new stepfunctions.Choice(this, 'SourceAccessForTranscript')
        .when(
          stepfunctions.Condition.booleanEquals('$.sourceAccess.accessible', true),
          useSourceVideoUri.next(startTranscribeForSummary)
        )
        .otherwise(checkVideoForTranscript);
      buildSourceUriForTranscript.next(checkSourceAccessForTranscript);
      checkSourceAccessForTranscript.next(sourceAccessChoice);

      // Entry to the fallback: try the customer's source S3 first (if Mimir
      // reported an ingest source bucket), otherwise go straight to staging.
      const tryDirectThenStage = new stepfunctions.Choice(this, 'HasSourceUriForTranscript')
        .when(
          stepfunctions.Condition.and(
            stepfunctions.Condition.isPresent('$.ingestSourceS3Bucket'),
            stepfunctions.Condition.not(stepfunctions.Condition.stringEquals('$.ingestSourceS3Bucket', ''))
          ),
          buildSourceUriForTranscript
        )
        .otherwise(checkVideoForTranscript);

      // Decide whether the item already has a transcript in Mimir. Only video and
      // audio items are eligible for the Transcribe fallback; text items (and any
      // item that already has a transcript) go straight to SummarizeContent.
      postDetailsSummarizer = new stepfunctions.Choice(this, 'HasMimirTranscript')
        .when(stepfunctions.Condition.isPresent('$.mimirDetails.timedTranscriptUrl'), summarizeContent)
        .when(
          stepfunctions.Condition.or(
            stepfunctions.Condition.stringEquals('$.itemType', 'video'),
            stepfunctions.Condition.stringEquals('$.itemType', 'audio')
          ),
          tryDirectThenStage
        )
        .otherwise(summarizeContent);
    }

    getMimirDetailsSummarizer.next(postDetailsSummarizer);

    // Summarizer supports video, audio, and text items
    const checkItemTypeSummarizer = new stepfunctions.Choice(this, 'CheckItemTypeSummarizer')
      .when(
        stepfunctions.Condition.or(
          stepfunctions.Condition.stringEquals('$.itemType', 'video'),
          stepfunctions.Condition.stringEquals('$.itemType', 'audio'),
          stepfunctions.Condition.stringEquals('$.itemType', 'text')
        ),
        getMimirDetailsSummarizer
      )
      .otherwise(skipItemSummarizer);

    const processItemsSummarizer = new stepfunctions.Map(this, 'ProcessItemsSummarizer', {
      itemsPath: stepfunctions.JsonPath.stringAt('$.items'),
      maxConcurrency: 3 // Lower concurrency for Bedrock calls
    }).itemProcessor(checkItemTypeSummarizer);

    const summarizerDefinition = storeVariablesSummarizer.next(processItemsSummarizer);

    const processSummarizerStateMachine = new stepfunctions.StateMachine(this, 'ProcessSummarizerStateMachine', {
      stateMachineName: `${resourcePrefix}-summarize-content`,
      definitionBody: stepfunctions.DefinitionBody.fromChainable(summarizerDefinition),
      timeout: cdk.Duration.minutes(15),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'SummarizerStateMachineLogs', { retention: logs.RetentionDays.ONE_MONTH }),
        level: stepfunctions.LogLevel.ALL
      }
    });

    // Chapterize State Machine
    const storeVariablesChapterize = new stepfunctions.Pass(this, 'StoreVariablesChapterize', {
      parameters: {
        'items.$': '$.items',
        'userToken.$': '$.userToken',
        'actionData.$': '$.actionData',
        'userId.$': '$.userId',
        'userEmail.$': '$.userEmail',
        'mimirApiKey.$': '$.mimirApiKey',
        'actionType.$': '$.actionType'
      }
    });

    const getMimirDetailsChapterize = new stepfunctionsTasks.LambdaInvoke(this, 'GetMimirDetailsChapterize', {
      lambdaFunction: mimirDetailsHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'id.$': '$.item.id',
        'itemType.$': '$.item.itemType',
        'metadata.$': '$.item.metadata',
        'mimirApiKey.$': '$.mimirApiKey'
      }),
      outputPath: '$.Payload'
    });

    const chapterizeContent = new stepfunctionsTasks.LambdaInvoke(this, 'ChapterizeContent', {
      lambdaFunction: chapterizeHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'itemDetails.$': '$',
        'mimirApiKey.$': '$.mimirApiKey'
      }),
      resultPath: '$.chapterizeResult'
    });

    const updateMimirWithChapters = new stepfunctionsTasks.LambdaInvoke(this, 'UpdateMimirWithChapters', {
      lambdaFunction: mimirLoggingHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'itemId.$': '$.chapterizeResult.Payload.id',
        'chapters.$': '$.chapterizeResult.Payload.chapters',
        'mimirApiKey.$': '$.mimirApiKey'
      })
    });

    const chapterizeFailed = new stepfunctions.Pass(this, 'ChapterizeFailed', {
      result: stepfunctions.Result.fromObject({ status: 'failed', reason: 'Chapterization failed' })
    });

    const skipItemChapterize = new stepfunctions.Pass(this, 'SkipItemChapterize', {
      result: stepfunctions.Result.fromObject({ status: 'skipped', reason: 'Not a video item' })
    });

    // Establish the chapterize tail once; the "already has a transcript" path, the
    // post-Transcribe path, and the "Transcribe failed" fallback all feed into it.
    chapterizeContent.addCatch(chapterizeFailed);
    chapterizeContent.next(updateMimirWithChapters);

    // The node GetMimirDetails flows into. With the fallback enabled this is a
    // Choice that runs Transcribe when the item has no Mimir transcript; otherwise
    // it is simply ChapterizeContent.
    let postDetailsChapterize: stepfunctions.IChainable = chapterizeContent;

    if (enableTranscribeFallback) {
      // ---- Transcribe fallback branch (mirrors the summarize pipeline) ----
      // All tasks use resultPath so the enriched item stays at the state root; the
      // chapterize handler reads the transcript from transcribeStatus.transcriptS3Uri.
      const checkVideoForChapters = new stepfunctionsTasks.LambdaInvoke(this, 'CheckVideoForChapters', {
        lambdaFunction: transcribeHandler,
        payload: stepfunctions.TaskInput.fromObject({ action: 'check-video', 'itemId.$': '$.id' }),
        payloadResponseOnly: true,
        resultPath: '$.videoCheck',
      });

      const downloadVideoForChapters = new stepfunctionsTasks.LambdaInvoke(this, 'DownloadVideoForChapters', {
        lambdaFunction: videoToS3Handler,
        payload: stepfunctions.TaskInput.fromObject({ 'proxyUrl.$': '$.proxyUrl', 'id.$': '$.id' }),
        payloadResponseOnly: true,
        resultPath: '$.videoStaging',
      });

      const useStagedVideoUriChapters = new stepfunctions.Pass(this, 'UseStagedVideoUriChapters', {
        parameters: { 'value.$': '$.videoCheck.s3Uri' },
        resultPath: '$.transcribeVideo',
      });
      const useDownloadedVideoUriChapters = new stepfunctions.Pass(this, 'UseDownloadedVideoUriChapters', {
        parameters: { 'value.$': '$.videoStaging.s3Uri' },
        resultPath: '$.transcribeVideo',
      });
      const useSourceVideoUriChapters = new stepfunctions.Pass(this, 'UseSourceVideoUriChapters', {
        parameters: { 'value.$': '$.transcribeSource.value' },
        resultPath: '$.transcribeVideo',
      });

      const buildSourceUriForChapters = new stepfunctions.Pass(this, 'BuildSourceUriForChapters', {
        parameters: {
          'value.$': "States.Format('s3://{}/{}', $.ingestSourceS3Bucket, $.ingestSourceFullPath)",
        },
        resultPath: '$.transcribeSource',
      });

      const checkSourceAccessForChapters = new stepfunctionsTasks.LambdaInvoke(this, 'CheckSourceAccessForChapters', {
        lambdaFunction: transcribeHandler,
        payload: stepfunctions.TaskInput.fromObject({ action: 'check-access', 's3Uri.$': '$.transcribeSource.value' }),
        payloadResponseOnly: true,
        resultPath: '$.sourceAccess',
      });

      const startTranscribeForChapters = new stepfunctionsTasks.LambdaInvoke(this, 'StartTranscribeForChapters', {
        lambdaFunction: transcribeHandler,
        payload: stepfunctions.TaskInput.fromObject({
          action: 'start-transcribe',
          'itemId.$': '$.id',
          's3Uri.$': '$.transcribeVideo.value',
        }),
        payloadResponseOnly: true,
        resultPath: '$.transcribeJob',
      });

      const waitForTranscribeChapters = new stepfunctions.Wait(this, 'WaitForTranscribeChapters', {
        time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(20)),
      });

      const pollTranscribeForChapters = new stepfunctionsTasks.LambdaInvoke(this, 'PollTranscribeForChapters', {
        lambdaFunction: transcribeHandler,
        payload: stepfunctions.TaskInput.fromObject({
          action: 'poll-transcribe',
          'itemId.$': '$.id',
          'jobName.$': '$.transcribeJob.jobName',
        }),
        payloadResponseOnly: true,
        resultPath: '$.transcribeStatus',
      });

      const publishTranscriptChapters = new stepfunctionsTasks.LambdaInvoke(this, 'PublishTranscriptChapters', {
        lambdaFunction: transcribeHandler,
        payload: stepfunctions.TaskInput.fromObject({
          action: 'publish-transcript',
          'itemId.$': '$.id',
          'mimirApiKey.$': '$.mimirApiKey',
        }),
        payloadResponseOnly: true,
        resultPath: '$.transcribePublish',
      });

      const transcribeCompleteChoiceChapters = new stepfunctions.Choice(this, 'TranscribeCompleteChoiceChapters')
        .when(stepfunctions.Condition.stringEquals('$.transcribeStatus.status', 'IN_PROGRESS'), waitForTranscribeChapters)
        .when(stepfunctions.Condition.stringEquals('$.transcribeStatus.status', 'COMPLETED'), publishTranscriptChapters)
        .otherwise(chapterizeContent);

      startTranscribeForChapters.next(waitForTranscribeChapters);
      waitForTranscribeChapters.next(pollTranscribeForChapters);
      pollTranscribeForChapters.next(transcribeCompleteChoiceChapters);
      publishTranscriptChapters.next(chapterizeContent);

      const videoStagedChoiceChapters = new stepfunctions.Choice(this, 'VideoStagedForChapters')
        .when(
          stepfunctions.Condition.booleanEquals('$.videoCheck.exists', true),
          useStagedVideoUriChapters.next(startTranscribeForChapters)
        )
        .otherwise(
          downloadVideoForChapters.next(useDownloadedVideoUriChapters).next(startTranscribeForChapters)
        );
      checkVideoForChapters.next(videoStagedChoiceChapters);

      const sourceAccessChoiceChapters = new stepfunctions.Choice(this, 'SourceAccessForChapters')
        .when(
          stepfunctions.Condition.booleanEquals('$.sourceAccess.accessible', true),
          useSourceVideoUriChapters.next(startTranscribeForChapters)
        )
        .otherwise(checkVideoForChapters);
      buildSourceUriForChapters.next(checkSourceAccessForChapters);
      checkSourceAccessForChapters.next(sourceAccessChoiceChapters);

      const tryDirectThenStageChapters = new stepfunctions.Choice(this, 'HasSourceUriForChapters')
        .when(
          stepfunctions.Condition.and(
            stepfunctions.Condition.isPresent('$.ingestSourceS3Bucket'),
            stepfunctions.Condition.not(stepfunctions.Condition.stringEquals('$.ingestSourceS3Bucket', ''))
          ),
          buildSourceUriForChapters
        )
        .otherwise(checkVideoForChapters);

      // Items are always video here (gated by CheckItemTypeChapterize). Route items
      // that already have a Mimir transcript straight to chapterization; otherwise
      // run the Transcribe fallback first.
      postDetailsChapterize = new stepfunctions.Choice(this, 'HasMimirTranscriptChapterize')
        .when(stepfunctions.Condition.isPresent('$.mimirDetails.timedTranscriptUrl'), chapterizeContent)
        .otherwise(tryDirectThenStageChapters);
    }

    getMimirDetailsChapterize.next(postDetailsChapterize);

    const checkItemTypeChapterize = new stepfunctions.Choice(this, 'CheckItemTypeChapterize')
      .when(
        stepfunctions.Condition.stringEquals('$.item.itemType', 'video'),
        getMimirDetailsChapterize
      )
      .otherwise(skipItemChapterize);

    const processItemsChapterize = new stepfunctions.Map(this, 'ProcessItemsChapterize', {
      itemsPath: stepfunctions.JsonPath.stringAt('$.items'),
      maxConcurrency: 3,
      itemSelector: {
        'item.$': '$$.Map.Item.Value',
        'mimirApiKey.$': '$.mimirApiKey'
      }
    }).itemProcessor(checkItemTypeChapterize);

    const chapterizeDefinition = storeVariablesChapterize.next(processItemsChapterize);

    const processChapterizeStateMachine = new stepfunctions.StateMachine(this, 'ProcessChapterizeStateMachine', {
      stateMachineName: `${resourcePrefix}-chapterize-content`,
      definitionBody: stepfunctions.DefinitionBody.fromChainable(chapterizeDefinition),
      timeout: cdk.Duration.minutes(15),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'ChapterizeStateMachineLogs', { retention: logs.RetentionDays.ONE_MONTH }),
        level: stepfunctions.LogLevel.ALL
      }
    });

    // Lambda function to handle API Gateway requests and start Step Functions
    const mimirHandler = new lambda.Function(this, 'MimirCustomActionHandler', {
      functionName: `${resourcePrefix}-mimir-handler`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/mimir-handler'),
      timeout: cdk.Duration.seconds(30),
      environment: {
        MIMIR_ALLOWED_ISSUER: mimirAllowedIssuer,
        MIMIR_API_KEY_SECRET_ARN: mimirApiKeySecret.secretArn,
        SUMMARIZER_STATE_MACHINE_ARN: processSummarizerStateMachine.stateMachineArn,
        CHAPTERIZE_STATE_MACHINE_ARN: processChapterizeStateMachine.stateMachineArn,
      },
    });

    // Grant Lambda permissions
    mimirApiKeySecret.grantRead(mimirHandler);
    processSummarizerStateMachine.grantStartExecution(mimirHandler);
    processChapterizeStateMachine.grantStartExecution(mimirHandler);

    // API Gateway
    const apiLogGroup = new logs.LogGroup(this, 'MimirCustomActionsApiLogs', { retention: logs.RetentionDays.ONE_MONTH });
    const api = new apigateway.RestApi(this, 'MimirCustomActionsApi', {
      restApiName: 'Mimir Custom Actions API',
      description: 'API Gateway for Mimir custom actions',
      deployOptions: {
        stageName: 'prod',
        accessLogDestination: new apigateway.LogGroupLogDestination(apiLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        tracingEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'X-API-Key', 'Authorization'],
      },
    });

    // Custom actions resource
    const actionsResource = api.root.addResource('actions');
    

    // POST /actions/summarizer endpoint
    const summarizerResource = actionsResource.addResource('summarizer');
    summarizerResource.addMethod('POST', new apigateway.LambdaIntegration(mimirHandler));

    // POST /actions/chapterize endpoint
    const chapterizeResource = actionsResource.addResource('chapterize');
    chapterizeResource.addMethod('POST', new apigateway.LambdaIntegration(mimirHandler));
    
    // POST /actions/vertical-reframe endpoint
    const verticalReframeResource = actionsResource.addResource('vertical-reframe');
    verticalReframeResource.addMethod('POST', new apigateway.LambdaIntegration(mimirHandler));

    // Additional reframe aspect ratio endpoints
    const reframe916Resource = actionsResource.addResource('reframe-9-16');
    reframe916Resource.addMethod('POST', new apigateway.LambdaIntegration(mimirHandler));

    const reframe11Resource = actionsResource.addResource('reframe-1-1');
    reframe11Resource.addMethod('POST', new apigateway.LambdaIntegration(mimirHandler));

    const reframe45Resource = actionsResource.addResource('reframe-4-5');
    reframe45Resource.addMethod('POST', new apigateway.LambdaIntegration(mimirHandler));

    // POST /actions/rough-cut endpoint — uses saga-action-handler (Saga payload format)
    const sagaActionHandler = new lambda.Function(this, 'SagaActionHandler', {
      functionName: `${resourcePrefix}-saga-action-handler`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/saga-action-handler'),
      timeout: cdk.Duration.seconds(30),
      environment: {
        MIMIR_API_KEY_SECRET_ARN: mimirApiKeySecret.secretArn,
        SAGA_API_KEY_SECRET_ARN: sagaApiKeySecret.secretArn,
        SAGA_API_URL_SECRET_ARN: sagaApiUrlSecret.secretArn,
        SAGA_ACTIONS_API_KEY_SECRET_ARN: sagaActionsApiKeySecret.secretArn,
        ROUGH_CUT_STATE_MACHINE_ARN: 'placeholder', // set after state machine creation
      },
    });
    mimirApiKeySecret.grantRead(sagaActionHandler);
    sagaActionsApiKeySecret.grantRead(sagaActionHandler);

    const roughCutResource = actionsResource.addResource('rough-cut');
    roughCutResource.addMethod('POST', new apigateway.LambdaIntegration(sagaActionHandler));

    // POST /actions/rough-cut-simple-vo endpoint — a rough-cut VARIANT that runs
    // the same rough-cut state machine/agent but with a stripped-down VO-only
    // profile. saga-action-handler maps this path to roughCutType="simple-vo".
    const roughCutSimpleVoResource = actionsResource.addResource('rough-cut-simple-vo');
    roughCutSimpleVoResource.addMethod('POST', new apigateway.LambdaIntegration(sagaActionHandler));

    // Mimir Webhooks API Gateway
    const webhookApiLogGroup = new logs.LogGroup(this, 'MimirWebhooksApiLogs', { retention: logs.RetentionDays.ONE_MONTH });
    const webhookApi = new apigateway.RestApi(this, 'ItemChangeWebhookApi', {
      restApiName: 'Mimir Webhooks API',
      description: 'API Gateway for all Mimir webhooks',
      deployOptions: {
        stageName: 'prod',
        accessLogDestination: new apigateway.LogGroupLogDestination(webhookApiLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        tracingEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'X-API-Key', 'Authorization'],
      },
    });

    // Create Lambda for item change webhook
    const itemChangeHandler = new lambda.Function(this, 'ItemChangeWebhookHandler', {
      functionName: `${resourcePrefix}-item-change-webhook`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/item-change-webhook')),
      environment: {
        MIMIR_API_KEY_SECRET_ARN: mimirApiKeySecret.secretArn,
      },
      timeout: cdk.Duration.seconds(30),
    });

    // Create Lambda for item create webhook
    const itemCreateHandler = new lambda.Function(this, 'ItemCreateWebhookHandler', {
      functionName: `${resourcePrefix}-item-create-webhook`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/item-create-webhook')),
      environment: {
        MIMIR_API_KEY_SECRET_ARN: mimirApiKeySecret.secretArn,
      },
      timeout: cdk.Duration.seconds(30),
    });

    // Grant permissions to read Mimir API key
    mimirApiKeySecret.grantRead(itemChangeHandler);
    mimirApiKeySecret.grantRead(itemCreateHandler);

    // DynamoDB table for Saga feed items lookup
    const sagaFeedItemsTable = new dynamodb.Table(this, 'SagaFeedItemsTable', {
      tableName: `${resourcePrefix}-saga-feed-items`,
      partitionKey: { name: 'title', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
    });

    // Store table name in SSM Parameter Store
    new ssm.StringParameter(this, 'SagaFeedItemsTableNameParameter', {
      parameterName: '/saga-feeds/dynamodb/table-name',
      stringValue: sagaFeedItemsTable.tableName,
      description: 'DynamoDB table name for Saga feed items'
    });
    // S3 Vector Bucket and Index for video embeddings
    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VideoEmbeddingsVectorBucket', {
      vectorBucketName: `${resourcePrefix}-video-embeddings-${this.account}`,
    });

    const vectorIndex = new s3vectors.CfnIndex(this, 'VideoEmbeddingsVectorIndex', {
      vectorBucketName: vectorBucket.vectorBucketName,
      indexName: 'video-embeddings-index',
      dataType: 'float32',
      dimension: 1024,
      distanceMetric: 'cosine',
    });
    vectorIndex.addDependency(vectorBucket);

    // Story Context Handler Lambda for rough cut pipeline
    const storyContextHandler = new lambda.Function(this, 'StoryContextHandler', {
      functionName: `${resourcePrefix}-story-context-handler`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/story-context-handler'),
      timeout: cdk.Duration.seconds(30),
      environment: {
        SAGA_API_KEY_SECRET_ARN: sagaApiKeySecret.secretArn,
        SAGA_API_URL_SECRET_ARN: sagaApiUrlSecret.secretArn,
        MIMIR_API_KEY_SECRET_ARN: mimirApiKeySecret.secretArn,
        VECTOR_BUCKET_NAME: vectorBucket.vectorBucketName!,
        VECTOR_INDEX_NAME: 'video-embeddings-index',
      },
    });

    // Lambda to invoke AgentCore Runtime with TaskToken (fire-and-forget pattern)
    const invokeRoughCutAgent = new lambda.Function(this, 'InvokeRoughCutAgent', {
      functionName: `${resourcePrefix}-invoke-rough-cut-agent`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/invoke-rough-cut-agent'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
    });

    // Grant invoke Lambda permissions
    invokeRoughCutAgent.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: [`arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/*`],
    }));
    invokeRoughCutAgent.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/fonn-custom-actions/agentcore/*`],
    }));
    invokeRoughCutAgent.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['states:SendTaskFailure'],
      resources: ['*'],
    }));

    // Grant story-context-handler permissions to read secrets
    sagaApiKeySecret.grantRead(storyContextHandler);
    sagaApiUrlSecret.grantRead(storyContextHandler);
    mimirApiKeySecret.grantRead(storyContextHandler);

    // Grant story-context-handler permissions to query S3 Vector Index
    storyContextHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3vectors:QueryVectors', 's3vectors:ListVectors', 's3vectors:GetVectors'],
      resources: ['*'],
    }));

    // (videoToS3Handler + transcribeHandler are declared earlier, before the
    // Summarizer state machine, so the transcribe-fallback branch can use them.)

    const classifyClipHandler = new lambda.Function(this, 'ClassifyClipHandler', {
      functionName: `${resourcePrefix}-classify-clip-handler`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/classify-clip-handler'),
      timeout: cdk.Duration.seconds(30),
      environment: {
        TRANSCRIPT_STAGING_BUCKET: videoStagingBucket.bucketName,
        MIMIR_API_KEY_SECRET_ARN: mimirApiKeySecret.secretArn,
      },
    });

    // Embedding Lambdas — declared before rough cut state machine so their ARNs are available
    const embeddingTriggerHandler = new lambda.Function(this, 'EmbeddingTriggerHandler', {
      functionName: `${resourcePrefix}-embedding-trigger-handler`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/embedding-trigger-handler'),
      timeout: cdk.Duration.seconds(30),
      environment: {
        VIDEO_STAGING_BUCKET: videoStagingBucket.bucketName,
      },
    });

    const embeddingStoreHandler = new lambda.Function(this, 'EmbeddingStoreHandler', {
      functionName: `${resourcePrefix}-embedding-store-handler`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/embedding-store-handler'),
      timeout: cdk.Duration.minutes(2),
      environment: {
        VECTOR_BUCKET_NAME: vectorBucket.vectorBucketName!,
        VECTOR_INDEX_NAME: 'video-embeddings-index',
      },
    });

    // RoughCutTimeline State Machine (JSONata, Standard, 35min timeout)
    // Uses lambda:invoke.waitForTaskToken to invoke AgentCore via a Lambda.
    // The agent calls SendTaskSuccess/SendTaskFailure when done.
    // Defined after videoToS3Handler and transcribeHandler so all Lambda ARNs are available.
    const roughCutDefinition = {
      "Comment": "Rough Cut Timeline generation pipeline",
      "QueryLanguage": "JSONata",
      "StartAt": "GatherStoryContext",
      "States": {
        "GatherStoryContext": {
          "Type": "Task",
          "Resource": "arn:aws:states:::lambda:invoke",
          "Arguments": {
            "FunctionName": storyContextHandler.functionArn,
            "Payload": "{% $states.input %}"
          },
          "Retry": [
            {
              "ErrorEquals": ["Lambda.ServiceException", "Lambda.AWSLambdaException"],
              "IntervalSeconds": 2,
              "MaxAttempts": 3,
              "BackoffRate": 2
            }
          ],
          "Assign": {
            "storyContext": "{% $states.result.Payload %}",
            "storyId": "{% $states.input.storyId %}",
            "story": "{% $states.input.story %}",
            "triggeredByUserId": "{% $states.input.triggeredByUserId %}",
            "mimirApiKey": "{% $states.input.mimirApiKey %}",
            "roughCutType": "{% $states.input.roughCutType ? $states.input.roughCutType : 'full' %}"
          },
          "Catch": [
            {
              "ErrorEquals": ["States.ALL"],
              "Next": "HandleFailure"
            }
          ],
          "Next": "NeedTranscription"
        },
        "NeedTranscription": {
          "Type": "Choice",
          "Choices": [
            {
              "Next": "TranscribeAssets",
              "Condition": "{% $count($storyContext.assets[itemType = 'video']) > 0 %}"
            }
          ],
          "Default": "NeedEmbeddings"
        },
        "TranscribeAssets": {
          "Type": "Map",
          "Items": "{% $storyContext.assets[itemType = 'video'] %}",
          "MaxConcurrency": 5,
          "ItemSelector": {
            "mimirItemId": "{% $states.context.Map.Item.Value.mimirItemId %}",
            "hasMimirTranscript": "{% $states.context.Map.Item.Value.hasTranscript %}"
          },
          "ItemProcessor": {
            "ProcessorConfig": {
              "Mode": "INLINE"
            },
            "StartAt": "CheckExistingTranscript",
            "States": {
              "CheckExistingTranscript": {
                "Type": "Task",
                "Resource": "arn:aws:states:::lambda:invoke",
                "Arguments": {
                  "FunctionName": transcribeHandler.functionArn,
                  "Payload": {
                    "action": "check-transcript",
                    "itemId": "{% $states.input.mimirItemId %}"
                  }
                },
                "Retry": [
                  {
                    "ErrorEquals": ["Lambda.ServiceException", "Lambda.AWSLambdaException"],
                    "IntervalSeconds": 2,
                    "MaxAttempts": 3,
                    "BackoffRate": 2
                  }
                ],
                "Assign": {
                  "mimirItemId": "{% $states.input.mimirItemId %}",
                  "hasMimirTranscript": "{% $states.input.hasMimirTranscript %}",
                  "transcriptExists": "{% $states.result.Payload.exists %}",
                  "transcriptS3Uri": "{% $states.result.Payload.transcriptS3Uri ? $states.result.Payload.transcriptS3Uri : '' %}"
                },
                "Next": "TranscriptExistsChoice"
              },
              "TranscriptExistsChoice": {
                "Type": "Choice",
                "Choices": [
                  {
                    "Next": "TranscribeComplete",
                    "Condition": "{% $transcriptExists = true %}"
                  }
                ],
                "Default": "MimirTranscriptChoice"
              },
              "MimirTranscriptChoice": {
                "Type": "Choice",
                "Choices": [
                  {
                    "Next": "ImportMimirTranscript",
                    "Condition": "{% $hasMimirTranscript = true %}",
                    "Comment": "Reuse Mimir's existing transcript instead of running AWS Transcribe"
                  }
                ],
                "Default": "CheckExistingVideo"
              },
              "ImportMimirTranscript": {
                "Type": "Task",
                "Resource": "arn:aws:states:::lambda:invoke",
                "Arguments": {
                  "FunctionName": transcribeHandler.functionArn,
                  "Payload": {
                    "action": "import-mimir-transcript",
                    "itemId": "{% $mimirItemId %}",
                    "mimirApiKey": "{% $mimirApiKey %}"
                  }
                },
                "Retry": [
                  {
                    "ErrorEquals": ["Lambda.ServiceException", "Lambda.AWSLambdaException"],
                    "IntervalSeconds": 2,
                    "MaxAttempts": 3,
                    "BackoffRate": 2
                  }
                ],
                "Assign": {
                  "importedTranscript": "{% $states.result.Payload.imported %}",
                  "transcriptS3Uri": "{% $states.result.Payload.transcriptS3Uri ? $states.result.Payload.transcriptS3Uri : '' %}"
                },
                "Next": "ImportedTranscriptChoice"
              },
              "ImportedTranscriptChoice": {
                "Type": "Choice",
                "Choices": [
                  {
                    "Next": "TranscribeComplete",
                    "Condition": "{% $importedTranscript = true %}"
                  }
                ],
                "Default": "CheckExistingVideo"
              },
              "CheckExistingVideo": {
                "Type": "Task",
                "Resource": "arn:aws:states:::lambda:invoke",
                "Arguments": {
                  "FunctionName": transcribeHandler.functionArn,
                  "Payload": {
                    "action": "check-video",
                    "itemId": "{% $mimirItemId %}"
                  }
                },
                "Retry": [
                  {
                    "ErrorEquals": ["Lambda.ServiceException", "Lambda.AWSLambdaException"],
                    "IntervalSeconds": 2,
                    "MaxAttempts": 3,
                    "BackoffRate": 2
                  }
                ],
                "Assign": {
                  "videoExists": "{% $states.result.Payload.exists %}",
                  "s3Uri": "{% $states.result.Payload.exists ? $states.result.Payload.s3Uri : '' %}"
                },
                "Next": "VideoExistsChoice"
              },
              "VideoExistsChoice": {
                "Type": "Choice",
                "Choices": [
                  {
                    "Next": "StartTranscribeJob",
                    "Condition": "{% $videoExists = true %}"
                  }
                ],
                "Default": "GetMimirDetailsForDownload"
              },
              "GetMimirDetailsForDownload": {
                "Type": "Task",
                "Resource": "arn:aws:states:::lambda:invoke",
                "Arguments": {
                  "FunctionName": mimirDetailsHandler.functionArn,
                  "Payload": {
                    "id": "{% $mimirItemId %}",
                    "itemType": "video"
                  }
                },
                "Retry": [
                  {
                    "ErrorEquals": ["Lambda.ServiceException", "Lambda.AWSLambdaException"],
                    "IntervalSeconds": 2,
                    "MaxAttempts": 3,
                    "BackoffRate": 2
                  }
                ],
                "Assign": {
                  "proxyUrl": "{% $states.result.Payload.proxyUrl %}"
                },
                "Next": "DownloadVideo"
              },
              "DownloadVideo": {
                "Type": "Task",
                "Resource": "arn:aws:states:::lambda:invoke",
                "Arguments": {
                  "FunctionName": videoToS3Handler.functionArn,
                  "Payload": {
                    "proxyUrl": "{% $proxyUrl %}",
                    "id": "{% $mimirItemId %}"
                  }
                },
                "Retry": [
                  {
                    "ErrorEquals": ["Lambda.ServiceException", "Lambda.AWSLambdaException"],
                    "IntervalSeconds": 2,
                    "MaxAttempts": 3,
                    "BackoffRate": 2
                  }
                ],
                "Assign": {
                  "s3Uri": "{% $states.result.Payload.s3Uri %}"
                },
                "Next": "StartTranscribeJob"
              },
              "StartTranscribeJob": {
                "Type": "Task",
                "Resource": "arn:aws:states:::lambda:invoke",
                "Arguments": {
                  "FunctionName": transcribeHandler.functionArn,
                  "Payload": {
                    "action": "start-transcribe",
                    "itemId": "{% $mimirItemId %}",
                    "s3Uri": "{% $s3Uri %}"
                  }
                },
                "Retry": [
                  {
                    "ErrorEquals": ["Lambda.ServiceException", "Lambda.AWSLambdaException"],
                    "IntervalSeconds": 2,
                    "MaxAttempts": 3,
                    "BackoffRate": 2
                  }
                ],
                "Assign": {
                  "jobName": "{% $states.result.Payload.jobName %}"
                },
                "Next": "WaitForTranscribe"
              },
              "WaitForTranscribe": {
                "Type": "Wait",
                "Seconds": 15,
                "Next": "PollTranscribeStatus"
              },
              "PollTranscribeStatus": {
                "Type": "Task",
                "Resource": "arn:aws:states:::lambda:invoke",
                "Arguments": {
                  "FunctionName": transcribeHandler.functionArn,
                  "Payload": {
                    "action": "poll-transcribe",
                    "itemId": "{% $mimirItemId %}",
                    "jobName": "{% $jobName %}"
                  }
                },
                "Retry": [
                  {
                    "ErrorEquals": ["Lambda.ServiceException", "Lambda.AWSLambdaException"],
                    "IntervalSeconds": 2,
                    "MaxAttempts": 3,
                    "BackoffRate": 2
                  }
                ],
                "Assign": {
                  "transcribeStatus": "{% $states.result.Payload.status %}",
                  "transcriptS3Uri": "{% $states.result.Payload.transcriptS3Uri ? $states.result.Payload.transcriptS3Uri : '' %}",
                  "transcribeError": "{% $states.result.Payload.error ? $states.result.Payload.error : '' %}"
                },
                "Next": "TranscribeStatusChoice"
              },
              "TranscribeStatusChoice": {
                "Type": "Choice",
                "Choices": [
                  {
                    "Next": "WaitForTranscribe",
                    "Condition": "{% $transcribeStatus = 'IN_PROGRESS' %}"
                  },
                  {
                    "Next": "TranscribeComplete",
                    "Condition": "{% $transcribeStatus = 'COMPLETED' %}"
                  }
                ],
                "Default": "SkipFailedAsset"
              },
              "TranscribeComplete": {
                "Type": "Pass",
                "Output": {
                  "mimirItemId": "{% $mimirItemId %}",
                  "status": "completed",
                  "transcriptS3Uri": "{% $transcriptS3Uri %}"
                },
                "End": true
              },
              "SkipFailedAsset": {
                "Type": "Pass",
                "Output": {
                  "mimirItemId": "{% $mimirItemId %}",
                  "status": "failed",
                  "error": "{% $transcribeError %}"
                },
                "End": true
              }
            }
          },
          "Assign": {
            "transcribeResults": "{% $states.result %}"
          },
          "Catch": [
            {
              "ErrorEquals": ["States.ALL"],
              "Next": "InvokeRoughCutAgent"
            }
          ],
          "Next": "MergeTranscriptResults"
        },
        "MergeTranscriptResults": {
          "Type": "Pass",
          "Next": "ClassifyAssets"
        },
        "ClassifyAssets": {
          "Type": "Map",
          "Items": "{% $storyContext.assets[itemType = 'video'] %}",
          "MaxConcurrency": 5,
          "ItemSelector": {
            "mimirItemId": "{% $states.context.Map.Item.Value.mimirItemId %}"
          },
          "ItemProcessor": {
            "ProcessorConfig": {
              "Mode": "INLINE"
            },
            "StartAt": "ClassifyClip",
            "States": {
              "ClassifyClip": {
                "Type": "Task",
                "Resource": "arn:aws:states:::lambda:invoke",
                "Arguments": {
                  "FunctionName": classifyClipHandler.functionArn,
                  "Payload": {
                    "itemId": "{% $states.input.mimirItemId %}"
                  }
                },
                "Retry": [
                  {
                    "ErrorEquals": ["Lambda.ServiceException", "Lambda.AWSLambdaException"],
                    "IntervalSeconds": 2,
                    "MaxAttempts": 3,
                    "BackoffRate": 2
                  }
                ],
                "Output": "{% $states.result.Payload %}",
                "End": true
              }
            }
          },
          "Catch": [
            {
              "ErrorEquals": ["States.ALL"],
              "Next": "InvokeRoughCutAgent"
            }
          ],
          "Next": "NeedEmbeddings"
        },
        "NeedEmbeddings": {
          "Type": "Choice",
          "Choices": [
            {
              "Next": "EnsureEmbeddings",
              "Condition": "{% $count($storyContext.assets[hasEmbeddings != true and itemType = 'video']) > 0 %}"
            }
          ],
          "Default": "InvokeRoughCutAgent"
        },
        "EnsureEmbeddings": {
          "Type": "Map",
          "Items": "{% $storyContext.assets[hasEmbeddings != true and itemType = 'video'] %}",
          "MaxConcurrency": 3,
          "ItemSelector": {
            "mimirItemId": "{% $states.context.Map.Item.Value.mimirItemId %}",
            "title": "{% $states.context.Map.Item.Value.title ? $states.context.Map.Item.Value.title : '' %}"
          },
          "ItemProcessor": {
            "ProcessorConfig": {
              "Mode": "INLINE"
            },
            "StartAt": "CheckVideoInStaging",
            "States": {
              "CheckVideoInStaging": {
                "Type": "Task",
                "Resource": "arn:aws:states:::lambda:invoke",
                "Arguments": {
                  "FunctionName": mimirDetailsHandler.functionArn,
                  "Payload": {
                    "id": "{% $states.input.mimirItemId %}",
                    "itemType": "video"
                  }
                },
                "Retry": [
                  {
                    "ErrorEquals": ["Lambda.ServiceException", "Lambda.AWSLambdaException"],
                    "IntervalSeconds": 2,
                    "MaxAttempts": 3,
                    "BackoffRate": 2
                  }
                ],
                "Assign": {
                  "mimirItemId": "{% $states.input.mimirItemId %}",
                  "title": "{% $states.input.title %}",
                  "proxyUrl": "{% $states.result.Payload.proxyUrl ? $states.result.Payload.proxyUrl : ($states.result.Payload.highRes ? $states.result.Payload.highRes : '') %}",
                  "sourceS3Uri": "{% $states.result.Payload.ingestSourceS3Bucket ? 's3://' & $states.result.Payload.ingestSourceS3Bucket & '/' & $states.result.Payload.ingestSourceFullPath : '' %}"
                },
                "Next": "HasSourceS3Uri"
              },
              "HasSourceS3Uri": {
                "Type": "Choice",
                "Choices": [
                  {
                    "Next": "CheckSourceAccess",
                    "Condition": "{% $sourceS3Uri != '' %}"
                  }
                ],
                "Default": "CheckStagedVideo"
              },
              "CheckSourceAccess": {
                "Type": "Task",
                "Resource": "arn:aws:states:::lambda:invoke",
                "Arguments": {
                  "FunctionName": embeddingTriggerHandler.functionArn,
                  "Payload": {
                    "action": "check-access",
                    "s3Uri": "{% $sourceS3Uri %}"
                  }
                },
                "Retry": [
                  {
                    "ErrorEquals": ["Lambda.ServiceException", "Lambda.AWSLambdaException"],
                    "IntervalSeconds": 2,
                    "MaxAttempts": 3,
                    "BackoffRate": 2
                  }
                ],
                "Assign": {
                  "sourceAccessible": "{% $states.result.Payload.accessible %}"
                },
                "Next": "SourceAccessChoice"
              },
              "SourceAccessChoice": {
                "Type": "Choice",
                "Choices": [
                  {
                    "Next": "StartEmbedding",
                    "Condition": "{% $sourceAccessible = true %}",
                    "Comment": "Direct access to customer S3 — skip download"
                  }
                ],
                "Default": "CheckStagedVideo"
              },
              "CheckStagedVideo": {
                "Type": "Task",
                "Resource": "arn:aws:states:::lambda:invoke",
                "Arguments": {
                  "FunctionName": transcribeHandler.functionArn,
                  "Payload": {
                    "action": "check-video",
                    "itemId": "{% $mimirItemId %}"
                  }
                },
                "Retry": [
                  {
                    "ErrorEquals": ["Lambda.ServiceException", "Lambda.AWSLambdaException"],
                    "IntervalSeconds": 2,
                    "MaxAttempts": 3,
                    "BackoffRate": 2
                  }
                ],
                "Assign": {
                  "videoExists": "{% $states.result.Payload.exists %}",
                  "sourceS3Uri": "{% $states.result.Payload.exists ? $states.result.Payload.s3Uri : $sourceS3Uri %}"
                },
                "Next": "EmbedVideoExistsChoice"
              },
              "EmbedVideoExistsChoice": {
                "Type": "Choice",
                "Choices": [
                  {
                    "Next": "StartEmbedding",
                    "Condition": "{% $videoExists = true %}"
                  }
                ],
                "Default": "DownloadVideoForEmbed"
              },
              "DownloadVideoForEmbed": {
                "Type": "Task",
                "Resource": "arn:aws:states:::lambda:invoke",
                "Arguments": {
                  "FunctionName": videoToS3Handler.functionArn,
                  "Payload": {
                    "proxyUrl": "{% $proxyUrl %}",
                    "id": "{% $mimirItemId %}"
                  }
                },
                "Retry": [
                  {
                    "ErrorEquals": ["Lambda.ServiceException", "Lambda.AWSLambdaException"],
                    "IntervalSeconds": 2,
                    "MaxAttempts": 3,
                    "BackoffRate": 2
                  }
                ],
                "Assign": {
                  "sourceS3Uri": "{% $states.result.Payload.s3Uri %}"
                },
                "Next": "StartEmbedding"
              },
              "StartEmbedding": {
                "Type": "Task",
                "Resource": "arn:aws:states:::lambda:invoke",
                "Arguments": {
                  "FunctionName": embeddingTriggerHandler.functionArn,
                  "Payload": {
                    "action": "start",
                    "s3Uri": "{% $sourceS3Uri %}",
                    "itemId": "{% $mimirItemId %}"
                  }
                },
                "Retry": [
                  {
                    "ErrorEquals": ["Lambda.ServiceException", "Lambda.AWSLambdaException"],
                    "IntervalSeconds": 2,
                    "MaxAttempts": 3,
                    "BackoffRate": 2
                  }
                ],
                "Assign": {
                  "invocationArn": "{% $states.result.Payload.invocationArn %}"
                },
                "Next": "WaitForEmbedGen"
              },
              "WaitForEmbedGen": {
                "Type": "Wait",
                "Seconds": 30,
                "Next": "PollEmbeddingStatus"
              },
              "PollEmbeddingStatus": {
                "Type": "Task",
                "Resource": "arn:aws:states:::lambda:invoke",
                "Arguments": {
                  "FunctionName": embeddingTriggerHandler.functionArn,
                  "Payload": {
                    "action": "poll",
                    "invocationArn": "{% $invocationArn %}"
                  }
                },
                "Retry": [
                  {
                    "ErrorEquals": ["Lambda.ServiceException", "Lambda.AWSLambdaException"],
                    "IntervalSeconds": 2,
                    "MaxAttempts": 3,
                    "BackoffRate": 2
                  }
                ],
                "Assign": {
                  "embedStatus": "{% $states.result.Payload.status %}",
                  "outputS3Uri": "{% $states.result.Payload.outputS3Uri ? $states.result.Payload.outputS3Uri : '' %}"
                },
                "Next": "EmbedStatusChoice"
              },
              "EmbedStatusChoice": {
                "Type": "Choice",
                "Choices": [
                  {
                    "Next": "StoreNewEmbeddings",
                    "Condition": "{% $embedStatus = 'Completed' %}"
                  },
                  {
                    "Next": "EmbedFailed",
                    "Condition": "{% $embedStatus = 'Failed' %}"
                  }
                ],
                "Default": "WaitForEmbedGen"
              },
              "StoreNewEmbeddings": {
                "Type": "Task",
                "Resource": "arn:aws:states:::lambda:invoke",
                "Arguments": {
                  "FunctionName": embeddingStoreHandler.functionArn,
                  "Payload": {
                    "outputS3Uri": "{% $outputS3Uri %}",
                    "itemId": "{% $mimirItemId %}",
                    "title": "{% $title %}"
                  }
                },
                "Retry": [
                  {
                    "ErrorEquals": ["Lambda.ServiceException", "Lambda.AWSLambdaException"],
                    "IntervalSeconds": 2,
                    "MaxAttempts": 3,
                    "BackoffRate": 2
                  }
                ],
                "Output": {
                  "mimirItemId": "{% $mimirItemId %}",
                  "status": "completed",
                  "vectorsStored": "{% $states.result.Payload.vectorsStored %}"
                },
                "End": true
              },
              "EmbedFailed": {
                "Type": "Pass",
                "Output": {
                  "mimirItemId": "{% $mimirItemId %}",
                  "status": "failed"
                },
                "End": true
              }
            }
          },
          "Assign": {
            "embeddingResults": "{% $states.result %}"
          },
          "Catch": [
            {
              "ErrorEquals": ["States.ALL"],
              "Next": "InvokeRoughCutAgent"
            }
          ],
          "Next": "InvokeRoughCutAgent"
        },
        "InvokeRoughCutAgent": {
          "Type": "Task",
          "Resource": "arn:aws:states:::lambda:invoke.waitForTaskToken",
          "Arguments": {
            "FunctionName": invokeRoughCutAgent.functionArn,
            "Payload": {
              "TaskToken": "{% $states.context.Task.Token %}",
              "storyContext": "{% $merge([$storyContext, {'assets': $storyContext.assets ~> $map(function($a) { ($m := $transcribeResults[mimirItemId = $a.mimirItemId and status = 'completed']; $m ? $merge([$a, {'generatedTranscriptS3Uri': $m.transcriptS3Uri}]) : $a) })}]) %}",
              "storyId": "{% $storyId %}",
              "story": "{% $story %}",
              "triggeredByUserId": "{% $triggeredByUserId %}",
              "mimirApiKey": "{% $mimirApiKey %}",
              "roughCutType": "{% $roughCutType %}"
            }
          },
          "TimeoutSeconds": 1800,
          "Catch": [
            {
              "ErrorEquals": ["States.ALL"],
              "Next": "HandleFailure"
            }
          ],
          "Next": "HandleSuccess"
        },
        "HandleSuccess": {
          "Type": "Succeed"
        },
        "HandleFailure": {
          "Type": "Fail",
          "Error": "RoughCutPipelineError",
          "Cause": "Rough cut timeline generation failed"
        }
      }
    };

    const roughCutStateMachine = new stepfunctions.StateMachine(this, 'RoughCutTimelineStateMachine', {
      stateMachineName: `${resourcePrefix}-rough-cut-timeline`,
      definitionBody: stepfunctions.DefinitionBody.fromString(JSON.stringify(roughCutDefinition)),
      stateMachineType: stepfunctions.StateMachineType.STANDARD,
      timeout: cdk.Duration.minutes(60),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'RoughCutStateMachineLogs', { retention: logs.RetentionDays.ONE_MONTH }),
        level: stepfunctions.LogLevel.ALL
      }
    });

    // Grant state machine permission to invoke story-context-handler
    storyContextHandler.grantInvoke(roughCutStateMachine);

    // Grant state machine permission to invoke the AgentCore invoker Lambda
    invokeRoughCutAgent.grantInvoke(roughCutStateMachine);

    // Grant state machine permission to invoke video-to-s3-handler (for TranscribeAssets Map)
    videoToS3Handler.grantInvoke(roughCutStateMachine);

    // Grant state machine permission to invoke transcribe-handler (for TranscribeAssets Map)
    transcribeHandler.grantInvoke(roughCutStateMachine);

    // Grant state machine permission to invoke mimir-details-handler (for GetMimirDetailsForDownload in TranscribeAssets Map)
    mimirDetailsHandler.grantInvoke(roughCutStateMachine);

    // Grant state machine permission to invoke embedding handlers (for EnsureEmbeddings Map)
    embeddingTriggerHandler.grantInvoke(roughCutStateMachine);
    embeddingStoreHandler.grantInvoke(roughCutStateMachine);

    // Wire rough cut state machine to saga-action-handler
    sagaActionHandler.addEnvironment('ROUGH_CUT_STATE_MACHINE_ARN', roughCutStateMachine.stateMachineArn);
    roughCutStateMachine.grantStartExecution(sagaActionHandler);

    // ---------------------------------------------------------------------------
    // Story Research — generates VO script, package script, key facts, etc.
    // from story transcripts using Bedrock, writes back to Saga Research instance
    // ---------------------------------------------------------------------------
    const storyResearchHandler = new lambda.Function(this, 'StoryResearchHandler', {
      functionName: `${resourcePrefix}-story-research-handler`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/story-research-handler'),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        MIMIR_API_KEY_SECRET_ARN: mimirApiKeySecret.secretArn,
        SAGA_API_KEY_SECRET_ARN: sagaApiKeySecret.secretArn,
        SAGA_API_URL_SECRET_ARN: sagaApiUrlSecret.secretArn,
        TRANSCRIPT_STAGING_BUCKET: videoStagingBucket.bucketName,
        BEDROCK_MODEL_ID: 'us.amazon.nova-pro-v1:0',
        BEDROCK_REGION: this.region,
      },
    });

    // Permissions for story-research-handler
    mimirApiKeySecret.grantRead(storyResearchHandler);
    sagaApiKeySecret.grantRead(storyResearchHandler);
    sagaApiUrlSecret.grantRead(storyResearchHandler);
    videoStagingBucket.grantRead(storyResearchHandler);
    storyResearchHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel', 'bedrock:Converse'],
      resources: ['*'],
    }));

    // Story Research state machine — defined in state-machines/story-research.asl.json
    const storyResearchDefinition = {
      Comment: 'Story Research pipeline — gathers story context, generates research items via Bedrock, writes back to Saga',
      QueryLanguage: 'JSONata',
      StartAt: 'GatherStoryContext',
      States: {
        GatherStoryContext: {
          Type: 'Task',
          Resource: 'arn:aws:states:::lambda:invoke',
          Arguments: {
            'FunctionName': storyContextHandler.functionArn,
            'Payload': '{% $states.input %}',
          },
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.AWSLambdaException'], IntervalSeconds: 2, MaxAttempts: 3, BackoffRate: 2 }],
          Assign: {
            'storyContext': '{% $states.result.Payload %}',
            'storyId': '{% $states.input.storyId %}',
            'customPrompts': '{% $states.input.customPrompts ? $states.input.customPrompts : [] %}',
          },
          Catch: [{ ErrorEquals: ['States.ALL'], Next: 'HandleFailure', Assign: { errorMessage: '{% $states.errorOutput.Cause %}' } }],
          Next: 'GenerateResearch',
        },
        GenerateResearch: {
          Type: 'Task',
          Resource: 'arn:aws:states:::lambda:invoke',
          Arguments: {
            'FunctionName': storyResearchHandler.functionArn,
            'Payload': {
              'storyId': '{% $storyId %}',
              'storyContext': '{% $storyContext %}',
              'customPrompts': '{% $customPrompts %}',
            },
          },
          TimeoutSeconds: 300,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.AWSLambdaException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2 }],
          Catch: [{ ErrorEquals: ['States.ALL'], Next: 'HandleFailure', Assign: { errorMessage: '{% $states.errorOutput.Cause %}' } }],
          Next: 'HandleSuccess',
        },
        HandleSuccess: { Type: 'Succeed' },
        HandleFailure: {
          Type: 'Fail',
          Error: 'StoryResearchError',
          Cause: '{% $errorMessage ? $errorMessage : \'Story research generation failed\' %}',
        },
      },
    };

    const storyResearchStateMachine = new stepfunctions.StateMachine(this, 'StoryResearchStateMachine', {
      stateMachineName: `${resourcePrefix}-story-research`,
      definitionBody: stepfunctions.DefinitionBody.fromString(JSON.stringify(storyResearchDefinition)),
      stateMachineType: stepfunctions.StateMachineType.STANDARD,
      timeout: cdk.Duration.minutes(15),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'StoryResearchStateMachineLogs', { retention: logs.RetentionDays.ONE_MONTH }),
        level: stepfunctions.LogLevel.ALL,
      },
    });

    storyContextHandler.grantInvoke(storyResearchStateMachine);
    storyResearchHandler.grantInvoke(storyResearchStateMachine);

    // Add story-research API endpoint and wire to saga-action-handler
    const storyResearchResource = actionsResource.addResource('story-research');
    storyResearchResource.addMethod('POST', new apigateway.LambdaIntegration(sagaActionHandler));
    sagaActionHandler.addEnvironment('STORY_RESEARCH_STATE_MACHINE_ARN', storyResearchStateMachine.stateMachineArn);
    storyResearchStateMachine.grantStartExecution(sagaActionHandler);

    new cdk.CfnOutput(this, 'StoryResearchEndpoint', {
      value: `${api.url}actions/story-research`,
      description: 'Story Research custom action endpoint',
    });
    new cdk.CfnOutput(this, 'StoryResearchStateMachineArn', {
      value: storyResearchStateMachine.stateMachineArn,
      description: 'ARN of the Story Research state machine',
    });

    // Step Functions role
    const stepFunctionsRole = new iam.Role(this, 'WebhookStepFunctionsRole', {
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaRole')
      ]
    });

    sagaFeedItemsTable.grantReadData(stepFunctionsRole);
    itemCreateHandler.grantInvoke(stepFunctionsRole);

    // Step 1: Extract filename from S3 URL using JSONata
    const extractFilenameAndCheck = stepfunctions.Pass.jsonata(this, 'ExtractFilenameFromUrl', {
      outputs: {
        'titleExtraction': {
          'originalTitle': '{% $states.input.item.metadata.formData.title %}',
          'extractedTitle': '{% $match($states.input.item.metadata.formData.title, /filename%3D([^&]+)\\.mp4/).groups[0] %}'
        },
        'item': '{% $states.input.item %}'
      }
    });

    const checkSagaFeedItem = new stepfunctionsTasks.DynamoGetItem(this, 'CheckSagaFeedItem', {
      table: sagaFeedItemsTable,
      key: {
        title: stepfunctionsTasks.DynamoAttributeValue.fromString(
          stepfunctions.JsonPath.stringAt('$.titleExtraction.extractedTitle')
        )
      },
      resultPath: '$.sagaLookup'
    });

    // Step 2: Skip processing for non-Saga feed items
    const skipProcessing = stepfunctions.Pass.jsonata(this, 'SkipProcessing', {
      outputs: {
        'message': 'Not a Saga feed item, skipped',
        'processed': false
      }
    });

    // Step 3: Process Saga feed item with Lambda
    const processFeedItem = new stepfunctionsTasks.LambdaInvoke(this, 'ProcessSagaFeedItem', {
      lambdaFunction: itemCreateHandler,
      payload: stepfunctions.TaskInput.fromJsonPathAt('$')
    });

    // Webhook workflow definition
    const webhookDefinition = extractFilenameAndCheck
      .next(checkSagaFeedItem)
      .next(new stepfunctions.Choice(this, 'IsSagaFeedItem')
        .when(stepfunctions.Condition.isPresent('$.sagaLookup.Item'), processFeedItem)
        .otherwise(skipProcessing)
      );

    // Express State Machine
    const logGroup = new logs.LogGroup(this, 'SagaFeedsWebhookLogGroup');
    
    const sagaFeedsWebhookProcessor = new stepfunctions.StateMachine(this, 'SagaFeedsWebhookProcessor', {
      stateMachineName: `${resourcePrefix}-saga-feeds-webhook`,
      definitionBody: stepfunctions.DefinitionBody.fromChainable(webhookDefinition),
      stateMachineType: stepfunctions.StateMachineType.EXPRESS,
      timeout: cdk.Duration.seconds(30),
      logs: {
        destination: logGroup,
        level: stepfunctions.LogLevel.ALL,
        includeExecutionData: true
      },
      tracingEnabled: true
    });

    // FFmpeg Lambda layer — provides /opt/bin/ffmpeg and /opt/bin/ffprobe
    // Binaries are in layers/ffmpeg/bin/ (gitignored, download separately).
    // Used by the stability-analysis handler (below) and the reframe-custom
    // CMAF/keyframe/tile handlers (later in this stack).
    const ffmpegLayer = new lambda.LayerVersion(this, 'FfmpegLayer', {
      layerVersionName: 'ffmpeg-static',
      code: lambda.Code.fromAsset('layers/ffmpeg'),
      compatibleRuntimes: [lambda.Runtime.NODEJS_24_X],
      description: 'Static FFmpeg build for CMAF conversion and keyframe extraction',
    });

    // Camera-stability analysis — scores per-second global motion (FFmpeg
    // vidstabdetect) and writes a usable/unusable segment map to
    // stability/{itemId}/segments.json. The rough cut agent uses it to avoid
    // B-roll moments where the operator is hunting for or reframing a shot.
    const stabilityAnalysisHandler = new lambda.Function(this, 'StabilityAnalysisHandler', {
      functionName: `${resourcePrefix}-stability-analysis-handler`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/stability-analysis-handler'),
      timeout: cdk.Duration.minutes(15),
      memorySize: 3008,
      ephemeralStorageSize: cdk.Size.mebibytes(2048),
      layers: [ffmpegLayer],
      environment: {
        VIDEO_STAGING_BUCKET: videoStagingBucket.bucketName,
        // Durable store for the stability maps this handler writes.
        STABILITY_BUCKET: mediaAnalysisBucket.bucketName,
        FFMPEG_PATH: '/opt/bin/ffmpeg',
        FFPROBE_PATH: '/opt/bin/ffprobe',
      },
    });
    videoStagingBucket.grantReadWrite(stabilityAnalysisHandler);
    mediaAnalysisBucket.grantReadWrite(stabilityAnalysisHandler);
    // Read access to arbitrary customer ingest buckets (named at runtime via
    // Mimir's ingestSourceS3Bucket) — used to analyze the source object directly
    // when deployed in the customer's account, instead of the pre-signed proxy.
    stabilityAnalysisHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject'],
      resources: ['arn:aws:s3:::*/*'],
    }));

    // Embedding State Machine
    const embeddingFailed = new stepfunctions.Fail(this, 'EmbeddingFailed', {
      cause: 'Embedding pipeline failed',
      error: 'EmbeddingPipelineError',
    });

    const getMimirDetailsEmbed = new stepfunctionsTasks.LambdaInvoke(this, 'GetMimirDetailsEmbed', {
      lambdaFunction: mimirDetailsHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'id.$': '$.item.id',
        'itemType.$': '$.item.itemType',
        'metadata.$': '$.item.metadata',
      }),
      outputPath: '$.Payload',
    });
    getMimirDetailsEmbed.addRetry({
      errors: ['Lambda.ServiceException', 'Lambda.AWSLambdaException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 3,
      backoffRate: 2,
    });
    getMimirDetailsEmbed.addCatch(embeddingFailed, { resultPath: '$.error' });

    const stageVideoToS3 = new stepfunctionsTasks.LambdaInvoke(this, 'StageVideoToS3', {
      lambdaFunction: videoToS3Handler,
      resultPath: '$.stageResult',
    });
    stageVideoToS3.addRetry({
      errors: ['Lambda.ServiceException', 'Lambda.AWSLambdaException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 3,
      backoffRate: 2,
    });
    stageVideoToS3.addCatch(embeddingFailed, { resultPath: '$.error' });

    // Camera-stability analysis on the staged video. Failures are non-fatal:
    // the catch routes straight to TriggerEmbedding so a stability hiccup never
    // blocks the embedding pipeline (the rough cut agent treats a missing
    // stability file as "no stability data").
    const analyzeStability = new stepfunctionsTasks.LambdaInvoke(this, 'AnalyzeStability', {
      lambdaFunction: stabilityAnalysisHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'action': 'analyze',
        'itemId.$': '$.id',
        's3Uri.$': '$.stageResult.Payload.s3Uri',
        'ingestSourceS3Bucket.$': '$.ingestSourceS3Bucket',
        'ingestSourceFullPath.$': '$.ingestSourceFullPath',
        'proxyUrl.$': '$.proxyUrl',
      }),
      resultPath: '$.stabilityResult',
    });
    analyzeStability.addRetry({
      errors: ['Lambda.ServiceException', 'Lambda.AWSLambdaException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 2,
      backoffRate: 2,
    });

    const triggerEmbedding = new stepfunctionsTasks.LambdaInvoke(this, 'TriggerEmbedding', {
      lambdaFunction: embeddingTriggerHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'action': 'start',
        's3Uri.$': '$.stageResult.Payload.s3Uri',
        'itemId.$': '$.id',
      }),
      resultPath: '$.triggerResult',
    });
    triggerEmbedding.addRetry({
      errors: ['Lambda.ServiceException', 'Lambda.AWSLambdaException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 3,
      backoffRate: 2,
    });
    triggerEmbedding.addCatch(embeddingFailed, { resultPath: '$.error' });

    const waitForEmbedding = new stepfunctions.Wait(this, 'WaitForEmbedding', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const checkEmbeddingStatus = new stepfunctionsTasks.LambdaInvoke(this, 'CheckEmbeddingStatus', {
      lambdaFunction: embeddingTriggerHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'action': 'poll',
        'invocationArn.$': '$.triggerResult.Payload.invocationArn',
      }),
      resultPath: '$.pollResult',
    });
    checkEmbeddingStatus.addRetry({
      errors: ['Lambda.ServiceException', 'Lambda.AWSLambdaException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 3,
      backoffRate: 2,
    });
    checkEmbeddingStatus.addCatch(embeddingFailed, { resultPath: '$.error' });

    const storeEmbeddings = new stepfunctionsTasks.LambdaInvoke(this, 'StoreEmbeddings', {
      lambdaFunction: embeddingStoreHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'outputS3Uri.$': '$.pollResult.Payload.outputS3Uri',
        'itemId.$': '$.id',
        'title.$': '$.mimirDetails.title',
      }),
      outputPath: '$.Payload',
    });
    storeEmbeddings.addRetry({
      errors: ['Lambda.ServiceException', 'Lambda.AWSLambdaException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 3,
      backoffRate: 2,
    });
    storeEmbeddings.addCatch(embeddingFailed, { resultPath: '$.error' });

    const embeddingStatusChoice = new stepfunctions.Choice(this, 'EmbeddingStatusChoice')
      .when(stepfunctions.Condition.stringEquals('$.pollResult.Payload.status', 'Completed'), storeEmbeddings)
      .when(stepfunctions.Condition.stringEquals('$.pollResult.Payload.status', 'Failed'), embeddingFailed)
      .otherwise(waitForEmbedding);

    // Polling loop: wait for Mimir to finish processing (itemState === "complete")
    const waitForMimirProcessing = new stepfunctions.Wait(this, 'WaitForMimirProcessing', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const recheckMimirDetails = new stepfunctionsTasks.LambdaInvoke(this, 'RecheckMimirDetails', {
      lambdaFunction: mimirDetailsHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'id.$': '$.id',
        'itemType.$': '$.itemType',
        'metadata.$': '$.metadata',
      }),
      outputPath: '$.Payload',
    });
    recheckMimirDetails.addRetry({
      errors: ['Lambda.ServiceException', 'Lambda.AWSLambdaException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 3,
      backoffRate: 2,
    });
    recheckMimirDetails.addCatch(embeddingFailed, { resultPath: '$.error' });

    const checkItemReady = new stepfunctions.Choice(this, 'CheckItemReady')
      .when(stepfunctions.Condition.stringEquals('$.mimirDetails.itemState', 'complete'), stageVideoToS3)
      .otherwise(waitForMimirProcessing);

    // Wire the embedding polling loop
    const markEmbeddingsComplete = new stepfunctionsTasks.LambdaInvoke(this, 'MarkEmbeddingsComplete', {
      lambdaFunction: mimirUpdateHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'itemId.$': '$.itemId',
        'formData': {
          'isIndexedInSemanticSearch': true,
        },
      }),
      outputPath: '$.Payload',
    });
    markEmbeddingsComplete.addRetry({
      errors: ['Lambda.ServiceException', 'Lambda.AWSLambdaException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 3,
      backoffRate: 2,
    });
    markEmbeddingsComplete.addCatch(embeddingFailed, { resultPath: '$.error' });

    storeEmbeddings.next(markEmbeddingsComplete);
    stageVideoToS3.next(analyzeStability);
    // Stability analysis is best-effort: on any error, continue to embedding.
    analyzeStability.addCatch(triggerEmbedding, { resultPath: '$.stabilityError' });
    analyzeStability.next(triggerEmbedding);
    triggerEmbedding.next(waitForEmbedding);
    waitForEmbedding.next(checkEmbeddingStatus);
    checkEmbeddingStatus.next(embeddingStatusChoice);
    waitForMimirProcessing.next(recheckMimirDetails).next(checkItemReady);

    const checkItemReadyInitial = new stepfunctions.Choice(this, 'CheckItemReadyInitial')
      .when(stepfunctions.Condition.stringEquals('$.mimirDetails.itemState', 'complete'), stageVideoToS3)
      .otherwise(waitForMimirProcessing);

    // Skip non-video items (audio, image, file) — they can't be embedded
    const embeddingSkipped = new stepfunctions.Succeed(this, 'EmbeddingSkippedNonVideo', {
      comment: 'Item is not a video — skipping embedding',
    });

    const checkItemTypeForEmbedding = new stepfunctions.Choice(this, 'CheckItemTypeForEmbedding')
      .when(stepfunctions.Condition.stringEquals('$.itemType', 'video'), checkItemReadyInitial)
      .otherwise(embeddingSkipped);

    const embeddingDefinition = getMimirDetailsEmbed
      .next(checkItemTypeForEmbedding);

    const embeddingStateMachine = new stepfunctions.StateMachine(this, 'EmbedVideoContentStateMachine', {
      stateMachineName: `${resourcePrefix}-embed-video-content`,
      definitionBody: stepfunctions.DefinitionBody.fromChainable(embeddingDefinition),
      stateMachineType: stepfunctions.StateMachineType.STANDARD,
      timeout: cdk.Duration.hours(2),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'EmbeddingStateMachineLogs', { retention: logs.RetentionDays.ONE_MONTH }),
        level: stepfunctions.LogLevel.ALL
      }
    });

    // API Gateway role for Step Functions
    const apiGatewayStepFunctionsRole = new iam.Role(this, 'ApiGatewayStepFunctionsRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      inlinePolicies: {
        StepFunctionsAccess: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            actions: ['states:StartSyncExecution'],
            resources: [sagaFeedsWebhookProcessor.stateMachineArn]
          })]
        })
      }
    });

    // Step Functions integration
    const stepFunctionsIntegration = new apigateway.AwsIntegration({
      service: 'states',
      action: 'StartSyncExecution',
      options: {
        credentialsRole: apiGatewayStepFunctionsRole,
        requestTemplates: {
          'application/json': JSON.stringify({
            stateMachineArn: sagaFeedsWebhookProcessor.stateMachineArn,
            input: "$util.escapeJavaScript($input.json('$'))"
          })
        },
        integrationResponses: [{
          statusCode: '200',
          responseTemplates: {
            'application/json': '$input.path("$.output")'
          }
        }]
      }
    });

    // API Gateway role for Embedding State Machine (async StartExecution)
    const embeddingApiGatewayRole = new iam.Role(this, 'EmbeddingApiGatewayRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      inlinePolicies: {
        StepFunctionsAccess: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            actions: ['states:StartExecution'],
            resources: [embeddingStateMachine.stateMachineArn]
          })]
        })
      }
    });

    // Embedding Step Functions integration (async)
    const embeddingIntegration = new apigateway.AwsIntegration({
      service: 'states',
      action: 'StartExecution',
      options: {
        credentialsRole: embeddingApiGatewayRole,
        requestTemplates: {
          'application/json': JSON.stringify({
            stateMachineArn: embeddingStateMachine.stateMachineArn,
            input: "$util.escapeJavaScript($input.json('$'))"
          })
        },
        integrationResponses: [{
          statusCode: '200',
          responseTemplates: {
            'application/json': '{"executionArn": $input.json("$.executionArn"), "startDate": $input.json("$.startDate")}'
          }
        }]
      }
    });

    // Webhook endpoints
    const webhookResource = webhookApi.root.addResource('webhook');
    const itemChangeResource = webhookResource.addResource('item-change');
    const itemCreateResource = webhookResource.addResource('item-create');
    
    itemChangeResource.addMethod('POST', new apigateway.LambdaIntegration(itemChangeHandler));
    itemCreateResource.addMethod('POST', stepFunctionsIntegration, {
      methodResponses: [{
        statusCode: '200',
        responseModels: {
          'application/json': apigateway.Model.EMPTY_MODEL
        }
      }]
    });

    // Embedding webhook endpoint (async)
    const itemEmbedResource = webhookResource.addResource('item-embed');
    itemEmbedResource.addMethod('POST', embeddingIntegration, {
      methodResponses: [{
        statusCode: '200',
        responseModels: {
          'application/json': apigateway.Model.EMPTY_MODEL
        }
      }]
    });

    // Video Embedding IAM Permissions
    // (videoToS3Handler grants are set earlier, near its declaration.)
    videoStagingBucket.grantReadWrite(embeddingTriggerHandler);
    videoStagingBucket.grantRead(embeddingStoreHandler);

    videoStagingBucket.grantRead(classifyClipHandler);
    mimirApiKeySecret.grantRead(classifyClipHandler);

    embeddingTriggerHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel', 'bedrock:StartAsyncInvoke', 'bedrock:GetAsyncInvoke'],
      resources: ['*'],
    }));

    embeddingStoreHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3vectors:PutVectors'],
      resources: ['*'],
    }));

    // Grant state machine permission to invoke Lambdas
    videoToS3Handler.grantInvoke(embeddingStateMachine);
    embeddingTriggerHandler.grantInvoke(embeddingStateMachine);
    embeddingStoreHandler.grantInvoke(embeddingStateMachine);
    classifyClipHandler.grantInvoke(roughCutStateMachine);
    mimirDetailsHandler.grantInvoke(embeddingStateMachine);
    mimirUpdateHandler.grantInvoke(embeddingStateMachine);

    // ===== Vertical Reframe Pipeline (MediaConvert Smart Cropping + Elemental Inference) =====
    // Note: Smart Cropping is only available in us-west-2

    // IAM role for MediaConvert (with Elemental Inference permissions)
    const mediaConvertRole = new iam.Role(this, 'MediaConvertRole', {
      assumedBy: new iam.ServicePrincipal('mediaconvert.amazonaws.com'),
      inlinePolicies: {
        S3Access: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['s3:GetObject', 's3:PutObject'],
              resources: [
                videoStagingBucket.bucketArn + '/*',
                outputBucket.bucketArn + '/*'
              ]
            }),
            // s3:GetObjectVersion is required for versioned buckets (reframed-videos has versioning enabled).
            // MediaConvert's MGILoader uses the versioned S3 API when fetching overlay files from versioned buckets.
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['s3:GetObjectVersion'],
              resources: [outputBucket.bucketArn + '/*']
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['s3:ListBucket'],
              resources: [videoStagingBucket.bucketArn, outputBucket.bucketArn]
            })
          ]
        }),
        ElementalInference: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'elemental-inference:CreateFeed',
                'elemental-inference:AssociateFeed',
                'elemental-inference:PutMedia',
                'elemental-inference:GetMetadata',
                'elemental-inference:DeleteFeed',
                'elemental-inference:TagResource'
              ],
              resources: ['*']
            })
          ]
        })
      }
    });

    // Vertical Reframe Lambda
    const verticalReframeHandler = new lambda.Function(this, 'VerticalReframeHandler', {
      functionName: `${resourcePrefix}-vertical-reframe-handler`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/vertical-reframe-handler'),
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      ephemeralStorageSize: cdk.Size.mebibytes(10240),
      environment: {
        MIMIR_API_KEY_SECRET_ARN: mimirApiKeySecret.secretArn,
        VIDEO_STAGING_BUCKET: videoStagingBucket.bucketName,
        OUTPUT_BUCKET: outputBucket.bucketName,
        MEDIACONVERT_ROLE_ARN: mediaConvertRole.roleArn,
        MIMIR_API_BASE: process.env.MIMIR_API_BASE || 'https://us.mjoll.no',
      },
    });

    mimirApiKeySecret.grantRead(verticalReframeHandler);
    videoStagingBucket.grantReadWrite(verticalReframeHandler);
    outputBucket.grantReadWrite(verticalReframeHandler);

    // Grant MediaConvert permissions
    verticalReframeHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['mediaconvert:CreateJob', 'mediaconvert:GetJob', 'mediaconvert:DescribeEndpoints'],
      resources: ['*'],
    }));
    verticalReframeHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [mediaConvertRole.roleArn],
    }));

    // Vertical Reframe State Machine (poll loop for MediaConvert job)
    const startReframe = new stepfunctionsTasks.LambdaInvoke(this, 'StartVerticalReframe', {
      lambdaFunction: verticalReframeHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'action': 'start',
        'itemDetails.$': '$',
        'mimirApiKey.$': '$$.Execution.Input.mimirApiKey',
        'aspectRatio.$': '$$.Execution.Input.aspectRatio'
      }),
      outputPath: '$.Payload'
    });

    const pollReframe = new stepfunctionsTasks.LambdaInvoke(this, 'PollVerticalReframe', {
      lambdaFunction: verticalReframeHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'action': 'poll',
        'jobId.$': '$.jobId',
        'id.$': '$.id',
        'title.$': '$.title',
        'outputUri.$': '$.outputUri',
        'aspectRatio.$': '$.aspectRatio'
      }),
      outputPath: '$.Payload'
    });

    const reframeWait = new stepfunctions.Wait(this, 'WaitForReframe', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30))
    });

    const uploadReframe = new stepfunctionsTasks.LambdaInvoke(this, 'UploadReframeResult', {
      lambdaFunction: verticalReframeHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'action': 'upload',
        'itemId.$': '$.id',
        'title.$': '$.title',
        'outputUri.$': '$.outputUri',
        'aspectRatio.$': '$.aspectRatio',
        'mimirApiKey.$': '$$.Execution.Input.mimirApiKey'
      }),
      outputPath: '$.Payload'
    });

    const reframeFailed = new stepfunctions.Pass(this, 'ReframeFailed', {
      result: stepfunctions.Result.fromObject({ status: 'failed', reason: 'MediaConvert job failed' })
    });

    // Poll loop: wait → poll → check status → loop or exit
    const checkReframeStatus = new stepfunctions.Choice(this, 'CheckReframeStatus')
      .when(stepfunctions.Condition.stringEquals('$.status', 'COMPLETE'), uploadReframe)
      .when(stepfunctions.Condition.stringEquals('$.status', 'ERROR'), reframeFailed)
      .when(stepfunctions.Condition.stringEquals('$.status', 'error'), reframeFailed)
      .otherwise(reframeWait);

    // Wire the poll loop: wait → poll → check (loops back to wait via otherwise)
    reframeWait.next(pollReframe).next(checkReframeStatus);

    // After start, check if it errored immediately or go into poll loop
    const checkStartResult = new stepfunctions.Choice(this, 'CheckStartResult')
      .when(stepfunctions.Condition.isPresent('$.jobId'), reframeWait)
      .otherwise(reframeFailed);

    // Build the state machine definition
    const getMimirDetailsReframe = new stepfunctionsTasks.LambdaInvoke(this, 'GetMimirDetailsReframe', {
      lambdaFunction: mimirDetailsHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'id.$': '$.id',
        'itemType.$': '$.itemType',
        'metadata.$': '$.metadata',
        'mimirApiKey.$': '$$.Execution.Input.mimirApiKey'
      }),
      outputPath: '$.Payload'
    });

    const skipItemReframe = new stepfunctions.Pass(this, 'SkipItemReframe', {
      result: stepfunctions.Result.fromObject({ status: 'skipped', reason: 'Not a video item' })
    });

    const checkItemTypeReframe = new stepfunctions.Choice(this, 'CheckItemTypeReframe')
      .when(stepfunctions.Condition.stringEquals('$.itemType', 'video'),
        getMimirDetailsReframe.next(startReframe).next(checkStartResult))
      .otherwise(skipItemReframe);

    const storeVariablesReframe = new stepfunctions.Pass(this, 'StoreVariablesReframe', {
      parameters: {
        'items.$': '$.items',
        'mimirApiKey.$': '$.mimirApiKey',
        'actionType.$': '$.actionType'
      }
    });

    const processItemsReframe = new stepfunctions.Map(this, 'ProcessItemsReframe', {
      itemsPath: stepfunctions.JsonPath.stringAt('$.items'),
      maxConcurrency: 2
    }).itemProcessor(checkItemTypeReframe);

    const reframeDefinition = storeVariablesReframe.next(processItemsReframe);

    const verticalReframeStateMachine = new stepfunctions.StateMachine(this, 'VerticalReframeStateMachine', {
      stateMachineName: `${resourcePrefix}-vertical-reframe`,
      definitionBody: stepfunctions.DefinitionBody.fromChainable(reframeDefinition),
      timeout: cdk.Duration.minutes(60),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'VerticalReframeStateMachineLogs', { retention: logs.RetentionDays.ONE_MONTH }),
        level: stepfunctions.LogLevel.ALL
      }
    });

    verticalReframeHandler.grantInvoke(verticalReframeStateMachine);
    mimirDetailsHandler.grantInvoke(verticalReframeStateMachine);
    verticalReframeStateMachine.grantStartExecution(mimirHandler);
    mimirHandler.addEnvironment('VERTICAL_REFRAME_STATE_MACHINE_ARN', verticalReframeStateMachine.stateMachineArn);

    // Add vertical-reframe to the mimir-handler environment
    // (The mimir-handler routes actions to state machines by actionType)

    // ---------------------------------------------------------------------------
    // Reframe + Graphics pipeline
    // ---------------------------------------------------------------------------

    // S3 bucket for Lottie templates (graphics overlay JSON files)
    const lottieTemplatesBucket = new s3.Bucket(this, 'LottieTemplatesBucket', {
      bucketName: `${resourcePrefix}-lottie-templates-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      enforceSSL: true,
      versioned: true,
    });

    // Classify Category Lambda (Node.js — lightweight Bedrock call)
    const classifyCategoryHandler = new lambda.Function(this, 'ClassifyCategoryHandler', {
      functionName: `${resourcePrefix}-classify-category-handler`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/classify-category-handler'),
      timeout: cdk.Duration.seconds(30),
      environment: {
        CLASSIFY_MODEL_ID: 'us.amazon.nova-pro-v1:0',
        TRANSCRIPT_STAGING_BUCKET: videoStagingBucket.bucketName,
      },
    });

    classifyCategoryHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: ['*'],
    }));
    videoStagingBucket.grantRead(classifyCategoryHandler);

    // Graphics Overlay Handler — Docker Lambda (rlottie-python + FFmpeg)
    const graphicsOverlayHandler = new lambda.DockerImageFunction(this, 'GraphicsOverlayHandler', {
      functionName: `${resourcePrefix}-graphics-overlay-handler`,
      code: lambda.DockerImageCode.fromImageAsset('lambda/graphics-overlay-handler'),
      timeout: cdk.Duration.minutes(15),
      memorySize: 3008,
      ephemeralStorageSize: cdk.Size.mebibytes(10240),
      environment: {
        LOTTIE_TEMPLATES_BUCKET: lottieTemplatesBucket.bucketName,
        OUTPUT_BUCKET: outputBucket.bucketName,
      },
    });

    lottieTemplatesBucket.grantRead(graphicsOverlayHandler);
    outputBucket.grantReadWrite(graphicsOverlayHandler);

    // Reframe + Graphics State Machine
    // Flow: classify category → render overlay (parallel per aspect ratio) →
    //       MediaConvert (smart crop + composite) → upload to Mimir
    const classifyCategory = new stepfunctionsTasks.LambdaInvoke(this, 'ClassifyCategory', {
      lambdaFunction: classifyCategoryHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'itemId.$': '$$.Execution.Input.itemId',
        // Use title/description from fetched mimirDetails — more reliable than execution input
        // which may only have the item ID if Mimir didn't populate the action payload fields
        'title.$': '$.mimirDetails.title',
        'description.$': '$$.Execution.Input.description',
        'transcript.$': '$$.Execution.Input.transcript',
        'mimirDetails.$': '$.mimirDetails',
        'mimirApiKey.$': '$$.Execution.Input.mimirApiKey',
      }),
      resultPath: '$.classification',
      outputPath: '$',
    });

    // Fetch full Mimir item details (includes timedTranscriptUrl) before classification
    const getMimirDetailsForGraphics = new stepfunctionsTasks.LambdaInvoke(this, 'GetMimirDetailsForGraphics', {
      lambdaFunction: mimirDetailsHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'id.$': '$$.Execution.Input.itemId',
        'itemType': 'video',
        'metadata': {},
        'mimirApiKey.$': '$$.Execution.Input.mimirApiKey',
      }),
      // Extract mimirDetails and proxyUrl; baseFilename derived from originalFileName
      resultSelector: {
        'mimirDetails.$': '$.Payload.mimirDetails',
        'proxyUrl.$': '$.Payload.proxyUrl',
      },
      resultPath: '$',
    });

    // Resolve the correct template key for this aspect ratio.
    // Step Functions can't do dynamic map key lookup, so we use a Choice
    // that sets templateKey based on aspectRatio before calling RenderOverlay.
    const setTemplate916 = new stepfunctions.Pass(this, 'SetTemplate916', {
      parameters: {
        'aspectRatio.$': '$.aspectRatio',
        'itemDetails.$': '$.itemDetails',
        'baseFilename.$': '$.baseFilename',
        'classification.$': '$.classification',
        'mimirDetails.$': '$.mimirDetails',
        'lottieTemplates.$': '$.lottieTemplates',
        'templateKey.$': '$.lottieTemplates[\'9:16\']',
      },
    });
    const setTemplate11 = new stepfunctions.Pass(this, 'SetTemplate11', {
      parameters: {
        'aspectRatio.$': '$.aspectRatio',
        'itemDetails.$': '$.itemDetails',
        'baseFilename.$': '$.baseFilename',
        'classification.$': '$.classification',
        'mimirDetails.$': '$.mimirDetails',
        'lottieTemplates.$': '$.lottieTemplates',
        'templateKey.$': '$.lottieTemplates[\'1:1\']',
      },
    });
    const setTemplate45 = new stepfunctions.Pass(this, 'SetTemplate45', {
      parameters: {
        'aspectRatio.$': '$.aspectRatio',
        'itemDetails.$': '$.itemDetails',
        'baseFilename.$': '$.baseFilename',
        'classification.$': '$.classification',
        'mimirDetails.$': '$.mimirDetails',
        'lottieTemplates.$': '$.lottieTemplates',
        'templateKey.$': '$.lottieTemplates[\'4:5\']',
      },
    });

    const resolveTemplate = new stepfunctions.Choice(this, 'ResolveTemplate')
      .when(stepfunctions.Condition.stringEquals('$.aspectRatio', '9:16'), setTemplate916)
      .when(stepfunctions.Condition.stringEquals('$.aspectRatio', '1:1'), setTemplate11)
      .otherwise(setTemplate45);

    // Render overlay for a single aspect ratio (used inside Parallel inside Map).
    // Renders a QuickTime MOV (qtrle+argb) for the given aspect ratio.
    // Output: {itemId}/overlays/{basename}_{aspect}.mov
    const renderOverlay = new stepfunctionsTasks.LambdaInvoke(this, 'RenderOverlay', {
      lambdaFunction: graphicsOverlayHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'templateBucket': lottieTemplatesBucket.bucketName,
        'templateKey.$': '$.templateKey',
        'outputBucket': outputBucket.bucketName,
        'itemId.$': '$$.Execution.Input.itemId',
        'baseFilename.$': '$.baseFilename',
        'aspectRatio.$': '$.aspectRatio',
        'category.$': '$.classification.Payload.category',
        'line1.$': '$.classification.Payload.line1',
        'line2.$': '$.classification.Payload.line2',
        'line3.$': '$.classification.Payload.line3',
        'location.$': '$.classification.Payload.location',
        'headline.$': '$.classification.Payload.headline',
        // Cap at 450 frames (15s at 29.97fps) — MediaConvert loops the overlay
        // via Playback: REPEAT so we don't need to match the full video duration.
        'maxFrames': 450,
      }),
      resultPath: '$.overlayResult',
    });

    // Pass 1: Smart crop — reframe source video to target aspect ratio.
    // Output: {itemId}/smart-crop/{basename}_{aspect}.mp4
    const startSmartCrop = new stepfunctionsTasks.LambdaInvoke(this, 'StartSmartCrop', {
      lambdaFunction: verticalReframeHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'action': 'start',
        'itemDetails.$': '$.itemDetails',
        'mimirDetails.$': '$.mimirDetails',
        'aspectRatio.$': '$.aspectRatio',
        // Graphics posts need the video upscaled to the full social canvas
        // (e.g. 1080x1920) so the full-size motion-graphics overlay fits and the
        // deliverable matches platform specs. Plain Vertical Reframe omits this
        // and stays native-height (crop only, no upscale).
        'fullCanvas': true,
      }),
      resultPath: '$.smartCropResult',
    });

    const pollSmartCrop = new stepfunctionsTasks.LambdaInvoke(this, 'PollSmartCrop', {
      lambdaFunction: verticalReframeHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'action': 'poll',
        'jobId.$': '$.smartCropResult.Payload.jobId',
        'id.$': '$.smartCropResult.Payload.id',
        'title.$': '$.smartCropResult.Payload.title',
        'outputUri.$': '$.smartCropResult.Payload.outputUri',
        'aspectRatio.$': '$.aspectRatio',
        'originalFileName.$': '$.smartCropResult.Payload.originalFileName',
      }),
      resultPath: '$.smartCropPoll',
    });

    const smartCropWait = new stepfunctions.Wait(this, 'WaitForSmartCrop', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const smartCropFailed = new stepfunctions.Pass(this, 'SmartCropFailed', {
      result: stepfunctions.Result.fromObject({ status: 'failed', reason: 'Smart crop job failed' }),
    });

    // Pass 2: Composite — apply MOV overlay to smart-cropped video.
    // Output: {itemId}/composited/{basename}_{aspect}.mp4
    const startCompositedJob = new stepfunctionsTasks.LambdaInvoke(this, 'StartOverlayJob', {
      lambdaFunction: verticalReframeHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'action': 'start-overlay-only',
        'itemId.$': '$$.Execution.Input.itemId',
        'originalFileName.$': '$.smartCropPoll.Payload.originalFileName',
        'croppedVideoUri.$': '$.smartCropPoll.Payload.outputUri',
        'overlayS3Uri.$': '$.overlayResult.Payload.overlayS3Uri',
        'aspectRatio.$': '$.aspectRatio',
        'title.$': '$.smartCropPoll.Payload.title',
        // Pass Mimir VTT URL so captions can be staged and burned in
        'vttUrl.$': '$.mimirDetails.vttUrl',
      }),
      resultPath: '$.compositedResult',
    });

    const pollComposited = new stepfunctionsTasks.LambdaInvoke(this, 'PollCompositedJob', {
      lambdaFunction: verticalReframeHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'action': 'poll',
        'jobId.$': '$.compositedResult.Payload.jobId',
        'id.$': '$.compositedResult.Payload.id',
        'title.$': '$.compositedResult.Payload.title',
        'outputUri.$': '$.compositedResult.Payload.outputUri',
        'aspectRatio.$': '$.aspectRatio',
        'originalFileName.$': '$.compositedResult.Payload.originalFileName',
      }),
      resultPath: '$.compositedPoll',
    });

    const compositedWait = new stepfunctions.Wait(this, 'WaitForComposited', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const compositedFailed = new stepfunctions.Pass(this, 'CompositedFailed', {
      result: stepfunctions.Result.fromObject({ status: 'failed', reason: 'Compositing job failed' }),
    });

    const uploadReframeGraphics = new stepfunctionsTasks.LambdaInvoke(this, 'UploadReframeGraphicsResult', {
      lambdaFunction: verticalReframeHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'action': 'upload',
        'itemId.$': '$$.Execution.Input.itemId',
        'storyId.$': '$$.Execution.Input.storyId',
        'title.$': '$.compositedPoll.Payload.title',
        'outputUri.$': '$.compositedPoll.Payload.outputUri',
        'aspectRatio.$': '$.aspectRatio',
        'mimirApiKey.$': '$$.Execution.Input.mimirApiKey',
      }),
      outputPath: '$.Payload',
    });

    const checkCompositedStatus = new stepfunctions.Choice(this, 'CheckCompositedStatus')
      .when(stepfunctions.Condition.stringEquals('$.compositedPoll.Payload.status', 'COMPLETE'), uploadReframeGraphics)
      .when(stepfunctions.Condition.stringEquals('$.compositedPoll.Payload.status', 'ERROR'), compositedFailed)
      .when(stepfunctions.Condition.stringEquals('$.compositedPoll.Payload.status', 'error'), compositedFailed)
      .otherwise(compositedWait);

    // Composited poll loop: wait → poll → check (loops back to wait via .otherwise)
    compositedWait.next(pollComposited).next(checkCompositedStatus);
    // startCompositedJob enters the composited poll loop on completion
    startCompositedJob.next(compositedWait);

    const checkSmartCropStatus = new stepfunctions.Choice(this, 'CheckSmartCropStatus')
      .when(stepfunctions.Condition.stringEquals('$.smartCropPoll.Payload.status', 'COMPLETE'), startCompositedJob)
      .when(stepfunctions.Condition.stringEquals('$.smartCropPoll.Payload.status', 'ERROR'), smartCropFailed)
      .when(stepfunctions.Condition.stringEquals('$.smartCropPoll.Payload.status', 'error'), smartCropFailed)
      .otherwise(smartCropWait);

    // Guard after StartSmartCrop — catch immediate errors before entering poll loop
    const checkSmartCropStarted = new stepfunctions.Choice(this, 'CheckSmartCropStarted')
      .when(stepfunctions.Condition.stringEquals('$.smartCropResult.Payload.status', 'error'), smartCropFailed)
      .when(stepfunctions.Condition.stringEquals('$.smartCropResult.Payload.status', 'ERROR'), smartCropFailed)
      .otherwise(smartCropWait);

    // Smart crop poll loop: wait → poll → check (loops back to wait via .otherwise)
    smartCropWait.next(pollSmartCrop).next(checkSmartCropStatus);

    // Wire the full per-aspect-ratio chain now that all states are declared:
    // resolveTemplate (Choice) → setTemplateXxx → renderOverlay → startSmartCrop → checkSmartCropStarted
    setTemplate916.next(renderOverlay);
    setTemplate11.next(renderOverlay);
    setTemplate45.next(renderOverlay);
    renderOverlay.next(startSmartCrop).next(checkSmartCropStarted);

    // Per-aspect-ratio branch entry point is the resolveTemplate Choice state.
    const perAspectRatioBranch = resolveTemplate;

    const processAspectRatios = new stepfunctions.Map(this, 'ProcessAspectRatios', {
      itemsPath: stepfunctions.JsonPath.stringAt('$$.Execution.Input.aspectRatios'),
      maxConcurrency: 3,
      itemSelector: {
        'aspectRatio.$': '$$.Map.Item.Value',
        'itemDetails.$': '$$.Execution.Input.itemDetails',
        'baseFilename.$': '$.mimirDetails.originalFileName',
        'classification.$': '$.classification',
        'mimirDetails.$': '$.mimirDetails',
        // Pass the full lottieTemplates map into each branch so RenderOverlay
        // can reference the correct key via a States.Format expression
        'lottieTemplates.$': '$$.Execution.Input.lottieTemplates',
      },
    }).itemProcessor(perAspectRatioBranch);

    const reframeGraphicsDefinition = getMimirDetailsForGraphics
      .next(classifyCategory)
      .next(processAspectRatios);

    const reframeWithGraphicsStateMachine = new stepfunctions.StateMachine(this, 'ReframeWithGraphicsStateMachine', {
      stateMachineName: `${resourcePrefix}-reframe-with-graphics`,
      definitionBody: stepfunctions.DefinitionBody.fromChainable(reframeGraphicsDefinition),
      timeout: cdk.Duration.minutes(60),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'ReframeWithGraphicsStateMachineLogs', {
          retention: logs.RetentionDays.ONE_MONTH,
        }),
        level: stepfunctions.LogLevel.ALL,
      },
    });

    classifyCategoryHandler.grantInvoke(reframeWithGraphicsStateMachine);
    graphicsOverlayHandler.grantInvoke(reframeWithGraphicsStateMachine);
    verticalReframeHandler.grantInvoke(reframeWithGraphicsStateMachine);
    mimirDetailsHandler.grantInvoke(reframeWithGraphicsStateMachine);

    // Wire into mimir-handler so it can start the state machine
    reframeWithGraphicsStateMachine.grantStartExecution(mimirHandler);
    mimirHandler.addEnvironment('REFRAME_WITH_GRAPHICS_STATE_MACHINE_ARN', reframeWithGraphicsStateMachine.stateMachineArn);

    // API Gateway route for the new custom action
    const reframeGraphicsResource = actionsResource.addResource('reframe-with-graphics');
    reframeGraphicsResource.addMethod('POST', new apigateway.LambdaIntegration(mimirHandler));

    // Upload Lottie templates to S3 on deploy.
    //
    // prune: false is deliberate. Customer templates are per-deployment content
    // rather than infrastructure, and `graphics/templates/*.json` is git-ignored
    // because the files embed station logos and licensed font outlines. With the
    // default prune: true, deploying from a fresh checkout syncs an empty
    // directory and deletes every template in the bucket, breaking the
    // ReframeWithGraphics pipeline with NoSuchKey at the RenderOverlay step.
    new s3deploy.BucketDeployment(this, 'LottieTemplatesDeployment', {
      sources: [s3deploy.Source.asset('graphics/templates')],
      destinationBucket: lottieTemplatesBucket,
      destinationKeyPrefix: 'templates',
      prune: false,
    });

    // ---------------------------------------------------------------------------
    // Reframe Custom pipeline
    // Per-scene intelligent reframe using Rekognition + Elemental Inference + Nova
    // ---------------------------------------------------------------------------

    // (ffmpegLayer is declared earlier, before the Embedding State Machine, so
    // the stability-analysis handler can use it too.)

    const reframeCustomCmafHandler = new lambda.Function(this, 'ReframeCustomCmafHandler', {
      functionName: `${resourcePrefix}-reframe-custom-cmaf-handler`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/reframe-custom-cmaf-handler'),
      timeout: cdk.Duration.minutes(15),
      memorySize: 10240,  // max memory = ~6 vCPUs for FFmpeg multi-threaded encode
      ephemeralStorageSize: cdk.Size.mebibytes(10240),
      layers: [ffmpegLayer],
      environment: {
        STAGING_BUCKET: videoStagingBucket.bucketName,
        OUTPUT_BUCKET: outputBucket.bucketName,
        FFMPEG_PATH: '/opt/bin/ffmpeg',
      },
    });

    const reframeCustomEiHandler = new lambda.Function(this, 'ReframeCustomEiHandler', {
      functionName: `${resourcePrefix}-reframe-custom-ei-handler`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/reframe-custom-ei-handler'),
      timeout: cdk.Duration.minutes(15),
      memorySize: 512,
      environment: {
        STAGING_BUCKET: videoStagingBucket.bucketName,
        EI_REGION: 'us-west-2',
      },
    });

    const reframeCustomSceneAnalysisHandler = new lambda.Function(this, 'ReframeCustomSceneAnalysisHandler', {
      functionName: `${resourcePrefix}-reframe-custom-scene-analysis-handler`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/reframe-custom-scene-analysis-handler'),
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      ephemeralStorageSize: cdk.Size.mebibytes(1024),
      layers: [ffmpegLayer],
      environment: {
        STAGING_BUCKET: videoStagingBucket.bucketName,
        NOVA_MODEL_ID: 'us.amazon.nova-pro-v1:0',
        XY_VARIANCE_THRESHOLD: '5000',
        FFMPEG_PATH: '/opt/bin/ffmpeg',
      },
    });

    // Reuse the existing MediaConvert role from the vertical-reframe pipeline
    const rcMediaConvertRoleArn = mediaConvertRole.roleArn;

    const reframeCustomMediaConvertHandler = new lambda.Function(this, 'ReframeCustomMediaConvertHandler', {
      functionName: `${resourcePrefix}-reframe-custom-mediaconvert-handler`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/reframe-custom-mediaconvert-handler'),
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      environment: {
        OUTPUT_BUCKET: outputBucket.bucketName,
        MEDIACONVERT_ROLE_ARN: rcMediaConvertRoleArn,
        MEDIACONVERT_REGION: 'us-west-2',
      },
    });

    const reframeCustomStitchHandler = new lambda.Function(this, 'ReframeCustomStitchHandler', {
      functionName: `${resourcePrefix}-reframe-custom-stitch-handler`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/reframe-custom-stitch-handler'),
      timeout: cdk.Duration.minutes(15),
      memorySize: 3008,
      ephemeralStorageSize: cdk.Size.mebibytes(10240),
      layers: [ffmpegLayer],
      environment: {
        OUTPUT_BUCKET: outputBucket.bucketName,
        FFMPEG_PATH: '/opt/bin/ffmpeg',
      },
    });

    // FFmpeg-based tile handler — produces stacked top/bottom layout
    const reframeCustomTileHandler = new lambda.Function(this, 'ReframeCustomTileHandler', {
      functionName: `${resourcePrefix}-reframe-custom-tile-handler`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/reframe-custom-tile-handler'),
      timeout: cdk.Duration.minutes(10),
      memorySize: 3008,
      ephemeralStorageSize: cdk.Size.mebibytes(2048),
      layers: [ffmpegLayer],
      environment: {
        OUTPUT_BUCKET: outputBucket.bucketName,
        FFMPEG_PATH: '/opt/bin/ffmpeg',
      },
    });

    // IAM grants — reframe-custom-cmaf-handler
    videoStagingBucket.grantReadWrite(reframeCustomCmafHandler);
    outputBucket.grantRead(reframeCustomCmafHandler);
    reframeCustomCmafHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:DeleteObject', 's3:ListBucket'],
      resources: [videoStagingBucket.bucketArn, `${videoStagingBucket.bucketArn}/*`],
    }));
    reframeCustomCmafHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['rekognition:StartSegmentDetection', 'rekognition:GetSegmentDetection'],
      resources: ['*'],
    }));

    // IAM grants — reframe-custom-ei-handler
    videoStagingBucket.grantRead(reframeCustomEiHandler);
    reframeCustomEiHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'elemental-inference:CreateFeed',
        'elemental-inference:DeleteFeed',
        'elemental-inference:GetFeed',
        'elemental-inference:UpdateFeed',
        'elemental-inference:AssociateFeed',
        'elemental-inference:DisassociateFeed',
        'elemental-inference:PutMedia',
        'elemental-inference:GetMetadata',
      ],
      resources: ['*'],
    }));

    // IAM grants — reframe-custom-scene-analysis-handler
    videoStagingBucket.grantReadWrite(reframeCustomSceneAnalysisHandler);
    outputBucket.grantRead(reframeCustomSceneAnalysisHandler);
    reframeCustomSceneAnalysisHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: ['*'],
    }));

    // IAM grants — reframe-custom-mediaconvert-handler
    outputBucket.grantReadWrite(reframeCustomMediaConvertHandler);
    reframeCustomMediaConvertHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['mediaconvert:CreateJob', 'mediaconvert:GetJob', 'mediaconvert:DescribeEndpoints'],
      resources: ['*'],
    }));
    reframeCustomMediaConvertHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [rcMediaConvertRoleArn],
    }));

    // IAM grants — reframe-custom-tile-handler
    videoStagingBucket.grantRead(reframeCustomTileHandler);
    outputBucket.grantReadWrite(reframeCustomTileHandler);

    // IAM grants — reframe-custom-stitch-handler
    // Now uses FFmpeg — needs to read scene clips from output bucket and write final output
    outputBucket.grantReadWrite(reframeCustomStitchHandler);

    // ReframeCustom State Machine
    // States
    const rcGetMimirDetails = new stepfunctionsTasks.LambdaInvoke(this, 'RCGetMimirDetails', {
      lambdaFunction: mimirDetailsHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'id.$': '$$.Execution.Input.itemId',
        'itemType': 'video',
        'metadata': {},
        'mimirApiKey.$': '$$.Execution.Input.mimirApiKey',
      }),
      resultSelector: {
        'mimirDetails.$': '$.Payload.mimirDetails',
        'proxyUrl.$': '$.Payload.proxyUrl',
        // Use highRes (full resolution) for best quality; falls back to proxy if unavailable
        'sourceVideoUri.$': '$.Payload.mimirDetails.highRes',
      },
      resultPath: '$',
    });

    const rcClassifyCategory = new stepfunctionsTasks.LambdaInvoke(this, 'RCClassifyCategory', {
      lambdaFunction: classifyCategoryHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'itemId.$': '$$.Execution.Input.itemId',
        'title.$': '$.mimirDetails.title',
        'description.$': '$$.Execution.Input.description',
        'transcript.$': '$$.Execution.Input.transcript',
        'mimirDetails.$': '$.mimirDetails',
        'mimirApiKey.$': '$$.Execution.Input.mimirApiKey',
      }),
      resultPath: '$.classification',
      outputPath: '$',
    });

    const rcStartRekognition = new stepfunctionsTasks.LambdaInvoke(this, 'RCStartRekognition', {
      lambdaFunction: reframeCustomCmafHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'action': 'start-rekognition',
        'itemId.$': '$$.Execution.Input.itemId',
        'sourceVideoUri.$': '$.sourceVideoUri',
        'executionTimestamp.$': '$$.Execution.Input.executionTimestamp',
      }),
      resultPath: '$.rekognitionStart',
    });

    const rcWaitForRekognition = new stepfunctions.Wait(this, 'RCWaitForRekognition', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const rcPollRekognition = new stepfunctionsTasks.LambdaInvoke(this, 'RCPollRekognition', {
      lambdaFunction: reframeCustomCmafHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'action': 'poll-rekognition',
        'jobId.$': '$.rekognitionStart.Payload.jobId',
      }),
      resultPath: '$.rekognitionResult',
    });

    const rcUseSingleScene = new stepfunctions.Pass(this, 'RCUseSingleScene', {
      parameters: {
        'scenes': [{ 'sceneIndex': 0, 'startMs': 0, 'endMs': 999999999 }],
        'sourceVideoUri.$': '$.rekognitionStart.Payload.stagedVideoUri',
        'mimirDetails.$': '$.mimirDetails',
        'classification.$': '$.classification',
      },
    });

    const rcPrepareScenes = new stepfunctionsTasks.LambdaInvoke(this, 'RCPrepareScenes', {
      lambdaFunction: reframeCustomCmafHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'action': 'prepare-scenes',
        'rekognitionSegments.$': '$.rekognitionResult.Payload.segments',
        // Use the staged S3 URI from start-rekognition (not the original pre-signed URL)
        'sourceVideoUri.$': '$.rekognitionStart.Payload.stagedVideoUri',
      }),
      resultPath: '$.scenesResult',
    });

    // Extract scenes array from prepare-scenes result into $.scenes
    const rcExtractScenes = new stepfunctions.Pass(this, 'RCExtractScenes', {
      parameters: {
        'mimirDetails.$': '$.mimirDetails',
        'sourceVideoUri.$': '$.rekognitionStart.Payload.stagedVideoUri',
        'classification.$': '$.classification',
        'rekognitionStart.$': '$.rekognitionStart',
        'scenes.$': '$.scenesResult.Payload.scenes',
      },
    });

    const rcCheckRekognitionStatus = new stepfunctions.Choice(this, 'RCCheckRekognitionStatus')
      .when(stepfunctions.Condition.stringEquals('$.rekognitionResult.Payload.status', 'SUCCEEDED'), rcPrepareScenes)
      .when(stepfunctions.Condition.stringEquals('$.rekognitionResult.Payload.status', 'FAILED'), rcUseSingleScene)
      .otherwise(rcWaitForRekognition);

    rcWaitForRekognition.next(rcPollRekognition).next(rcCheckRekognitionStatus);

    // Parallel: CMAF conversion + Lottie overlay rendering
    // Note: catch blocks are NOT added to states inside Parallel branches —
    // instead the Parallel itself has a catch that triggers fallback
    const rcConvertToCmaf = new stepfunctionsTasks.LambdaInvoke(this, 'RCConvertToCmaf', {
      lambdaFunction: reframeCustomCmafHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'action': 'convert',
        'itemId.$': '$$.Execution.Input.itemId',
        'sourceVideoUri.$': '$.rekognitionStart.Payload.stagedVideoUri',
        'executionTimestamp.$': '$$.Execution.Input.executionTimestamp',
      }),
      resultPath: '$.cmafResult',
    });

    const rcRenderOverlay = new stepfunctionsTasks.LambdaInvoke(this, 'RCRenderOverlay', {
      lambdaFunction: graphicsOverlayHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'templateBucket': lottieTemplatesBucket.bucketName,
        'templateKey': 'templates/graphics-overlay-1080x1920-9x16.json',
        'outputBucket': outputBucket.bucketName,
        'itemId.$': '$$.Execution.Input.itemId',
        'baseFilename.$': '$$.Execution.Input.baseFilename',
        'aspectRatio': '9:16',
        'category.$': '$.classification.Payload.category',
        'line1.$': '$.classification.Payload.line1',
        'line2.$': '$.classification.Payload.line2',
        'line3.$': '$.classification.Payload.line3',
        'location.$': '$.classification.Payload.location',
        'headline.$': '$.classification.Payload.headline',
        'maxFrames': 450,
      }),
      resultPath: '$.overlayResult',
    });

    const rcParallelCmafAndOverlay = new stepfunctions.Parallel(this, 'RCParallelCmafAndOverlay')
      .branch(rcConvertToCmaf)
      .branch(rcRenderOverlay);

    // EI feed management — stores sceneCoordinates at $.eiResult.Payload.sceneCoordinates
    const rcEiFeedManagement = new stepfunctionsTasks.LambdaInvoke(this, 'RCEiFeedManagement', {
      lambdaFunction: reframeCustomEiHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'itemId.$': '$$.Execution.Input.itemId',
        'executionTimestamp.$': '$$.Execution.Input.executionTimestamp',
        'initSegmentKey.$': '$.cmafResult.initSegmentKey',
        'audioInitSegmentKey.$': '$.cmafResult.audioInitSegmentKey',
        'segmentKeys.$': '$.cmafResult.segmentKeys',
        'audioSegmentKeys.$': '$.cmafResult.audioSegmentKeys',
        'videoFrameRateNum.$': '$.cmafResult.videoFrameRateNum',
        'videoFrameRateDen.$': '$.cmafResult.videoFrameRateDen',
        'scenes.$': '$.scenes',
      }),
      resultPath: '$.eiResult',
    });

    // Scene analysis Map — iterates over scenes, passes xyCoordinates from EI result
    // Note: EI coordinates are passed via execution input since Map can't do per-item lookup
    // The scene analysis handler receives xyCoordinates for its specific sceneIndex
    const rcAnalyseScene = new stepfunctionsTasks.LambdaInvoke(this, 'RCAnalyseScene', {
      lambdaFunction: reframeCustomSceneAnalysisHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'itemId.$': '$$.Execution.Input.itemId',
        'sceneIndex.$': '$.sceneIndex',
        'startMs.$': '$.startMs',
        'endMs.$': '$.endMs',
        'sourceVideoUri.$': '$.sourceVideoUri',
        'executionTimestamp.$': '$$.Execution.Input.executionTimestamp',
        'xyCoordinates.$': '$.xyCoordinates',
        'varianceThreshold.$': '$$.Execution.Input.varianceThreshold',
      }),
      outputPath: '$.Payload',
    });

    const rcAnalyseScenes = new stepfunctions.Map(this, 'RCAnalyseScenes', {
      // Use EI sceneCoordinates as input (already has sceneIndex, startMs, endMs, xyCoordinates)
      itemsPath: stepfunctions.JsonPath.stringAt('$.eiResult.Payload.sceneCoordinates'),
      maxConcurrency: 5,
      resultPath: '$.sceneAnalysisResults',
      itemSelector: {
        'sceneIndex.$': '$$.Map.Item.Value.sceneIndex',
        'startMs.$': '$$.Map.Item.Value.startMs',
        'endMs.$': '$$.Map.Item.Value.endMs',
        'xyCoordinates.$': '$$.Map.Item.Value.xyCoordinates',
        'sourceVideoUri.$': '$.sourceVideoUri',
      },
    }).itemProcessor(rcAnalyseScene);

    // Per-scene encode — CROP uses MediaConvert, TILE uses FFmpeg
    const rcStartSceneEncode = new stepfunctionsTasks.LambdaInvoke(this, 'RCStartSceneEncode', {
      lambdaFunction: reframeCustomMediaConvertHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'action': 'start',
        'itemId.$': '$$.Execution.Input.itemId',
        'sceneIndex.$': '$.sceneIndex',
        'startMs.$': '$.startMs',
        'endMs.$': '$.endMs',
        'decision.$': '$.decision',
        'representativeX.$': '$.representativeX',
        'representativeY.$': '$.representativeY',
        'sourceVideoUri.$': '$.sourceVideoUri',
        'overlayS3Uri.$': '$.overlayS3Uri',
        'outputBucket': outputBucket.bucketName,
        'baseFilename.$': '$$.Execution.Input.baseFilename',
        'executionTimestamp.$': '$$.Execution.Input.executionTimestamp',
      }),
      resultPath: '$.encodeJob',
    });

    // TILE: FFmpeg handler runs synchronously and returns COMPLETE directly
    const rcStartTileEncode = new stepfunctionsTasks.LambdaInvoke(this, 'RCStartTileEncode', {
      lambdaFunction: reframeCustomTileHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'action': 'start',
        'itemId.$': '$$.Execution.Input.itemId',
        'sceneIndex.$': '$.sceneIndex',
        'startMs.$': '$.startMs',
        'endMs.$': '$.endMs',
        'representativeX.$': '$.representativeX',
        'representativeY.$': '$.representativeY',
        'sourceVideoUri.$': '$.sourceVideoUri',
        'executionTimestamp.$': '$$.Execution.Input.executionTimestamp',
      }),
      resultPath: '$.encodePoll',  // same path as poll result so downstream works
      timeout: cdk.Duration.minutes(10),
    });

    const rcWaitForSceneEncode = new stepfunctions.Wait(this, 'RCWaitForSceneEncode', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const rcPollSceneEncode = new stepfunctionsTasks.LambdaInvoke(this, 'RCPollSceneEncode', {
      lambdaFunction: reframeCustomMediaConvertHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'action': 'poll',
        'jobId.$': '$.encodeJob.Payload.jobId',
        'sceneIndex.$': '$.sceneIndex',
        'expectedOutputUri.$': '$.encodeJob.Payload.expectedOutputUri',
      }),
      resultPath: '$.encodePoll',
    });

    const rcSceneEncodeFailed = new stepfunctions.Pass(this, 'RCSceneEncodeFailed', {
      parameters: {
        'sceneIndex.$': '$.sceneIndex',
        'outputUri.$': '$.encodeJob.Payload.expectedOutputUri',
        'status': 'ERROR',
      },
    });

    const rcCheckSceneEncodeStatus = new stepfunctions.Choice(this, 'RCCheckSceneEncodeStatus')
      .when(stepfunctions.Condition.stringEquals('$.encodePoll.Payload.status', 'COMPLETE'), new stepfunctions.Pass(this, 'RCSceneEncodeComplete'))
      .when(stepfunctions.Condition.stringEquals('$.encodePoll.Payload.status', 'ERROR'), rcSceneEncodeFailed)
      .otherwise(rcWaitForSceneEncode);

    rcWaitForSceneEncode.next(rcPollSceneEncode).next(rcCheckSceneEncodeStatus);
    rcStartSceneEncode.next(rcWaitForSceneEncode);

    // Route TILE to FFmpeg handler, CROP to MediaConvert
    const rcChooseEncodeMethod = new stepfunctions.Choice(this, 'RCChooseEncodeMethod')
      .when(stepfunctions.Condition.stringEquals('$.decision', 'TILE'), rcStartTileEncode)
      .otherwise(rcStartSceneEncode);

    // TILE completes synchronously — map its output to match CROP poll format
    const rcTileEncodeComplete = new stepfunctions.Pass(this, 'RCTileEncodeComplete');
    rcStartTileEncode.next(rcTileEncodeComplete);

    const rcEncodeSceneBranch = rcChooseEncodeMethod;

    const rcEncodeScenes = new stepfunctions.Map(this, 'RCEncodeScenes', {
      itemsPath: stepfunctions.JsonPath.stringAt('$.sceneAnalysisResults'),
      maxConcurrency: 5,
      resultPath: '$.sceneEncodeResults',
      itemSelector: {
        'sceneIndex.$': '$$.Map.Item.Value.sceneIndex',
        'startMs.$': '$$.Map.Item.Value.startMs',
        'endMs.$': '$$.Map.Item.Value.endMs',
        'decision.$': '$$.Map.Item.Value.decision',
        'representativeX.$': '$$.Map.Item.Value.representativeX',
        'representativeY.$': '$$.Map.Item.Value.representativeY',
        'sourceVideoUri.$': '$$.Map.Item.Value.sourceVideoUri',
        'overlayS3Uri.$': '$.overlayResult.overlayS3Uri',
      },
    }).itemProcessor(rcEncodeSceneBranch);

    // Stitch
    const rcStartStitch = new stepfunctionsTasks.LambdaInvoke(this, 'RCStartStitch', {
      lambdaFunction: reframeCustomStitchHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'action': 'start',
        'itemId.$': '$$.Execution.Input.itemId',
        'baseFilename.$': '$$.Execution.Input.baseFilename',
        'sceneOutputUris.$': '$.sceneOutputUris',
        'outputBucket': outputBucket.bucketName,
        'executionTimestamp.$': '$$.Execution.Input.executionTimestamp',
      }),
      resultPath: '$.stitchJob',
    });

    const rcWaitForStitch = new stepfunctions.Wait(this, 'RCWaitForStitch', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const rcPollStitch = new stepfunctionsTasks.LambdaInvoke(this, 'RCPollStitch', {
      lambdaFunction: reframeCustomStitchHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'action': 'poll',
        'jobId.$': '$.stitchJob.Payload.jobId',
        'expectedOutputUri.$': '$.stitchJob.Payload.expectedOutputUri',
      }),
      resultPath: '$.stitchPoll',
    });

    const rcStitchFailed = new stepfunctions.Pass(this, 'RCStitchFailed', {
      result: stepfunctions.Result.fromObject({ status: 'failed', reason: 'Stitch job failed' }),
    });

    const rcStitchComplete = new stepfunctions.Pass(this, 'RCStitchComplete');

    const rcCheckStitchStatus = new stepfunctions.Choice(this, 'RCCheckStitchStatus')
      .when(stepfunctions.Condition.stringEquals('$.stitchPoll.Payload.status', 'COMPLETE'), rcStitchComplete)
      .when(stepfunctions.Condition.stringEquals('$.stitchPoll.Payload.status', 'ERROR'), rcStitchFailed)
      .otherwise(rcWaitForStitch);

    rcWaitForStitch.next(rcPollStitch).next(rcCheckStitchStatus);

    // rcStartStitch enters the stitch poll loop
    rcStartStitch.next(rcWaitForStitch);

    // Upload to Mimir (reuse existing verticalReframeHandler upload action)
    const rcUploadToMimir = new stepfunctionsTasks.LambdaInvoke(this, 'RCUploadToMimir', {
      lambdaFunction: verticalReframeHandler,
      payload: stepfunctions.TaskInput.fromObject({
        'action': 'upload',
        'itemId.$': '$$.Execution.Input.itemId',
        'storyId.$': '$$.Execution.Input.storyId',
        'title.$': '$$.Execution.Input.title',
        'outputUri.$': '$.stitchPoll.Payload.outputUri',
        'aspectRatio': '9:16',
        'mimirApiKey.$': '$$.Execution.Input.mimirApiKey',
      }),
      outputPath: '$.Payload',
    });

    // Wire stitch complete → upload
    rcStitchComplete.next(rcUploadToMimir);

    // Fallback: emit metric + invoke ReframeWithGraphics
    const rcEmitFallbackMetric = new stepfunctionsTasks.CallAwsService(this, 'RCEmitFallbackMetric', {
      service: 'cloudwatch',
      action: 'putMetricData',
      parameters: {
        Namespace: 'FonnCustomActions',
        MetricData: [{
          MetricName: 'ReframeCustomFallbackCount',
          Value: 1,
          Unit: 'Count',
          Dimensions: [{ Name: 'ItemId', 'Value.$': '$$.Execution.Input.itemId' }],
        }],
      },
      iamResources: ['*'],
      resultPath: stepfunctions.JsonPath.DISCARD,
    });

    const rcInvokeFallback = new stepfunctionsTasks.StepFunctionsStartExecution(this, 'RCInvokeFallback', {
      stateMachine: reframeWithGraphicsStateMachine,
      input: stepfunctions.TaskInput.fromObject({
        'itemId.$': '$$.Execution.Input.itemId',
        'storyId.$': '$$.Execution.Input.storyId',
        'itemDetails.$': '$$.Execution.Input.itemDetails',
        'baseFilename.$': '$$.Execution.Input.baseFilename',
        'title.$': '$$.Execution.Input.title',
        'description.$': '$$.Execution.Input.description',
        'transcript.$': '$$.Execution.Input.transcript',
        'lottieTemplates.$': '$$.Execution.Input.lottieTemplates',
        'aspectRatios.$': '$$.Execution.Input.aspectRatios',
        'mimirApiKey.$': '$$.Execution.Input.mimirApiKey',
        'userToken.$': '$$.Execution.Input.userToken',
        'userId.$': '$$.Execution.Input.userId',
        'userEmail.$': '$$.Execution.Input.userEmail',
      }),
      integrationPattern: stepfunctions.IntegrationPattern.RUN_JOB,
      resultPath: '$.fallbackResult',
    });

    const rcFallbackChain = rcEmitFallbackMetric.next(rcInvokeFallback);

    const rcTerminalFailure = new stepfunctions.Pass(this, 'RCTerminalFailure', {
      result: stepfunctions.Result.fromObject({ status: 'failed' }),
    });

    // Wire catch blocks
    // Parallel (CMAF+overlay) failure → fallback
    const rcCmafFailed = new stepfunctions.Pass(this, 'RCCmafFailed', {
      parameters: { 'fallbackReason': 'CMAF/overlay step failed', 'error.$': '$.error' },
    });
    rcCmafFailed.next(rcEmitFallbackMetric);

    // EI failure → fallback
    const rcEiFailed = new stepfunctions.Pass(this, 'RCEiFailed', {
      parameters: { 'fallbackReason': 'EI feed operation failed', 'error.$': '$.error' },
    });
    rcEiFailed.next(rcEmitFallbackMetric);

    rcParallelCmafAndOverlay.addCatch(rcCmafFailed, { errors: ['States.ALL'], resultPath: '$.error' });
    rcEiFeedManagement.addCatch(rcEiFailed, { errors: ['States.ALL'], resultPath: '$.error' });
    rcGetMimirDetails.addCatch(rcTerminalFailure, { errors: ['States.ALL'], resultPath: '$.error' });
    rcClassifyCategory.addCatch(rcTerminalFailure, { errors: ['States.ALL'], resultPath: '$.error' });
    rcUploadToMimir.addCatch(rcTerminalFailure, { errors: ['States.ALL'], resultPath: '$.error' });

    // State machine definition
    // The Rekognition poll loop is wired separately above:
    //   rcWaitForRekognition → rcPollRekognition → rcCheckRekognitionStatus
    //     (SUCCEEDED → rcPrepareScenes, FAILED → rcUseSingleScene, otherwise → rcWaitForRekognition)
    // The main chain enters the poll loop via rcStartRekognition → rcWaitForRekognition
    const reframeCustomDefinition = rcGetMimirDetails
      .next(rcClassifyCategory)
      .next(rcStartRekognition)
      .next(rcWaitForRekognition);  // enters poll loop; exits to rcPrepareScenes or rcUseSingleScene

    // After Rekognition, both paths converge at rcParallelCmafAndOverlay
    // Wire rcPrepareScenes → rcExtractScenes → parallel
    // Wire rcUseSingleScene → parallel (already has $.scenes)
    rcPrepareScenes.next(rcExtractScenes);
    rcExtractScenes.next(rcParallelCmafAndOverlay);
    rcUseSingleScene.next(rcParallelCmafAndOverlay);

    // After Parallel, merge CMAF and overlay results into a flat state
    const rcMergeParallelResults = new stepfunctions.Pass(this, 'RCMergeParallelResults', {
      parameters: {
        'mimirDetails.$': '$[0].mimirDetails',
        'sourceVideoUri.$': '$[0].sourceVideoUri',
        'classification.$': '$[0].classification',
        'rekognitionStart.$': '$[0].rekognitionStart',
        'scenes.$': '$[0].scenes',
        'cmafResult.$': '$[0].cmafResult.Payload',
        'overlayResult.$': '$[1].overlayResult.Payload',
      },
    });

    // Check if CMAF conversion succeeded before proceeding to EI
    const rcCheckCmafStatus = new stepfunctions.Choice(this, 'RCCheckCmafStatus')
      .when(stepfunctions.Condition.stringEquals('$.cmafResult.status', 'success'), rcEiFeedManagement)
      .otherwise(rcCmafFailed);

    rcEiFeedManagement
      .next(rcAnalyseScenes)
      .next(rcEncodeScenes);

    // Collect scene output URIs from encode results into a flat array for the stitch step
    // Each item in sceneEncodeResults has encodePoll.Payload.outputUri from the poll loop
    const rcBuildStitchInput = new stepfunctions.Pass(this, 'RCBuildStitchInput', {
      parameters: {
        'mimirDetails.$': '$.mimirDetails',
        'sourceVideoUri.$': '$.sourceVideoUri',
        'classification.$': '$.classification',
        'overlayResult.$': '$.overlayResult',
        'eiResult.$': '$.eiResult',
        'sceneEncodeResults.$': '$.sceneEncodeResults',
        'sceneOutputUris.$': '$.sceneEncodeResults[*].encodePoll.Payload.outputUri',
      },
    });

    rcEncodeScenes
      .next(rcBuildStitchInput)
      .next(rcStartStitch);  // enters stitch poll loop → rcStitchComplete → rcUploadToMimir

    // Wire: Parallel → merge → check CMAF status → EI or fallback
    rcParallelCmafAndOverlay
      .next(rcMergeParallelResults)
      .next(rcCheckCmafStatus);

    const reframeCustomStateMachine = new stepfunctions.StateMachine(this, 'ReframeCustomStateMachine', {
      stateMachineName: `${resourcePrefix}-reframe-custom`,
      definitionBody: stepfunctions.DefinitionBody.fromChainable(reframeCustomDefinition),
      timeout: cdk.Duration.minutes(120),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'ReframeCustomStateMachineLogs', {
          retention: logs.RetentionDays.ONE_MONTH,
        }),
        level: stepfunctions.LogLevel.ALL,
      },
    });

    // Grant state machine permissions
    reframeCustomCmafHandler.grantInvoke(reframeCustomStateMachine);
    reframeCustomEiHandler.grantInvoke(reframeCustomStateMachine);
    reframeCustomSceneAnalysisHandler.grantInvoke(reframeCustomStateMachine);
    reframeCustomMediaConvertHandler.grantInvoke(reframeCustomStateMachine);
    reframeCustomTileHandler.grantInvoke(reframeCustomStateMachine);
    reframeCustomStitchHandler.grantInvoke(reframeCustomStateMachine);
    mimirDetailsHandler.grantInvoke(reframeCustomStateMachine);
    classifyCategoryHandler.grantInvoke(reframeCustomStateMachine);
    graphicsOverlayHandler.grantInvoke(reframeCustomStateMachine);
    verticalReframeHandler.grantInvoke(reframeCustomStateMachine);

    reframeCustomStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    }));
    reframeWithGraphicsStateMachine.grantStartExecution(reframeCustomStateMachine);

    // Wire into mimir-handler
    reframeCustomStateMachine.grantStartExecution(mimirHandler);
    mimirHandler.addEnvironment('REFRAME_CUSTOM_STATE_MACHINE_ARN', reframeCustomStateMachine.stateMachineArn);

    // API Gateway route
    const reframeCustomResource = actionsResource.addResource('reframe-custom');
    reframeCustomResource.addMethod('POST', new apigateway.LambdaIntegration(mimirHandler));

    // SSM parameter for state machine ARN
    new ssm.StringParameter(this, 'ReframeCustomStateMachineArnParam', {
      parameterName: '/fonn-custom-actions/reframe-custom/state-machine-arn',
      stringValue: reframeCustomStateMachine.stateMachineArn,
      description: 'ARN of the ReframeCustom Step Functions state machine',
    });

    new cdk.CfnOutput(this, 'ReframeCustomStateMachineArn', {
      value: reframeCustomStateMachine.stateMachineArn,
      description: 'Step Functions state machine for Reframe Custom workflow',
    });

    new cdk.CfnOutput(this, 'ReframeCustomEndpoint', {
      value: api.url + 'actions/reframe-custom',
      description: 'Mimir Reframe Custom Action Endpoint URL',
    });

    // Register Mimir custom actions and webhooks (idempotent)
    const mimirBaseUrl = process.env.MIMIR_API_BASE || 'https://us.mjoll.no';
    
    const registerIntegrationsHandler = new lambda.Function(this, 'RegisterMimirIntegrations', {
      functionName: `${resourcePrefix}-register-mimir-integrations`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/register-mimir-integrations'),
      timeout: cdk.Duration.seconds(60),
      environment: {
        MIMIR_API_KEY_SECRET_ARN: mimirApiKeySecret.secretArn,
      },
    });
    mimirApiKeySecret.grantRead(registerIntegrationsHandler);

    const registerIntegrations = new cdk.CustomResource(this, 'MimirIntegrationsRegistration', {
      serviceToken: registerIntegrationsHandler.functionArn,
      properties: {
        MimirApiKeySecretArn: mimirApiKeySecret.secretArn,
        MimirBaseUrl: mimirBaseUrl,
        ActionsApiUrl: api.url + 'actions/',
        WebhookApiUrl: webhookApi.url,
        // Force update on every deploy to keep URLs in sync
        DeployTimestamp: Date.now().toString(),
      },
    });

    // Outputs

    new cdk.CfnOutput(this, 'ApiBaseUrl', {
      value: api.url + 'actions/',
      description: 'Base URL for all Mimir Custom Actions',
    });

    new cdk.CfnOutput(this, 'SummarizerEndpoint', {
      value: api.url + 'actions/summarizer',
      description: 'Mimir Summarizer Custom Action Endpoint URL',
    });

    new cdk.CfnOutput(this, 'ChapterizeEndpoint', {
      value: api.url + 'actions/chapterize',
      description: 'Mimir Chapterize Custom Action Endpoint URL',
    });

    new cdk.CfnOutput(this, 'ItemChangeWebhookEndpoint', {
      value: webhookApi.url + 'webhook/item-change',
      description: 'Item Change Webhook Endpoint URL',
    });

    new cdk.CfnOutput(this, 'ItemCreateWebhookEndpoint', {
      value: webhookApi.url + 'webhook/item-create',
      description: 'Item Create Webhook Endpoint URL',
    });

    new cdk.CfnOutput(this, 'SagaActionsApiKeyArn', {
      value: sagaActionsApiKeySecret.secretArn,
      description: 'Secrets Manager ARN of the Saga actions x-api-key. Retrieve this value and set it in Saga Configure Auth (API key) when creating Saga custom actions.',
    });

    new cdk.CfnOutput(this, 'MimirApiKeyArn', {
      value: mimirApiKeySecret.secretArn,
      description: 'ARN of the Mimir API key (for us to authenticate with Mimir)',
    });

    // Export Mimir API key secret ARN to Parameter Store for cross-stack reference
    new ssm.StringParameter(this, 'MimirApiKeyArnParameter', {
      parameterName: '/infrastructure/mimir-api-key-arn',
      stringValue: mimirApiKeySecret.secretArn,
      description: 'ARN of the Mimir API key secret (for cross-stack reference)',
    });

    // Export Saga API key secret ARN to Parameter Store for cross-stack reference
    new ssm.StringParameter(this, 'SagaApiKeyArnParameter', {
      parameterName: '/infrastructure/saga-api-key-arn',
      stringValue: sagaApiKeySecret.secretArn,
      description: 'ARN of the Saga API key secret (for cross-stack reference)',
    });

    // Export Saga API URL secret ARN to Parameter Store for cross-stack reference
    new ssm.StringParameter(this, 'SagaApiUrlArnParameter', {
      parameterName: '/infrastructure/saga-api-url-arn',
      stringValue: sagaApiUrlSecret.secretArn,
      description: 'ARN of the Saga API URL secret (for cross-stack reference)',
    });

    // Export Vector Bucket name to Parameter Store for cross-stack reference
    new ssm.StringParameter(this, 'VectorBucketNameParameter', {
      parameterName: '/infrastructure/vector-bucket-name',
      stringValue: vectorBucket.vectorBucketName!,
      description: 'S3 Vector Bucket name (for cross-stack reference)',
    });

    // Export Video Staging Bucket name to Parameter Store for cross-stack reference
    new ssm.StringParameter(this, 'VideoStagingBucketNameParameter', {
      parameterName: '/infrastructure/video-staging-bucket-name',
      stringValue: videoStagingBucket.bucketName,
      description: 'Video staging bucket name (for cross-stack reference)',
    });

    // Export durable media-analysis bucket name (stability maps, etc.)
    new ssm.StringParameter(this, 'MediaAnalysisBucketNameParameter', {
      parameterName: '/infrastructure/media-analysis-bucket-name',
      stringValue: mediaAnalysisBucket.bucketName,
      description: 'Durable media-analysis bucket name (camera-stability maps, etc.)',
    });

    // Store webhook API base URL in Parameter Store for scripts
    new ssm.StringParameter(this, 'WebhookApiBaseUrlParameter', {
      parameterName: '/infrastructure/webhook-api-base-url',
      stringValue: webhookApi.url,
      description: 'Base URL of the Mimir Webhooks API Gateway',
    });

    new cdk.CfnOutput(this, 'OutputBucketName', {
      value: outputBucket.bucketName,
      description: 'S3 bucket for processed video outputs',
    });


    new cdk.CfnOutput(this, 'SummarizerStateMachineArn', {
      value: processSummarizerStateMachine.stateMachineArn,
      description: 'Step Functions state machine for content summarization workflow',
    });

    new cdk.CfnOutput(this, 'ChapterizeStateMachineArn', {
      value: processChapterizeStateMachine.stateMachineArn,
      description: 'Step Functions state machine for content chapterization workflow',
    });

    new cdk.CfnOutput(this, 'RoughCutStateMachineArn', {
      value: roughCutStateMachine.stateMachineArn,
      description: 'Step Functions state machine for rough cut timeline generation',
    });

    new cdk.CfnOutput(this, 'RoughCutEndpoint', {
      value: api.url + 'actions/rough-cut',
      description: 'Mimir Rough Cut Custom Action Endpoint URL',
    });

    new cdk.CfnOutput(this, 'SagaFeedItemsTableName', {
      value: sagaFeedItemsTable.tableName,
      description: 'DynamoDB table for Saga feed items lookup',
    });

    new cdk.CfnOutput(this, 'SagaFeedsWebhookProcessorArn', {
      value: sagaFeedsWebhookProcessor.stateMachineArn,
      description: 'Step Functions Express workflow for Saga feeds webhook processing',
    });

    new cdk.CfnOutput(this, 'ItemEmbedWebhookEndpoint', {
      value: webhookApi.url + 'webhook/item-embed',
      description: 'Item Embed Webhook Endpoint URL',
    });

    new cdk.CfnOutput(this, 'EmbeddingStateMachineArn', {
      value: embeddingStateMachine.stateMachineArn,
      description: 'Step Functions state machine for video embedding workflow',
    });

    new cdk.CfnOutput(this, 'ReframeWithGraphicsStateMachineArn', {
      value: reframeWithGraphicsStateMachine.stateMachineArn,
      description: 'Step Functions state machine for Reframe + Graphics workflow',
    });

    new cdk.CfnOutput(this, 'ReframeWithGraphicsEndpoint', {
      value: api.url + 'actions/reframe-with-graphics',
      description: 'Mimir Reframe + Graphics Custom Action Endpoint URL',
    });

    new cdk.CfnOutput(this, 'LottieTemplatesBucketName', {
      value: lottieTemplatesBucket.bucketName,
      description: 'S3 bucket for Lottie animation templates',
    });
  }
}
