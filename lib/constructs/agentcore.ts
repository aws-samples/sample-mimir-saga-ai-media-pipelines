import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';

export interface AgentCoreProps {
  /**
   * Name of the agent (will be converted to underscore format)
   */
  readonly agentName: string;
  
  /**
   * Path to the agent source code directory
   */
  readonly sourceCodePath: string;
  
  /**
   * S3 bucket for storing source code (optional, will create if not provided)
   */
  readonly sourceBucket?: s3.IBucket;
  
  /**
   * Memory execution role ARN (required for memory strategies)
   */
  readonly memoryExecutionRoleArn?: string;
  
  /**
   * Event expiry duration in days (default: 30, max: 365)
   */
  readonly eventExpiryDuration?: number;
  
  /**
   * Enable long-term memory extraction (default: false)
   */
  readonly enableLongTermMemory?: boolean;

  /**
   * Shared memory ID to use instead of creating new memory
   */
  readonly sharedMemoryId?: string;

  /**
   * Additional environment variables to set on the AgentCore Runtime.
   * These are merged with the default AGENTCORE_MEMORY_ARN variable.
   */
  readonly environmentVariables?: Record<string, string>;

  /**
   * Protocol configuration for the AgentCore Runtime.
   * Use 'HTTP' for Strands agents, 'MCP' for MCP servers.
   * Defaults to 'HTTP'.
   */
  readonly protocolConfiguration?: 'HTTP' | 'MCP';
}

export class AgentCore extends Construct {
  public readonly runtimeArn: string;
  public readonly ecrRepository: ecr.Repository;
  public readonly memoryId: string;
  
  constructor(scope: Construct, id: string, props: AgentCoreProps) {
    super(scope, id);
    
    // Validate source code path exists
    const fs = require('fs');
    if (!fs.existsSync(props.sourceCodePath)) {
      throw new Error(`Source code path does not exist: ${props.sourceCodePath}`);
    }
    
    // Convert agent name to underscore format (like CLI does)
    const normalizedAgentName = props.agentName.replace(/-/g, '_');
    const region = cdk.Stack.of(this).region;
    const account = cdk.Stack.of(this).account;
    
    // Create memory execution role if not provided
    const memoryExecutionRole = props.memoryExecutionRoleArn ? 
      iam.Role.fromRoleArn(this, 'MemoryExecutionRole', props.memoryExecutionRoleArn) :
      new iam.Role(this, 'MemoryExecutionRole', {
        assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonBedrockFullAccess')
        ]
      });

    // Add ECR permissions for container image access
    if (!props.memoryExecutionRoleArn) {
      (memoryExecutionRole as iam.Role).addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchCheckLayerAvailability', 
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage'
        ],
        resources: ['*']
      }));

      // Add S3 permissions for accessing editor-agent media bucket
      (memoryExecutionRole as iam.Role).addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          's3:GetObject',
          's3:GetObjectVersion',
          's3:ListBucket'
        ],
        resources: [
          `arn:aws:s3:::editor-agent-media-${account}-${region}`,
          `arn:aws:s3:::editor-agent-media-${account}-${region}/*`
        ]
      }));

      // Add X-Ray permissions for AgentCore observability
      (memoryExecutionRole as iam.Role).addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'xray:PutTraceSegments',
          'xray:PutTelemetryRecords',
          'xray:GetSamplingRules',
          'xray:GetSamplingTargets'
        ],
        resources: ['*']
      }));

      // Add CloudWatch Logs permissions for AgentCore runtime logs (statement 1)
      (memoryExecutionRole as iam.Role).addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:DescribeLogStreams',
          'logs:CreateLogGroup'
        ],
        resources: [
          `arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/*`
        ]
      }));

      // Add CloudWatch Logs permissions (statement 2 - needs wildcard for DescribeLogGroups)
      (memoryExecutionRole as iam.Role).addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['logs:DescribeLogGroups'],
        resources: [`arn:aws:logs:${region}:${account}:log-group:*`]
      }));

      // Add CloudWatch Logs permissions (statement 3 - log stream level)
      (memoryExecutionRole as iam.Role).addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:CreateLogStream',
          'logs:PutLogEvents'
        ],
        resources: [
          `arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`
        ]
      }));

      // Add CloudWatch Metrics permissions
      (memoryExecutionRole as iam.Role).addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'cloudwatch:namespace': 'bedrock-agentcore'
          }
        }
      }));

      // Add CloudWatch Logs permissions for X-Ray spans (for V2 delivery)
      (memoryExecutionRole as iam.Role).addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents'
        ],
        resources: [
          `arn:aws:logs:${region}:${account}:log-group:/aws/spans:*`,
          `arn:aws:logs:${region}:${account}:log-group:aws/spans:*`
        ]
      }));

      // Add permission for AgentCore Runtime to allow vended log delivery
      (memoryExecutionRole as iam.Role).addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock-agentcore:AllowVendedLogDeliveryForResource'],
        resources: [`arn:aws:bedrock-agentcore:${region}:${account}:runtime/*`]
      }));

      // Add Step Functions callback permissions for async task token pattern
      (memoryExecutionRole as iam.Role).addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'states:SendTaskSuccess',
          'states:SendTaskFailure',
          'states:SendTaskHeartbeat'
        ],
        resources: ['*']
      }));

      // Add AgentCore Memory permissions for reading and writing events
      (memoryExecutionRole as iam.Role).addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:CreateEvent',
          'bedrock-agentcore:GetEvent',
          'bedrock-agentcore:ListEvents',
          'bedrock-agentcore:DeleteEvent'
        ],
        resources: [`arn:aws:bedrock-agentcore:${region}:${account}:memory/*`]
      }));
    }
    
    // Phase 1: Memory Resource (use shared or create new)
    let memory: cdk.CfnResource | undefined;
    
    if (props.sharedMemoryId) {
      // Use existing shared memory
      this.memoryId = props.sharedMemoryId;
      
      // Create agent-specific parameter pointing to shared memory
      new ssm.StringParameter(this, 'MemoryIdParameter', {
        parameterName: `/agentcore/${normalizedAgentName}/memory-id`,
        stringValue: cdk.Fn.select(1, cdk.Fn.split('/', this.memoryId)),
        description: `AgentCore Memory ID for ${props.agentName} (shared)`
      });
    } else {
      // Create dedicated memory (legacy behavior)
      memory = new cdk.CfnResource(this, 'Memory', {
        type: 'AWS::BedrockAgentCore::Memory',
        properties: {
          Name: `${normalizedAgentName}_memory`,
          Description: `Memory store for ${props.agentName} agent`,
          EventExpiryDuration: Math.min(props.eventExpiryDuration || 30, 365),
          MemoryExecutionRoleArn: memoryExecutionRole.roleArn
        }
      });
      
      this.memoryId = memory.ref;
      
      new ssm.StringParameter(this, 'MemoryIdParameter', {
        parameterName: `/agentcore/${normalizedAgentName}/memory-id`,
        stringValue: cdk.Fn.select(1, cdk.Fn.split('/', this.memoryId)),
        description: `AgentCore Memory ID for ${props.agentName}`
      });
    }
    
    new ssm.StringParameter(this, 'MemoryExecutionRoleParameter', {
      parameterName: `/agentcore/${normalizedAgentName}/memory-execution-role-arn`,
      stringValue: memoryExecutionRole.roleArn,
      description: `AgentCore Memory Execution Role ARN for ${props.agentName}`
    });
    
    new ssm.StringParameter(this, 'AgentNameParameter', {
      parameterName: `/agentcore/${normalizedAgentName}/agent-name`,
      stringValue: normalizedAgentName,
      description: `Normalized agent name for ${props.agentName}`
    });
    
    // Phase 2: ECR Repository and CodeBuild (matching CLI patterns)
    this.ecrRepository = new ecr.Repository(this, 'ECRRepository', {
      repositoryName: `bedrock-agentcore-${normalizedAgentName}`,
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For testing/dev cleanup
      emptyOnDelete: true, // Automatically delete images on stack deletion
      lifecycleRules: [{
        maxImageCount: 10,
        description: 'Keep only 10 most recent images'
      }]
    });
    
    // Note: We use S3 Assets (CDK bootstrap bucket) instead of a custom source bucket
    
    // Create source asset and reference it directly in CodeBuild
    const sourceAsset = new s3assets.Asset(this, 'SourceAsset', {
      path: props.sourceCodePath
    });

    // CodeBuild project matching CLI naming and build patterns
    const codeBuildProject = new codebuild.Project(this, 'CodeBuildProject', {
      projectName: `bedrock-agentcore-${normalizedAgentName}-builder`,
      source: codebuild.Source.s3({
        bucket: sourceAsset.bucket,
        path: sourceAsset.s3ObjectKey
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_ARM_3,
        computeType: codebuild.ComputeType.SMALL,
        privileged: true
      },
      // IMAGE_TAG = source asset hash. Each source change produces a unique tag,
      // so the runtime can be pointed at the EXACT image built for this deploy
      // (see RuntimeRefresher) instead of the mutable :latest — which eliminates
      // the redeploy race where the runtime refreshed before the new :latest was
      // pushed. Defaults to "latest" if not set.
      environmentVariables: {
        IMAGE_TAG: { value: sourceAsset.assetHash },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          build: {
            commands: [
              'echo "Building Docker image (tag: $IMAGE_TAG)..."',
              'docker build -t bedrock-agentcore-arm64 .',
              'echo "Authenticating with ECR..."',
              `aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin ${account}.dkr.ecr.${region}.amazonaws.com/${this.ecrRepository.repositoryName}`,
              'echo "Tagging image..."',
              `docker tag bedrock-agentcore-arm64:latest ${this.ecrRepository.repositoryUri}:latest`,
              `docker tag bedrock-agentcore-arm64:latest ${this.ecrRepository.repositoryUri}:$IMAGE_TAG`
            ]
          },
          post_build: {
            commands: [
              'echo "Pushing image to ECR..."',
              `docker push ${this.ecrRepository.repositoryUri}:latest`,
              `docker push ${this.ecrRepository.repositoryUri}:$IMAGE_TAG`,
              'echo "Build completed at $(date)"'
            ]
          }
        }
      })
    });
    
    // Grant CodeBuild permissions to ECR
    this.ecrRepository.grantPullPush(codeBuildProject);
    
    // Grant CodeBuild access to the source asset
    sourceAsset.grantRead(codeBuildProject);

    // Create WaitCondition Handle for build completion signaling
    const buildWaitHandle = new cdk.CfnWaitConditionHandle(this, 'BuildWaitHandle');

    // Create WaitCondition that waits for build completion signal
    const buildWaitCondition = new cdk.CfnWaitCondition(this, 'BuildWaitCondition', {
      handle: buildWaitHandle.ref,
      timeout: '3600', // 1 hour timeout (much longer than Lambda's 15 minutes)
      count: 1 // Wait for 1 success signal
    });

    // Lambda to trigger CodeBuild (returns immediately)
    const buildTrigger = new lambda.Function(this, 'BuildTriggerFunction', {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(2), // Short timeout - just starts build
      code: lambda.Code.fromInline(`
import json
import boto3
import urllib3

def handler(event, context):
    try:
        if event['RequestType'] == 'Create' or event['RequestType'] == 'Update':
            codebuild = boto3.client('codebuild')
            
            # Start the build
            response = codebuild.start_build(
                projectName='${codeBuildProject.projectName}'
            )
            
            build_id = response['build']['id']
            print(f"Started CodeBuild: {build_id}")
            
            # Return SUCCESS immediately - don't wait for completion
            send_response(event, context, 'SUCCESS', f'Build started: {build_id}')
            return
            
        else:
            send_response(event, context, 'SUCCESS', 'No action needed')
            
    except Exception as e:
        print(f"Error: {str(e)}")
        send_response(event, context, 'FAILED', str(e))

def send_response(event, context, status, reason):
    response_body = {
        'Status': status,
        'Reason': reason,
        'PhysicalResourceId': context.log_stream_name,
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId']
    }
    
    http = urllib3.PoolManager()
    http.request('PUT', event['ResponseURL'], 
                body=json.dumps(response_body),
                headers={'Content-Type': 'application/json'})
`)
    });

    // Grant CodeBuild permissions to trigger Lambda
    buildTrigger.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'codebuild:StartBuild'
      ],
      resources: [codeBuildProject.projectArn]
    }));

    // Lambda to handle build completion and signal WaitCondition
    const buildCompletionHandler = new lambda.Function(this, 'BuildCompletionHandler', {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(2),
      environment: {
        WAIT_HANDLE_URL: buildWaitHandle.ref,
        // Force Lambda env update on every deployment so WAIT_HANDLE_URL pre-signed URL stays fresh
        DEPLOY_TIMESTAMP: Date.now().toString()
      },
      code: lambda.Code.fromInline(`
import json
import urllib3
import os

def handler(event, context):
    try:
        build_status = event['detail']['build-status']
        project_name = event['detail']['project-name']
        build_id = event['detail']['build-id']
        wait_handle_url = os.environ['WAIT_HANDLE_URL']
        
        print(f"Build {project_name} ({build_id}) completed with status: {build_status}")
        
        if build_status == 'SUCCEEDED':
            # Signal SUCCESS to CloudFormation WaitCondition
            response_body = json.dumps({
                "Status": "SUCCESS",
                "Reason": f"Build {build_id} completed successfully",
                "UniqueId": build_id,
                "Data": f"Build finished with status: {build_status}"
            })
            print("Signaling SUCCESS to CloudFormation")
        else:
            # Signal FAILURE to CloudFormation WaitCondition
            response_body = json.dumps({
                "Status": "FAILURE", 
                "Reason": f"Build {build_id} failed with status: {build_status}",
                "UniqueId": build_id,
                "Data": f"Build failed with status: {build_status}"
            })
            print("Signaling FAILURE to CloudFormation")
        
        # Send signal to WaitCondition
        http = urllib3.PoolManager()
        response = http.request('PUT', wait_handle_url, 
                               body=response_body,
                               headers={'Content-Type': 'application/json'})
        
        print(f"WaitCondition signal sent, response: {response.status}")
        
    except Exception as e:
        print(f"Error in build completion handler: {str(e)}")
        # Try to signal failure to WaitCondition
        try:
            wait_handle_url = os.environ.get('WAIT_HANDLE_URL')
            if wait_handle_url:
                failure_body = json.dumps({
                    "Status": "FAILURE",
                    "Reason": f"Build completion handler error: {str(e)}",
                    "UniqueId": "handler-error"
                })
                http = urllib3.PoolManager()
                http.request('PUT', wait_handle_url, body=failure_body)
        except:
            pass  # Best effort
`)
    });

    // EventBridge rule to catch CodeBuild completion events
    const buildCompletionRule = new events.Rule(this, 'BuildCompletionRule', {
      eventPattern: {
        source: ['aws.codebuild'],
        detailType: ['CodeBuild Build State Change'],
        detail: {
          'project-name': [codeBuildProject.projectName],
          'build-status': ['SUCCEEDED', 'FAILED', 'FAULT', 'STOPPED', 'TIMED_OUT']
        }
      },
      targets: [new targets.LambdaFunction(buildCompletionHandler)]
    });

    // Custom resource to trigger build - uses source asset hash to only rebuild when code changes
    const buildTriggerResource = new cdk.CustomResource(this, 'BuildTrigger', {
      serviceToken: buildTrigger.functionArn,
      properties: {
        ProjectName: codeBuildProject.projectName,
        SourceHash: sourceAsset.assetHash, // Only rebuild when source code changes
      }
    });

    // Build trigger depends on source asset
    buildTriggerResource.node.addDependency(sourceAsset);
    
    // Store ECR and CodeBuild parameters
    new ssm.StringParameter(this, 'ECRRepositoryParameter', {
      parameterName: `/agentcore/${normalizedAgentName}/ecr-repository-uri`,
      stringValue: this.ecrRepository.repositoryUri,
      description: `ECR Repository URI for ${props.agentName}`
    });
    
    new ssm.StringParameter(this, 'CodeBuildProjectParameter', {
      parameterName: `/agentcore/${normalizedAgentName}/codebuild-project-name`,
      stringValue: codeBuildProject.projectName,
      description: `CodeBuild Project Name for ${props.agentName}`
    });
    
    // Phase 3: AgentCore Runtime using native CloudFormation
    // Use a stable name (no source hash) so CloudFormation updates in-place
    // instead of replacing. The RuntimeRefresher handles image updates.
    const agentRuntime = new cdk.CfnResource(this, 'AgentCoreRuntime', {
      type: 'AWS::BedrockAgentCore::Runtime',
      properties: {
        AgentRuntimeName: `${normalizedAgentName}`,
        Description: `AgentCore Runtime for ${props.agentName}`,
        AgentRuntimeArtifact: {
          ContainerConfiguration: {
            ContainerUri: `${this.ecrRepository.repositoryUri}:latest`
          }
        },
        RoleArn: memoryExecutionRole.roleArn,
        NetworkConfiguration: {
          NetworkMode: 'PUBLIC'
        },
        ProtocolConfiguration: props.protocolConfiguration || 'HTTP',
        EnvironmentVariables: {
          AGENTCORE_MEMORY_ARN: this.memoryId,
          ...(props.environmentVariables || {})
        }
      }
    });

    // Runtime depends on memory (if created), ECR, and build completion
    if (!props.sharedMemoryId && memory) {
      agentRuntime.addDependency(memory);
    }
    agentRuntime.addDependency(this.ecrRepository.node.defaultChild as cdk.CfnResource);
    agentRuntime.addDependency(buildWaitCondition); // Wait for build completion signal

    // Get runtime ARN from CloudFormation resource
    this.runtimeArn = agentRuntime.getAtt('AgentRuntimeArn').toString();
    const runtimeId = agentRuntime.getAtt('AgentRuntimeId').toString();

    // Force runtime to refresh container image after creation/update
    const runtimeRefresher = new lambda.Function(this, 'RuntimeRefresher', {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(10),
      code: lambda.Code.fromInline(`
import json
import boto3
import urllib3
import time

def handler(event, context):
    try:
        if event['RequestType'] == 'Delete':
            send_response(event, context, 'SUCCESS', 'No action needed for delete')
            return
        
        runtime_id = event['ResourceProperties']['RuntimeId']
        container_uri = event['ResourceProperties']['ContainerUri']
        role_arn = event['ResourceProperties']['RoleArn']
        region = event['ResourceProperties']['Region']
        env_vars = event['ResourceProperties'].get('EnvironmentVariables', {})
        image_tag = event['ResourceProperties'].get('ImageTag', '')
        ecr_repo = event['ResourceProperties'].get('EcrRepositoryName', '')
        protocol_config = event['ResourceProperties'].get('ProtocolConfiguration', 'HTTP')
        
        print(f"Refreshing runtime {runtime_id} to image {container_uri}")
        
        # Step 1: Wait for the EXACT image (tagged with this deploy's source hash)
        # to be present in ECR. This is deterministic: we wait for the specific
        # image this deploy builds, not the "latest CodeBuild status". The old
        # logic matched the previous SUCCEEDED build and refreshed the runtime
        # before the new image was pushed (a ~40s race on every redeploy).
        if image_tag and ecr_repo:
            ecr_client = boto3.client('ecr', region_name=region)
            print(f"Waiting for image {ecr_repo}:{image_tag} to appear in ECR...")
            found = False
            for i in range(90):  # up to ~15 min
                try:
                    ecr_client.describe_images(
                        repositoryName=ecr_repo,
                        imageIds=[{'imageTag': image_tag}]
                    )
                    print(f"Image {image_tag} present in ECR, proceeding with refresh")
                    found = True
                    break
                except ecr_client.exceptions.ImageNotFoundException:
                    print(f"  Image {image_tag} not yet pushed (attempt {i+1})")
                    time.sleep(10)
            if not found:
                print(f"Timed out waiting for image {image_tag}; proceeding anyway")
        else:
            print("No ImageTag/EcrRepositoryName provided, skipping ECR wait")
        
        client = boto3.client('bedrock-agentcore-control', region_name=region)
        
        # Step 2: Wait for runtime to be READY
        for i in range(30):
            response = client.get_agent_runtime(agentRuntimeId=runtime_id)
            status = response.get('status')
            print(f"Runtime status: {status}")
            if status == 'READY':
                break
            elif status in ['FAILED', 'DELETING']:
                raise Exception(f"Runtime in bad state: {status}")
            time.sleep(10)
        
        # Step 3: Update runtime to force image refresh
        update_params = {
            'agentRuntimeId': runtime_id,
            'agentRuntimeArtifact': {
                'containerConfiguration': {
                    'containerUri': container_uri
                }
            },
            'roleArn': role_arn,
            'networkConfiguration': {'networkMode': 'PUBLIC'},
            'protocolConfiguration': {'serverProtocol': protocol_config},
            'description': f'Refreshed at {int(time.time())}'
        }
        
        if env_vars:
            update_params['environmentVariables'] = env_vars
        
        response = client.update_agent_runtime(**update_params)
        print(f"Update initiated, new version: {response.get('agentRuntimeVersion')}")
        
        # Step 4: Wait for update to complete
        for i in range(30):
            response = client.get_agent_runtime(agentRuntimeId=runtime_id)
            status = response.get('status')
            print(f"Runtime status after update: {status}")
            if status == 'READY':
                send_response(event, context, 'SUCCESS', 'Runtime refreshed successfully')
                return
            elif status in ['FAILED']:
                raise Exception(f"Runtime update failed: {status}")
            time.sleep(10)
        
        send_response(event, context, 'SUCCESS', 'Runtime update initiated')
        
    except Exception as e:
        print(f"Error: {str(e)}")
        send_response(event, context, 'SUCCESS', f'Warning: {str(e)}')

def send_response(event, context, status, reason):
    response_body = {
        'Status': status,
        'Reason': reason,
        'PhysicalResourceId': context.log_stream_name,
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId']
    }
    http = urllib3.PoolManager()
    http.request('PUT', event['ResponseURL'], 
                body=json.dumps(response_body),
                headers={'Content-Type': 'application/json'})
`)
    });

    runtimeRefresher.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock-agentcore:UpdateAgentRuntime',
        'bedrock-agentcore:GetAgentRuntime'
      ],
      resources: [`arn:aws:bedrock-agentcore:${region}:${account}:runtime/*`]
    }));

    runtimeRefresher.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [memoryExecutionRole.roleArn]
    }));

    runtimeRefresher.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ecr:DescribeImages'],
      resources: [this.ecrRepository.repositoryArn]
    }));

    // Hash environment variables to detect config changes
    const envVarsHash = Buffer.from(JSON.stringify({
      AGENTCORE_MEMORY_ARN: 'memory-ref',
      ...(props.environmentVariables || {})
    })).toString('base64').substring(0, 32);

    const runtimeRefreshResource = new cdk.CustomResource(this, 'RuntimeRefresh', {
      serviceToken: runtimeRefresher.functionArn,
      properties: {
        RuntimeId: runtimeId,
        // Point the runtime at the EXACT image built for this source, not :latest.
        ContainerUri: `${this.ecrRepository.repositoryUri}:${sourceAsset.assetHash}`,
        RoleArn: memoryExecutionRole.roleArn,
        Region: region,
        // Wait for this specific image tag to exist in ECR before refreshing.
        ImageTag: sourceAsset.assetHash,
        EcrRepositoryName: this.ecrRepository.repositoryName,
        ProtocolConfiguration: props.protocolConfiguration || 'HTTP',
        EnvironmentVariables: {
          AGENTCORE_MEMORY_ARN: this.memoryId,
          ...(props.environmentVariables || {})
        },
        SourceHash: sourceAsset.assetHash,
        EnvVarsHash: envVarsHash,
      }
    });
    runtimeRefreshResource.node.addDependency(agentRuntime);

    // Store runtime ARN in Parameter Store
    new ssm.StringParameter(this, 'RuntimeArnParameter', {
      parameterName: `/agentcore/${normalizedAgentName}/runtime-arn`,
      stringValue: this.runtimeArn,
      description: `AgentCore Runtime ARN for ${props.agentName}`
    });

    // Configure observability (V2 delivery) for this runtime
    const observabilityConfig = new lambda.Function(this, 'ObservabilityConfig', {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(2),
      // Use a role with AdministratorAccess to allow vended log delivery configuration
      // This is required because logs:PutDeliverySource for bedrock-agentcore resources
      // requires special authorization that can't be granted through standard IAM policies
      role: new iam.Role(this, 'ObservabilityConfigRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
          iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')
        ]
      }),
      code: lambda.Code.fromInline(`
import boto3
import cfnresponse

def handler(event, context):
    try:
        if event['RequestType'] == 'Delete':
            cfnresponse.send(event, context, cfnresponse.SUCCESS, {})
            return
        
        logs = boto3.client('logs')
        runtime_arn = event['ResourceProperties']['RuntimeArn']
        runtime_name = event['ResourceProperties']['RuntimeName']
        account_id = event['ResourceProperties']['AccountId']
        region = event['ResourceProperties']['Region']
        log_group = event['ResourceProperties']['LogGroup']
        
        # Helper to create or update delivery source
        def ensure_delivery_source(name, log_type, resource_arn):
            try:
                existing = logs.get_delivery_source(name=name)
                existing_arn = existing.get('deliverySource', {}).get('resourceArn', '')
                if existing_arn != resource_arn:
                    print(f"Delivery source {name} exists with different ARN, deleting...")
                    try:
                        deliveries = logs.describe_deliveries()
                        for delivery in deliveries.get('deliveries', []):
                            if delivery.get('deliverySourceName') == name:
                                logs.delete_delivery(id=delivery['id'])
                                print(f"Deleted delivery {delivery['id']}")
                    except Exception as e:
                        print(f"Error deleting deliveries: {e}")
                    logs.delete_delivery_source(name=name)
                    print(f"Deleted delivery source {name}")
                    logs.put_delivery_source(name=name, logType=log_type, resourceArn=resource_arn)
                    print(f"Created delivery source {name} with new ARN")
                else:
                    print(f"Delivery source {name} already exists with correct ARN")
            except logs.exceptions.ResourceNotFoundException:
                logs.put_delivery_source(name=name, logType=log_type, resourceArn=resource_arn)
                print(f"Created delivery source {name}")
            except Exception as e:
                print(f"Error with delivery source {name}: {e}")
                raise
        
        ensure_delivery_source(f"{runtime_name}-logs-source", "APPLICATION_LOGS", runtime_arn)
        ensure_delivery_source(f"{runtime_name}-traces-source", "TRACES", runtime_arn)
        
        try:
            logs_dest = logs.put_delivery_destination(
                name=f"{runtime_name}-logs-destination",
                deliveryDestinationType='CWL',
                deliveryDestinationConfiguration={
                    'destinationResourceArn': f'arn:aws:logs:{region}:{account_id}:log-group:{log_group}'
                }
            )
        except Exception as e:
            print(f"Error creating logs destination: {e}")
            logs_dest = {'deliveryDestination': {'arn': f'arn:aws:logs:{region}:{account_id}:delivery-destination:{runtime_name}-logs-destination'}}
        
        try:
            traces_dest = logs.put_delivery_destination(
                name=f"{runtime_name}-traces-destination",
                deliveryDestinationType='XRAY'
            )
        except Exception as e:
            print(f"Error creating traces destination: {e}")
            traces_dest = {'deliveryDestination': {'arn': f'arn:aws:logs:{region}:{account_id}:delivery-destination:{runtime_name}-traces-destination'}}
        
        try:
            logs.create_delivery(
                deliverySourceName=f"{runtime_name}-logs-source",
                deliveryDestinationArn=logs_dest['deliveryDestination']['arn']
            )
        except Exception as e:
            if 'ResourceAlreadyExistsException' not in str(type(e)):
                print(f"Error creating logs delivery: {e}")
        
        try:
            logs.create_delivery(
                deliverySourceName=f"{runtime_name}-traces-source",
                deliveryDestinationArn=traces_dest['deliveryDestination']['arn']
            )
        except Exception as e:
            if 'ResourceAlreadyExistsException' not in str(type(e)):
                print(f"Error creating traces delivery: {e}")
        
        cfnresponse.send(event, context, cfnresponse.SUCCESS, {})
    except Exception as e:
        print(f"Error: {e}")
        cfnresponse.send(event, context, cfnresponse.FAILED, {})
      `)
    });

    // Hash observability config inputs - only update when config changes
    const observabilityHash = Buffer.from([
      normalizedAgentName,
      region,
      account,
      '/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS'
    ].join('|')).toString('base64').substring(0, 32);

    const observabilityResource = new cdk.CustomResource(this, 'RuntimeObservability', {
      serviceToken: observabilityConfig.functionArn,
      properties: {
        RuntimeArn: this.runtimeArn,
        RuntimeName: normalizedAgentName,
        AccountId: account,
        Region: region,
        LogGroup: '/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS',
        ConfigHash: observabilityHash, // Only update when observability config changes
      }
    });

    // Ensure observability is configured after runtime is created
    observabilityResource.node.addDependency(agentRuntime);
  }
  
  /**
   * Explicitly trigger agent deployment (CodeBuild)
   */
  public deployAgent(): void {
    // Deployment is automatically triggered during construct creation
    // This method is provided for explicit deployment scenarios
  }
}
