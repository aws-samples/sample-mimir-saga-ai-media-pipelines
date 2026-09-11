import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { MultiAgentCore } from './constructs/multi-agent-core';

export interface AgentCoreStackProps extends cdk.StackProps {
  // Product display name, e.g. "Mimir Saga AI"
  productName: string;
  // Product acronym used to prefix resource names, e.g. "MSAI"
  acronym: string;
}

export class AgentCoreStack extends cdk.Stack {
  public readonly multiAgentCore: MultiAgentCore;

  constructor(scope: Construct, id: string, props: AgentCoreStackProps) {
    super(scope, id, props);

    // Resource naming prefix derived from the product acronym (e.g. "msai")
    const resourcePrefix = props.acronym.toLowerCase();

    // Read secret ARNs and vector bucket name from SSM (exported by InfrastructureStack)
    const mimirApiKeySecretArn = ssm.StringParameter.valueForStringParameter(
      this, '/infrastructure/mimir-api-key-arn'
    );
    const sagaApiKeySecretArn = ssm.StringParameter.valueForStringParameter(
      this, '/infrastructure/saga-api-key-arn'
    );
    const sagaApiUrlSecretArn = ssm.StringParameter.valueForStringParameter(
      this, '/infrastructure/saga-api-url-arn'
    );
    const vectorBucketName = ssm.StringParameter.valueForStringParameter(
      this, '/infrastructure/vector-bucket-name'
    );
    const videoStagingBucketName = ssm.StringParameter.valueForStringParameter(
      this, '/infrastructure/video-staging-bucket-name'
    );
    const mediaAnalysisBucketName = ssm.StringParameter.valueForStringParameter(
      this, '/infrastructure/media-analysis-bucket-name'
    );

    // Deploy agents on AgentCore Runtime
    this.multiAgentCore = new MultiAgentCore(this, 'MultiAgentCore', {
      projectName: 'fonn-group-custom-actions',
      agents: [
        {
          name: 'xml-processor-agent',
          sourceCodePath: './agents/xml-processor-agent',
          enableLongTermMemory: true
        },
        {
          name: 'rough-cut-agent',
          sourceCodePath: './agents/rough-cut-agent',
          enableLongTermMemory: true,
          environmentVariables: {
            MIMIR_API_KEY_SECRET_ARN: mimirApiKeySecretArn,
            SAGA_API_KEY_SECRET_ARN: sagaApiKeySecretArn,
            SAGA_API_URL_SECRET_ARN: sagaApiUrlSecretArn,
            VECTOR_BUCKET_NAME: vectorBucketName,
            VECTOR_INDEX_NAME: 'video-embeddings-index',
            TRANSCRIPT_STAGING_BUCKET: videoStagingBucketName,
            STABILITY_BUCKET: mediaAnalysisBucketName,
            POLLY_VOICE_ID: 'Matthew',
            AGENT_MODEL_ID: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
          },
        },
        {
          name: 'mimir-mcp-server',
          sourceCodePath: './agents/mimir-mcp-server',
          enableLongTermMemory: false,
          protocolConfiguration: 'MCP',
          environmentVariables: {
            MIMIR_API_BASE: 'https://us.mjoll.no',
            MIMIR_API_KEY_SECRET_ARN: mimirApiKeySecretArn,
            SAGA_API_KEY_SECRET_ARN: sagaApiKeySecretArn,
            SAGA_API_URL_SECRET_ARN: sagaApiUrlSecretArn,
          },
        }
      ]
    });

    // Add IAM permissions to the shared execution role for rough-cut-agent needs
    const sharedRole = this.multiAgentCore.sharedMemoryExecutionRole as iam.Role;

    // Grant permission to read secrets from Secrets Manager
    sharedRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [mimirApiKeySecretArn, sagaApiKeySecretArn, sagaApiUrlSecretArn],
    }));

    // Grant S3 Vectors permissions for querying and putting vectors
    sharedRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3vectors:QueryVectors', 's3vectors:PutVectors', 's3vectors:GetVectors', 's3vectors:ListVectors'],
      resources: ['*'],
    }));

    // Grant S3 read access to the video staging bucket (transcripts) and the
    // durable media-analysis bucket (camera-stability maps).
    sharedRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject'],
      resources: [
        `arn:aws:s3:::${resourcePrefix}-video-embedding-staging-*/*`,
        `arn:aws:s3:::${resourcePrefix}-media-analysis-*/*`,
      ],
    }));

    // Grant Polly permissions for voice-over synthesis
    sharedRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['polly:SynthesizeSpeech'],
      resources: ['*'],
    }));

    // Grant S3 write access to the staging bucket for voice-over audio files
    sharedRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:PutObject'],
      resources: [`arn:aws:s3:::${resourcePrefix}-video-embedding-staging-*/*`],
    }));

    // Export agent registry for other stacks
    new cdk.CfnOutput(this, 'DeployedAgents', {
      value: JSON.stringify(Array.from(this.multiAgentCore.runtimeArns.keys())),
      description: 'List of deployed agent names'
    });

    new cdk.CfnOutput(this, 'XmlProcessorAgentRuntimeArn', {
      value: this.multiAgentCore.getRuntimeArn('xml-processor-agent') || '',
      description: 'XML Processor Agent Runtime ARN for XML processing'
    });

    new cdk.CfnOutput(this, 'RoughCutAgentRuntimeArn', {
      value: this.multiAgentCore.getRuntimeArn('rough-cut-agent') || '',
      description: 'Rough Cut Agent Runtime ARN for rough cut timeline generation'
    });

    // Store rough-cut-agent runtime ARN in SSM for cross-stack reference
    new ssm.StringParameter(this, 'RoughCutAgentRuntimeArnParameter', {
      parameterName: '/fonn-custom-actions/agentcore/rough-cut-agent/runtime-arn',
      stringValue: this.multiAgentCore.getRuntimeArn('rough-cut-agent') || '',
      description: 'Rough Cut Agent Runtime ARN'
    });

    // Store mimir-mcp-server runtime ARN in SSM
    new ssm.StringParameter(this, 'MimirMcpServerRuntimeArnParameter', {
      parameterName: '/fonn-custom-actions/agentcore/mimir-mcp-server/runtime-arn',
      stringValue: this.multiAgentCore.getRuntimeArn('mimir-mcp-server') || '',
      description: 'Mimir MCP Server Runtime ARN'
    });

    new cdk.CfnOutput(this, 'MimirMcpServerRuntimeArn', {
      value: this.multiAgentCore.getRuntimeArn('mimir-mcp-server') || '',
      description: 'Mimir MCP Server Runtime ARN for Quick Suite integration'
    });
  }
}
