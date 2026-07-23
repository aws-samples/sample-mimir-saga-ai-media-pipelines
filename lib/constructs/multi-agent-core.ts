import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { AgentCore, AgentCoreProps } from './agentcore';

export interface AgentConfig {
  readonly name: string;
  readonly sourceCodePath: string;
  readonly enableLongTermMemory?: boolean;
  readonly eventExpiryDuration?: number;
  /**
   * Additional environment variables to set on this agent's AgentCore Runtime.
   */
  readonly environmentVariables?: Record<string, string>;
  /**
   * Protocol configuration for the AgentCore Runtime.
   * Use 'HTTP' for Strands agents, 'MCP' for MCP servers.
   * Defaults to 'HTTP'.
   */
  readonly protocolConfiguration?: 'HTTP' | 'MCP';
}

export interface MultiAgentCoreProps {
  readonly agents: AgentConfig[];
  readonly projectName?: string;
  readonly sharedMemoryExecutionRoleArn?: string;
}

export class MultiAgentCore extends Construct {
  public readonly agents: Map<string, AgentCore> = new Map();
  public readonly runtimeArns: Map<string, string> = new Map();
  public readonly sharedMemoryId: string;
  public readonly sharedMemoryExecutionRole: iam.IRole;

  constructor(scope: Construct, id: string, props: MultiAgentCoreProps) {
    super(scope, id);

    const region = cdk.Stack.of(this).region;
    const account = cdk.Stack.of(this).account;
    const projectName = props.projectName || 'editor-agent';

    // Create shared memory execution role if not provided
    this.sharedMemoryExecutionRole = props.sharedMemoryExecutionRoleArn ? 
      iam.Role.fromRoleArn(this, 'SharedMemoryExecutionRole', props.sharedMemoryExecutionRoleArn) :
      new iam.Role(this, 'SharedMemoryExecutionRole', {
        assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonBedrockFullAccess')
        ]
      });

    // Add comprehensive permissions to shared role
    if (!props.sharedMemoryExecutionRoleArn) {
      const role = this.sharedMemoryExecutionRole as iam.Role;
      
      // ECR permissions
      role.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ecr:GetAuthorizationToken', 'ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'],
        resources: ['*']
      }));

      // S3 permissions for saga-feeds buckets
      role.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:ListBucket', 's3:PutObject'],
        resources: [
          `arn:aws:s3:::saga-feeds-source-${account}-${region}`,
          `arn:aws:s3:::saga-feeds-source-${account}-${region}/*`,
          `arn:aws:s3:::saga-feeds-processed-${account}-${region}`,
          `arn:aws:s3:::saga-feeds-processed-${account}-${region}/*`
        ]
      }));

      // CloudWatch and X-Ray permissions
      role.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords', 'logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'cloudwatch:PutMetricData'],
        resources: ['*']
      }));

      // Step Functions callback permissions
      role.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['states:SendTaskSuccess', 'states:SendTaskFailure', 'states:SendTaskHeartbeat'],
        resources: ['*']
      }));

      // AgentCore Memory permissions
      role.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock-agentcore:CreateEvent', 'bedrock-agentcore:GetEvent', 'bedrock-agentcore:ListEvents', 'bedrock-agentcore:DeleteEvent'],
        resources: [`arn:aws:bedrock-agentcore:${region}:${account}:memory/*`]
      }));
    }

    // Create single shared memory for all agents
    const sharedMemory = new cdk.CfnResource(this, 'SharedMemory', {
      type: 'AWS::BedrockAgentCore::Memory',
      properties: {
        Name: `${projectName.replace(/-/g, '_')}_shared_memory`,
        Description: `Shared memory for all ${projectName} agents`,
        EventExpiryDuration: 365,
        MemoryExecutionRoleArn: this.sharedMemoryExecutionRole.roleArn
      }
    });

    this.sharedMemoryId = sharedMemory.ref;

    // Store shared memory parameters
    new ssm.StringParameter(this, 'SharedMemoryIdParameter', {
      parameterName: `/agentcore/shared/memory-id`,
      stringValue: cdk.Fn.select(1, cdk.Fn.split('/', this.sharedMemoryId)),
      description: `Shared AgentCore Memory ID for ${projectName}`
    });

    new ssm.StringParameter(this, 'SharedMemoryExecutionRoleParameter', {
      parameterName: `/agentcore/shared/memory-execution-role-arn`,
      stringValue: this.sharedMemoryExecutionRole.roleArn,
      description: `Shared AgentCore Memory Execution Role ARN for ${projectName}`
    });

    // Deploy each agent with shared memory
    props.agents.forEach((agentConfig, index) => {
      const agentCore = new AgentCore(this, `Agent${index}`, {
        agentName: agentConfig.name,
        sourceCodePath: agentConfig.sourceCodePath,
        enableLongTermMemory: agentConfig.enableLongTermMemory ?? true,
        eventExpiryDuration: agentConfig.eventExpiryDuration,
        memoryExecutionRoleArn: this.sharedMemoryExecutionRole.roleArn,
        sharedMemoryId: this.sharedMemoryId,
        environmentVariables: agentConfig.environmentVariables,
        protocolConfiguration: agentConfig.protocolConfiguration,
      });

      // Store references
      this.agents.set(agentConfig.name, agentCore);
      this.runtimeArns.set(agentConfig.name, agentCore.runtimeArn);

      // Create outputs for each agent runtime
      new cdk.CfnOutput(this, `${this.normalizeOutputName(agentConfig.name)}RuntimeArn`, {
        value: agentCore.runtimeArn,
        description: `${agentConfig.name} Agent Runtime ARN`
      });
    });

    // Create shared memory output
    new cdk.CfnOutput(this, 'SharedMemoryId', {
      value: this.sharedMemoryId,
      description: `Shared Memory ID for all ${projectName} agents`
    });
  }

  private normalizeOutputName(name: string): string {
    return name
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join('');
  }

  public getAgent(name: string): AgentCore | undefined {
    return this.agents.get(name);
  }

  public getRuntimeArn(name: string): string | undefined {
    return this.runtimeArns.get(name);
  }
}
