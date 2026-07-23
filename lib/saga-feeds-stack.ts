import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as stepfunctionsTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';


export interface SagaFeedsStackProps extends cdk.StackProps {
  // Product display name, e.g. "Mimir Saga AI"
  productName: string;
  // Product acronym used to prefix resource names, e.g. "MSAI"
  acronym: string;
}

export class SagaFeedsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SagaFeedsStackProps) {
    super(scope, id, props);

    // Resource naming prefix derived from the product acronym (e.g. "msai")
    const resourcePrefix = props.acronym.toLowerCase();

    // Read configuration from CDK context (populated from parameters.json in bin/)
    const sagaApiUrl = this.node.tryGetContext('sagaApiUrl') || 'https://us.mjoll.no';
    const sagaApiKey = this.node.tryGetContext('sagaApiKey') || 'placeholder-update-after-deployment';

    // Table name prefixed to avoid collisions in shared accounts
    const sagaFeedItemsTableName = `${resourcePrefix}-saga-feed-items`;

    // Create Saga secrets
    const sagaApiKeySecret = new secretsmanager.Secret(this, 'SagaApiKey', {
      description: 'API key for calling Saga API',
      secretStringValue: cdk.SecretValue.unsafePlainText(sagaApiKey),
    });

    const sagaApiUrlSecret = new secretsmanager.Secret(this, 'SagaApiUrl', {
      description: 'Base URL for Saga API',
      secretStringValue: cdk.SecretValue.unsafePlainText(sagaApiUrl),
    });

    // Import Mimir API key secret from InfrastructureStack via Parameter Store
    const mimirApiKeySecretArn = ssm.StringParameter.valueForStringParameter(
      this,
      '/infrastructure/mimir-api-key-arn'
    );

    const mimirApiKeySecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'MimirApiKey',
      mimirApiKeySecretArn
    );

    // S3 Buckets - separate buckets for ABC and FOX
    const abcSourceBucket = new s3.Bucket(this, 'AbcFeedsSourceBucket', {
      bucketName: `${resourcePrefix}-saga-feeds-abc-source-${this.account}-${this.region}`,
      eventBridgeEnabled: true,
      enforceSSL: true,
    });

    const foxSourceBucket = new s3.Bucket(this, 'FoxFeedsSourceBucket', {
      bucketName: `${resourcePrefix}-saga-feeds-fox-source-${this.account}-${this.region}`,
      eventBridgeEnabled: true,
      enforceSSL: true,
    });

    const destinationBucket = new s3.Bucket(this, 'FeedsDestinationBucket', {
      bucketName: `${resourcePrefix}-saga-feeds-processed-${this.account}-${this.region}`,
      enforceSSL: true,
    });

    const moveFileToProcessedLambda = new lambda.Function(this, 'MoveFileToProcessedLambda', {
      functionName: `${resourcePrefix}-move-file-to-processed`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/move-file-to-processed'),
      timeout: cdk.Duration.minutes(2),
      environment: {
        DESTINATION_BUCKET: destinationBucket.bucketName
      }
    });

    // Lambda Functions
    const parseXmlFeedDataLambda = new lambda.Function(this, 'ParseXmlFeedDataLambda', {
      functionName: `${resourcePrefix}-parse-xml-feeddata`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/parse-xml-feeddata'),
      timeout: cdk.Duration.minutes(2),
      environment: {
        DESTINATION_BUCKET: destinationBucket.bucketName
      }
    });

    // AgentCore Lambda Functions
    const getAgentcoreParametersLambda = new lambda.Function(this, 'GetAgentcoreParametersLambda', {
      functionName: `${resourcePrefix}-get-agentcore-parameters`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/get-agentcore-parameters'),
      timeout: cdk.Duration.seconds(30),
      environment: {
        LOG_LEVEL: 'INFO'
      }
    });

    const invokeXmlProcessorAgentLambda = new lambda.Function(this, 'InvokeXmlProcessorAgentLambda', {
      functionName: `${resourcePrefix}-invoke-xml-processor-agent`,
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset('lambda/invoke-xml-processor-agent'),
      timeout: cdk.Duration.minutes(2),
      environment: {
        LOG_LEVEL: 'INFO'
      }
    });

    // Import the mimir-asset-handler lambda
    const mimirAssetHandlerLambda = new lambda.Function(this, 'MimirAssetHandlerLambda', {
      functionName: `${resourcePrefix}-mimir-asset-handler`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/mimir-asset-handler'),
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: {
        OUTPUT_BUCKET_NAME: destinationBucket.bucketName,
        MIMIR_API_KEY_SECRET_ARN: mimirApiKeySecret.secretArn,
        // Optional JSON map of content provider -> Mimir visibility group id.
        // When empty, created items use the tenant's default visibility.
        VISIBILITY_GROUP_MAP: this.node.tryGetContext('visibilityGroupMap') || ''
      }
    });

    const mimirDetailsHandlerLambda = new lambda.Function(this, 'MimirDetailsHandlerLambda', {
      functionName: `${resourcePrefix}-mimir-details-handler`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/mimir-details-handler'),
      timeout: cdk.Duration.seconds(30),
      environment: {
        MIMIR_API_KEY_SECRET_ARN: mimirApiKeySecret.secretArn
      }
    });

    const updateMimirTitleLambda = new lambda.Function(this, 'UpdateMimirTitleLambda', {
      functionName: `${resourcePrefix}-update-mimir-title`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/update-mimir-title'),
      timeout: cdk.Duration.seconds(30),
      environment: {
        MIMIR_API_KEY_SECRET_ARN: mimirApiKeySecret.secretArn
      }
    });

    const sagaFeedLambda = new lambda.Function(this, 'SagaFeedLambda', {
      functionName: `${resourcePrefix}-saga-feed-handler`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/saga-feed-handler'),
      timeout: cdk.Duration.minutes(2),
      environment: {
        SAGA_API_KEY_SECRET_ARN: sagaApiKeySecret.secretArn,
        SAGA_API_URL_SECRET_ARN: sagaApiUrlSecret.secretArn
      }
    });

    // Permissions
    abcSourceBucket.grantRead(parseXmlFeedDataLambda);
    foxSourceBucket.grantRead(parseXmlFeedDataLambda);
    abcSourceBucket.grantRead(invokeXmlProcessorAgentLambda);
    foxSourceBucket.grantRead(invokeXmlProcessorAgentLambda);
    abcSourceBucket.grantRead(moveFileToProcessedLambda);
    foxSourceBucket.grantRead(moveFileToProcessedLambda);
    abcSourceBucket.grantDelete(moveFileToProcessedLambda);
    foxSourceBucket.grantDelete(moveFileToProcessedLambda);
    destinationBucket.grantRead(parseXmlFeedDataLambda);
    destinationBucket.grantRead(invokeXmlProcessorAgentLambda);
    destinationBucket.grantRead(sagaFeedLambda);
    destinationBucket.grantReadWrite(mimirAssetHandlerLambda);
    destinationBucket.grantWrite(moveFileToProcessedLambda);
    mimirApiKeySecret.grantRead(mimirAssetHandlerLambda);
    mimirApiKeySecret.grantRead(mimirDetailsHandlerLambda);
    mimirApiKeySecret.grantRead(updateMimirTitleLambda);
    sagaApiKeySecret.grantRead(sagaFeedLambda);
    sagaApiUrlSecret.grantRead(sagaFeedLambda);

    // Grant SSM Parameter Store read access for AgentCore parameters
    getAgentcoreParametersLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/agentcore/shared/memory-id`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/agentcore/xml_processor_agent/runtime-arn`
      ]
    }));

    invokeXmlProcessorAgentLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock-agentcore:InvokeAgentRuntime',
        'states:SendTaskSuccess',
        'states:SendTaskFailure',
        'ssm:GetParameter'
      ],
      resources: ['*']
    }));

    // Step Functions Tasks
    const moveFileToProcessedTask = new stepfunctionsTasks.LambdaInvoke(this, 'MoveFileToProcessedBucket', {
      lambdaFunction: moveFileToProcessedLambda,
      resultPath: '$.moveResult'
    });

    const parseXmlFeedDataTask = new stepfunctionsTasks.LambdaInvoke(this, 'ParseXmlFeedData', {
      lambdaFunction: parseXmlFeedDataLambda,
      payload: stepfunctions.TaskInput.fromObject({
        'processedFile.$': '$.moveResult.Payload.processedFile',
        'originalEvent.$': '$'
      }),
      outputPath: '$.Payload'
    });

    const getAgentcoreParametersTask = new stepfunctionsTasks.LambdaInvoke(this, 'GetAgentcoreParametersTask', {
      lambdaFunction: getAgentcoreParametersLambda,
      outputPath: '$.Payload'
    });

    const invokeXmlProcessorAgentTask = new stepfunctionsTasks.LambdaInvoke(this, 'InvokeXmlProcessorAgent', {
      lambdaFunction: invokeXmlProcessorAgentLambda,
      integrationPattern: stepfunctions.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: stepfunctions.TaskInput.fromObject({
        'TaskToken': stepfunctions.JsonPath.taskToken,
        'feedData.$': '$.feedData'  // Pass feedData from the state
      }),
      resultPath: '$.agentResult',  // Store agent result in agentResult field
      taskTimeout: stepfunctions.Timeout.duration(cdk.Duration.minutes(5))
    });

    const createSagaFeedTask = new stepfunctionsTasks.LambdaInvoke(this, 'CreateSagaFeed', {
      lambdaFunction: sagaFeedLambda,
      outputPath: '$.Payload'
    });

    const uploadToMimirTask = new stepfunctionsTasks.LambdaInvoke(this, 'UploadToMimir', {
      lambdaFunction: mimirAssetHandlerLambda,
      inputPath: '$',
      resultPath: '$.mimirUploadResult'
    });

    const getMimirDetailsTask = new stepfunctionsTasks.LambdaInvoke(this, 'GetMimirDetails', {
      lambdaFunction: mimirDetailsHandlerLambda,
      payload: stepfunctions.TaskInput.fromObject({
        'id.$': '$.mimirUploadResult.Payload.mimirItemId'
      }),
      resultPath: '$.mimirDetailsResult'
    });

    const definition = {
      "Comment": "Saga Feeds Ingestion with variables",
      "QueryLanguage": "JSONata",
      "StartAt": "MoveFileToProcessedBucket",
      "States": {
        "MoveFileToProcessedBucket": {
          "Type": "Task",
          "Resource": "arn:aws:states:::lambda:invoke",
          "Arguments": {
            "FunctionName": moveFileToProcessedLambda.functionArn,
            "Payload": "{% $states.input %}"
          },
          "Assign": {
            "processedBucket": "{% $states.result.Payload.processedFile.destinationBucket %}",
            "processedKey": "{% $states.result.Payload.processedFile.destinationKey %}",
            "provider": "{% $states.result.Payload.processedFile.provider %}",
            "fileName": "{% $states.input.detail.object.key %}"
          },
          "Next": "CheckExistingFeed"
        },
        "CheckExistingFeed": {
          "Type": "Task", 
          "Resource": "arn:aws:states:::dynamodb:updateItem",
          "Arguments": {
            "TableName": sagaFeedItemsTableName,
            "Key": {
              "title": {"S": "{% $substring($fileName, 0, 9) %}"}
            },
            "UpdateExpression": "SET processedAt = :timestamp",
            "ExpressionAttributeValues": {
              ":timestamp": {"S": "{% $now() %}"}
            },
            "ReturnValues": "ALL_NEW"
          },
          "Assign": {
            "existingFeed": "{% $states.result.Attributes ~> $each(function($v) { $v.S ? $v.S : ($v.N ? $number($v.N) : ($v.BOOL ? $v.BOOL : $v)) }) %}"
          },
          "Next": "FileTypeChoice"
        },
        "FileTypeChoice": {
          "Type": "Choice",
          "Choices": [
            {
              "Condition": "{% $fileName ~> $contains('.xml') %}",
              "Next": "ParseXmlFeedData"
            },
            {
              "Condition": "{% $fileName ~> $contains('.mp4') %}",
              "Next": "UploadToMimir"
            }
          ],
          "Default": "UnsupportedFileType"
        },
        "ParseXmlFeedData": {
          "Type": "Task",
          "Resource": "arn:aws:states:::lambda:invoke",
          "Arguments": {
            "FunctionName": parseXmlFeedDataLambda.functionArn,
            "Payload": {
              "processedFile": {
                "destinationBucket": "{% $processedBucket %}",
                "destinationKey": "{% $processedKey %}",
                "provider": "{% $provider %}",
                "fileName": "{% $fileName %}"
              }
            }
          },
          "Assign": {
            "feedData": "{% $states.result.Payload.feedData %}",
            "uri": "{% $states.result.Payload.feedData.uri %}",
            "headline": "{% $states.result.Payload.feedData.headline %}",
            "bodyText": "{% $states.result.Payload.feedData.body_text %}",
            "firstCreated": "{% $states.result.Payload.feedData.firstcreated %}",
            "versionCreated": "{% $states.result.Payload.feedData.versioncreated %}",
            "xmlKey": "{% $states.result.Payload.feedData.xmlKey %}",
            "destinationBucket": "{% $states.result.Payload.feedData.destinationBucket %}",
            "processedXmlKey": "{% $states.result.Payload.feedData.processedXmlKey %}"
          },
          "Output": "{% $states.result.Payload %}",
          "Next": "InvokeXmlProcessorAgent"
        },
        "InvokeXmlProcessorAgent": {
          "Type": "Task",
          "Resource": "arn:aws:states:::lambda:invoke.waitForTaskToken",
          "Arguments": {
            "FunctionName": invokeXmlProcessorAgentLambda.functionArn,
            "Payload": {
              "TaskToken": "{% $states.context.Task.Token %}",
              "feedData": "{% $feedData %}"
            }
          },
          "Assign": {
            "agentResult": "{% $states.result %}"
          },
          "TimeoutSeconds": 300,
          "Next": "SaveFeedData"
        },
        "SaveFeedData": {
          "Type": "Task",
          "Resource": "arn:aws:states:::dynamodb:updateItem",
          "Arguments": {
            "TableName": sagaFeedItemsTableName,
            "Key": {
              "title": {"S": "{% $uri %}"}
            },
            "UpdateExpression": "SET uri = :uri, provider = :provider, infosource = :infosource, versioncreated = :versioncreated, firstcreated = :firstcreated, #ver = :version, revision = :revision, pubstatus = :pubstatus, urgency = :urgency, priority = :priority, #lang = :language, slugline = :slugline, headline = :headline, description_html = :description_html, body_html = :body_html, located = :located, places = :places, people = :people, keywords = :keywords, #sec = :section, ednotes = :ednotes, copyrightnotice = :copyrightnotice, usageterms = :usageterms, #ttl = :ttl, processedAt = :processedAt, hasXml = :hasXml, hasVideo = :hasVideo, xmlProcessCount = :xmlProcessCount",
            "ExpressionAttributeNames": {
              "#lang": "language",
              "#sec": "section",
              "#ver": "version",
              "#ttl": "ttl"
            },
            "ExpressionAttributeValues": {
              ":uri": {"S": "{% $agentResult.mappedFeedData.uri ? $agentResult.mappedFeedData.uri : $uri %}"},
              ":provider": {"S": "{% $agentResult.mappedFeedData.provider ? $agentResult.mappedFeedData.provider : $provider %}"},
              ":infosource": {"S": "{% $agentResult.mappedFeedData.infosource ? $agentResult.mappedFeedData.infosource : '' %}"},
              ":versioncreated": {"S": "{% $agentResult.mappedFeedData.versioncreated ? $agentResult.mappedFeedData.versioncreated : $versionCreated %}"},
              ":firstcreated": {"S": "{% $agentResult.mappedFeedData.firstcreated ? $agentResult.mappedFeedData.firstcreated : $firstCreated %}"},
              ":version": {"S": "{% $agentResult.mappedFeedData.version ? $string($agentResult.mappedFeedData.version) : '' %}"},
              ":revision": {"N": "{% $agentResult.mappedFeedData.revision ? $string($agentResult.mappedFeedData.revision) : '1' %}"},
              ":pubstatus": {"S": "{% $agentResult.mappedFeedData.pubstatus ? $agentResult.mappedFeedData.pubstatus : '' %}"},
              ":urgency": {"N": "{% $agentResult.mappedFeedData.urgency ? $string($agentResult.mappedFeedData.urgency) : '3' %}"},
              ":priority": {"N": "{% $agentResult.mappedFeedData.priority ? $string($agentResult.mappedFeedData.priority) : '3' %}"},
              ":language": {"S": "{% $agentResult.mappedFeedData.language ? $agentResult.mappedFeedData.language : 'en' %}"},
              ":slugline": {"S": "{% $agentResult.mappedFeedData.slugline ? $agentResult.mappedFeedData.slugline : '' %}"},
              ":headline": {"S": "{% $agentResult.mappedFeedData.headline ? $agentResult.mappedFeedData.headline : $headline %}"},
              ":description_html": {"S": "{% $agentResult.mappedFeedData.description_html ? $agentResult.mappedFeedData.description_html : '' %}"},
              ":body_html": {"S": "{% $agentResult.mappedFeedData.body_html ? $agentResult.mappedFeedData.body_html : $bodyText %}"},
              ":located": {"S": "{% $agentResult.mappedFeedData.located ? $agentResult.mappedFeedData.located : '' %}"},
              ":places": {"S": "{% $agentResult.mappedFeedData.places ? $string($agentResult.mappedFeedData.places) : '[]' %}"},
              ":people": {"S": "{% $agentResult.mappedFeedData.people ? $string($agentResult.mappedFeedData.people) : '[]' %}"},
              ":keywords": {"S": "{% $agentResult.mappedFeedData.keywords ? $string($agentResult.mappedFeedData.keywords) : '[]' %}"},
              ":section": {"S": "{% $agentResult.mappedFeedData.section ? $agentResult.mappedFeedData.section : '' %}"},
              ":ednotes": {"S": "{% $agentResult.mappedFeedData.ednotes ? $agentResult.mappedFeedData.ednotes : '' %}"},
              ":copyrightnotice": {"S": "{% $agentResult.mappedFeedData.copyrightnotice ? $agentResult.mappedFeedData.copyrightnotice : '' %}"},
              ":usageterms": {"S": "{% $agentResult.mappedFeedData.usageterms ? $agentResult.mappedFeedData.usageterms : '' %}"},
              ":ttl": {"N": "{% $agentResult.mappedFeedData.ttl ? $string($agentResult.mappedFeedData.ttl) : '0' %}"},
              ":processedAt": {"S": "{% $now() %}"},
              ":hasXml": {"BOOL": true},
              ":hasVideo": {"BOOL": "{% $existingFeed and $existingFeed.hasVideo and $existingFeed.hasVideo = true %}"},
              ":xmlProcessCount": {"N": "{% $existingFeed and $existingFeed.xmlProcessCount ? $string($number($existingFeed.xmlProcessCount) + 1) : '1' %}"}
            },
            "ReturnValues": "ALL_NEW"
          },
          "Assign": {
            "hasVideo": "{% $states.result.Attributes.hasVideo %}",
            "mimirItemId": "{% $existingFeed.mimirItemId ? $existingFeed.mimirItemId : null %}",
            "xmlProcessCount": "{% $states.result.Attributes.xmlProcessCount %}"
          },
          "Next": "CheckVideoForTitleUpdate"
        },
        "CheckVideoForTitleUpdate": {
          "Type": "Choice",
          "Choices": [
            {
              "Condition": "{% $hasVideo and $hasVideo = true and $mimirItemId and $xmlProcessCount and $xmlProcessCount = 1 %}",
              "Next": "UpdateMimirTitle"
            }
          ],
          "Default": "CreateSagaFeed"
        },
        "UpdateMimirTitle": {
          "Type": "Task",
          "Resource": "arn:aws:states:::lambda:invoke",
          "Arguments": {
            "FunctionName": updateMimirTitleLambda.functionArn,
            "Payload": {
              "mimirItemId": "{% $existingFeed.mimirItemId %}",
              "newTitle": "{% $agentResult.mappedFeedData.slugline ? $agentResult.mappedFeedData.slugline : $agentResult.mappedFeedData.headline %}"
            }
          },
          "Next": "CreateSagaFeed"
        },
        "CreateSagaFeed": {
          "Type": "Task",
          "Resource": "arn:aws:states:::lambda:invoke",
          "Arguments": {
            "FunctionName": sagaFeedLambda.functionArn,
            "Payload": {
              "mappedFeedData": "{% $agentResult ? $agentResult.mappedFeedData : $existingFeed %}",
              "mimirDetailsResult": "{% $mimirDetailsResult ? $mimirDetailsResult : null %}"
            }
          },
          "Output": "{% $states.result.Payload %}",
          "End": true
        },
        "UploadToMimir": {
          "Type": "Task",
          "Resource": "arn:aws:states:::lambda:invoke",
          "Arguments": {
            "FunctionName": mimirAssetHandlerLambda.functionArn,
            "Payload": {
              "feedData": {
                "actualMp4Key": "{% $processedKey %}",
                "destinationBucket": "{% $processedBucket %}",
                "provider": "{% $provider %}",
                "title": "{% $substring($fileName, 0, 9) %}"
              },
              "mappedFeedData": {
                "provider": "{% $existingFeed and $existingFeed.provider ? $existingFeed.provider : $provider %}",
                "headline": "{% $existingFeed and $existingFeed.headline ? $existingFeed.headline : ($fileName ? $substring($fileName, 0, $length($fileName) - 4) : 'Video Upload') %}",
                "slugline": "{% $existingFeed and $existingFeed.slugline ? $existingFeed.slugline : null %}"
              }
            }
          },
          "Assign": {
            "mimirUploadResult": "{% $states.result %}"
          },
          "Next": "WaitForMimirProcessing"
        },
        "WaitForMimirProcessing": {
          "Type": "Wait",
          "Seconds": 15,
          "Next": "GetMimirDetails"
        },
        "GetMimirDetails": {
          "Type": "Task",
          "Resource": "arn:aws:states:::lambda:invoke",
          "Arguments": {
            "FunctionName": mimirDetailsHandlerLambda.functionArn,
            "Payload": {
              "id": "{% $mimirUploadResult.Payload.mimirItemId %}"
            }
          },
          "Assign": {
            "mimirDetailsResult": "{% $states.result %}"
          },
          "Next": "SaveVideoFeedData"
        },
        "SaveVideoFeedData": {
          "Type": "Task",
          "Resource": "arn:aws:states:::dynamodb:updateItem",
          "Arguments": {
            "TableName": sagaFeedItemsTableName,
            "Key": {
              "title": {"S": "{% $substring($fileName, 0, 9) %}"}
            },
            "UpdateExpression": "SET mimirItemId = :mimirItemId, highResUrl = :highResUrl, thumbnailUrl = :thumbnailUrl, processedAt = :processedAt, hasVideo = :hasVideo, mp4ProcessCount = :mp4ProcessCount",
            "ExpressionAttributeValues": {
              ":mimirItemId": {"S": "{% $mimirUploadResult.Payload.mimirItemId %}"},
              ":highResUrl": {"S": "{% $mimirDetailsResult.Payload.highResUrl ? $mimirDetailsResult.Payload.highResUrl : '' %}"},
              ":thumbnailUrl": {"S": "{% $mimirDetailsResult.Payload.thumbnailUrl ? $mimirDetailsResult.Payload.thumbnailUrl : '' %}"},
              ":processedAt": {"S": "{% $now() %}"},
              ":hasVideo": {"BOOL": true},
              ":mp4ProcessCount": {"N": "{% $existingFeed and $existingFeed.mp4ProcessCount ? $string($number($existingFeed.mp4ProcessCount) + 1) : '1' %}"}
            }
          },
          "Next": "CheckXmlBeforeFeedCreation"
        },
        "CheckXmlBeforeFeedCreation": {
          "Type": "Choice",
          "Choices": [
            {
              "Condition": "{% $existingFeed and $existingFeed.hasXml and $existingFeed.hasXml = true %}",
              "Next": "CreateSagaFeed"
            }
          ],
          "Default": "SkipFeedCreation"
        },
        "SkipFeedCreation": {
          "Type": "Pass",
          "Output": {
            "statusCode": 200,
            "message": "Video processed successfully, but skipping feed creation as no XML data is available",
            "feedUri": "skipped"
          },
          "End": true
        },
        "UnsupportedFileType": {
          "Type": "Fail",
          "Error": "UnsupportedFileType",
          "Cause": "Only .xml and .mp4 files are supported"
        }
      }
    };

    const stateMachine = new stepfunctions.StateMachine(this, 'SagaFeedsIngestionStateMachine', {
      // Removed explicit name to allow CloudFormation to replace the resource
      definitionBody: stepfunctions.DefinitionBody.fromString(JSON.stringify(definition)),
      stateMachineType: stepfunctions.StateMachineType.STANDARD,
      timeout: cdk.Duration.minutes(15),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'SagaFeedsIngestionLogs', { retention: logs.RetentionDays.ONE_MONTH }),
        level: stepfunctions.LogLevel.ALL
      }
    });

    // Grant Step Functions permissions to invoke Lambda functions
    moveFileToProcessedLambda.grantInvoke(stateMachine.role);
    parseXmlFeedDataLambda.grantInvoke(stateMachine.role);
    getAgentcoreParametersLambda.grantInvoke(stateMachine.role);
    invokeXmlProcessorAgentLambda.grantInvoke(stateMachine.role);
    mimirAssetHandlerLambda.grantInvoke(stateMachine.role);
    mimirDetailsHandlerLambda.grantInvoke(stateMachine.role);
    sagaFeedLambda.grantInvoke(stateMachine.role);
    updateMimirTitleLambda.grantInvoke(stateMachine.role);

    // Grant Step Functions permissions to access S3 buckets for copy/delete operations
    abcSourceBucket.grantRead(stateMachine.role);
    foxSourceBucket.grantRead(stateMachine.role);
    destinationBucket.grantReadWrite(stateMachine.role);
    
    // Grant DynamoDB permissions for SagaFeedItems table
    (stateMachine.role as iam.Role).addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem'
      ],
      resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${sagaFeedItemsTableName}`]
    }));
    
    // Grant additional S3 permissions for the CallAwsService tasks
    (stateMachine.role as iam.Role).addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:DeleteObject',
        's3:PutObject',
        's3:CopyObject'
      ],
      resources: [
        `${abcSourceBucket.bucketArn}/*`,
        `${foxSourceBucket.bucketArn}/*`,
        `${destinationBucket.bucketArn}/*`
      ]
    }));

    // EventBridge Rules to trigger state machine for both XML and MP4 files
    const s3EventRule = new events.Rule(this, 'S3FeedsEventRule', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: {
            name: [abcSourceBucket.bucketName, foxSourceBucket.bucketName]
          },
          object: {
            key: [
              { suffix: '.xml' },
              { suffix: '.mp4' }
            ]
          }
        }
      }
    });

    s3EventRule.addTarget(new targets.SfnStateMachine(stateMachine, {
      input: events.RuleTargetInput.fromEventPath('$')
    }));

    // Outputs
    new cdk.CfnOutput(this, 'SagaApiKeyArn', {
      value: sagaApiKeySecret.secretArn,
      description: 'ARN of the Saga API key secret'
    });

    new cdk.CfnOutput(this, 'SagaApiUrlArn', {
      value: sagaApiUrlSecret.secretArn,
      description: 'ARN of the Saga API URL secret'
    });

    new cdk.CfnOutput(this, 'AbcFeedsSourceBucketName', {
      value: abcSourceBucket.bucketName,
      description: 'Name of the ABC source S3 bucket for feeds'
    });

    new cdk.CfnOutput(this, 'FoxFeedsSourceBucketName', {
      value: foxSourceBucket.bucketName,
      description: 'Name of the FOX source S3 bucket for feeds'
    });

    new cdk.CfnOutput(this, 'FeedsStateMachineArn', {
      value: stateMachine.stateMachineArn,
      description: 'ARN of the feeds processing state machine'
    });
  }
}
