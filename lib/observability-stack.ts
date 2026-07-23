import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface ObservabilityStackProps extends cdk.StackProps {
  // Product display name, e.g. "Mimir Saga AI"
  productName: string;
  // Product acronym used to prefix resource names, e.g. "MSAI"
  acronym: string;
}

export class ObservabilityStack extends cdk.Stack {
  public readonly loggingBucket: s3.Bucket;
  public readonly modelInvocationLogGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    // Resource naming prefix derived from the product acronym (e.g. "msai")
    const resourcePrefix = props.acronym.toLowerCase();

    // S3 bucket for Bedrock model invocation logs
    this.loggingBucket = new s3.Bucket(this, 'BedrockLoggingBucket', {
      bucketName: `${resourcePrefix}-bedrock-logs-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
    });

    // Bucket policy for Bedrock service
    this.loggingBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AmazonBedrockLogsWrite',
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('bedrock.amazonaws.com')],
      actions: ['s3:PutObject'],
      resources: [`${this.loggingBucket.bucketArn}/bedrock-logs/AWSLogs/${this.account}/BedrockModelInvocationLogs/*`],
      conditions: {
        StringEquals: { 'aws:SourceAccount': this.account },
        ArnLike: { 'aws:SourceArn': `arn:aws:bedrock:${this.region}:${this.account}:*` }
      }
    }));

    // CloudWatch log group for model invocations
    this.modelInvocationLogGroup = new logs.LogGroup(this, 'BedrockModelInvocationLogs', {
      logGroupName: '/aws/bedrock/modelinvocations',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // CloudWatch log group for X-Ray traces
    new logs.LogGroup(this, 'XRaySpansLogGroup', {
      logGroupName: '/aws/spans/default',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // IAM role for Bedrock CloudWatch logging
    const loggingRole = new iam.Role(this, 'BedrockLoggingRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      inlinePolicies: {
        LoggingPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
              resources: [
                `${this.modelInvocationLogGroup.logGroupArn}`,
                `${this.modelInvocationLogGroup.logGroupArn}:*`
              ]
            })
          ]
        })
      }
    });

    // CloudWatch Logs resource policy for Transaction Search
    new logs.CfnResourcePolicy(this, 'TransactionSearchResourcePolicy', {
      policyName: 'TransactionSearchAccess',
      policyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'TransactionSearchXRayAccess',
            Effect: 'Allow',
            Principal: {
              Service: 'xray.amazonaws.com'
            },
            Action: 'logs:PutLogEvents',
            Resource: [
              `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:aws/spans:*`,
              `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:/aws/spans:*`,
              `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:/aws/application-signals/data:*`
            ],
            Condition: {
              ArnLike: {
                'aws:SourceArn': `arn:${this.partition}:xray:${this.region}:${this.account}:*`
              },
              StringEquals: {
                'aws:SourceAccount': this.account
              }
            }
          }
        ]
      })
    });

    // Lambda function to configure Bedrock logging and Transaction Search
    // Note: Runtime-specific V2 delivery is now handled in AgentCore construct
    const configureLoggingFunction = new lambda.Function(this, 'ConfigureBedrockLogging', {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
# Version: 3.0 - Transaction Search only (V2 delivery moved to AgentCore construct)
import boto3
import json
import cfnresponse

def handler(event, context):
    try:
        bedrock = boto3.client('bedrock')
        xray = boto3.client('xray')
        logs = boto3.client('logs')
        
        if event['RequestType'] == 'Create' or event['RequestType'] == 'Update':
            # Configure Bedrock logging
            bedrock.put_model_invocation_logging_configuration(
                loggingConfig={
                    'textDataDeliveryEnabled': True,
                    'imageDataDeliveryEnabled': True,
                    'embeddingDataDeliveryEnabled': True,
                    's3Config': {
                        'bucketName': event['ResourceProperties']['BucketName'],
                        'keyPrefix': 'bedrock-logs'
                    },
                    'cloudWatchConfig': {
                        'logGroupName': event['ResourceProperties']['LogGroupName'],
                        'roleArn': event['ResourceProperties']['RoleArn']
                    }
                }
            )
            print("Configured Bedrock logging")
            
            # Enable Transaction Search (check if already enabled first)
            try:
                current_destination = xray.get_trace_segment_destination()
                if current_destination.get('Destination') != 'CloudWatchLogs':
                    xray.update_trace_segment_destination(Destination='CloudWatchLogs')
                    print("Enabled Transaction Search destination")
                else:
                    print("Transaction Search destination already enabled")
            except Exception as e:
                print(f"Transaction Search setup: {e}")
            
            # Set sampling percentage to 10%
            try:
                xray.update_indexing_rule(
                    Name='Default',
                    Rule={'Probabilistic': {'DesiredSamplingPercentage': 10}}
                )
                print("Configured Transaction Search sampling")
            except Exception as e:
                print(f"Transaction Search sampling: {e}")
            
            # Create shared log group and resource policy
            # Runtime-specific V2 delivery configured in AgentCore construct
            account_id = event['ResourceProperties']['AccountId']
            region = event['ResourceProperties']['Region']
            app_logs_group = '/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS'
            
            try:
                logs.create_log_group(logGroupName=app_logs_group)
                print(f"Created shared log group")
            except logs.exceptions.ResourceAlreadyExistsException:
                print(f"Shared log group exists")
            
            try:
                logs.put_resource_policy(
                    policyName='AgentCoreV2DeliveryPolicy',
                    policyDocument=json.dumps({
                        'Version': '2012-10-17',
                        'Statement': [{
                            'Sid': 'AgentCoreDeliveryAccess',
                            'Effect': 'Allow',
                            'Principal': {'Service': 'delivery.logs.amazonaws.com'},
                            'Action': ['logs:CreateLogStream', 'logs:PutLogEvents'],
                            'Resource': f'arn:aws:logs:{region}:{account_id}:log-group:{app_logs_group}:*',
                            'Condition': {
                                'StringEquals': {'aws:SourceAccount': account_id},
                                'ArnLike': {'aws:SourceArn': f'arn:aws:logs:{region}:{account_id}:delivery-source:*'}
                            }
                        }]
                    })
                )
                print("Created resource policy")
            except Exception as e:
                print(f"Resource policy: {e}")
            
        elif event['RequestType'] == 'Delete':
            try:
                bedrock.delete_model_invocation_logging_configuration()
                print("Deleted Bedrock logging")
            except Exception as e:
                print(f"Error: {e}")
        
        cfnresponse.send(event, context, cfnresponse.SUCCESS, {})
        
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
        cfnresponse.send(event, context, cfnresponse.FAILED, {})
      `),
      timeout: cdk.Duration.minutes(5),
    });

    // Grant permissions to the Lambda function
    configureLoggingFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:PutModelInvocationLoggingConfiguration',
        'bedrock:DeleteModelInvocationLoggingConfiguration',
        'bedrock:GetModelInvocationLoggingConfiguration',
        'xray:UpdateTraceSegmentDestination',
        'xray:UpdateIndexingRule',
        'xray:GetTraceSegmentDestination',
        'xray:PutResourcePolicy',
        'xray:ListResourcePolicies',
        'application-signals:StartDiscovery',
        'logs:PutDeliverySource',
        'logs:PutDeliveryDestination',
        'logs:CreateDelivery',
        'logs:GetDelivery',
        'logs:GetDeliverySource',
        'logs:GetDeliveryDestination',
        'logs:DeleteDelivery',
        'logs:DeleteDeliverySource',
        'logs:DeleteDeliveryDestination',
        'logs:DescribeDeliveries',
        'logs:DescribeDeliverySources',
        'logs:DescribeDeliveryDestinations',
        'logs:PutResourcePolicy',
        'logs:DescribeResourcePolicies',
        'logs:CreateLogGroup'
      ],
      resources: ['*']
    }));

    configureLoggingFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [loggingRole.roleArn]
    }));

    // Custom resource to trigger the Lambda function
    const loggingConfig = new cdk.CustomResource(this, 'BedrockLoggingConfig', {
      serviceToken: configureLoggingFunction.functionArn,
      properties: {
        BucketName: this.loggingBucket.bucketName,
        LogGroupName: this.modelInvocationLogGroup.logGroupName,
        RoleArn: loggingRole.roleArn,
        AccountId: this.account,
        Region: this.region,
        Version: '7.0' // Added logs:PutResourcePolicy permission
      }
    });

    // Ensure IAM policy is fully updated before invoking the custom resource
    loggingConfig.node.addDependency(configureLoggingFunction.role!.node.findChild('DefaultPolicy'));

    // Outputs
    new cdk.CfnOutput(this, 'LoggingBucketName', {
      value: this.loggingBucket.bucketName,
      description: 'S3 bucket for Bedrock model invocation logs'
    });

    new cdk.CfnOutput(this, 'ModelInvocationLogGroup', {
      value: this.modelInvocationLogGroup.logGroupName,
      description: 'CloudWatch log group for Bedrock model invocations'
    });

    new cdk.CfnOutput(this, 'TransactionSearchEnabled', {
      value: 'true',
      description: 'CloudWatch Transaction Search fully enabled for AgentCore observability'
    });
  }
}
