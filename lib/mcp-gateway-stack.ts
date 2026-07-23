import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * MCP Gateway Stack
 *
 * Creates an AgentCore Gateway with Cognito authentication that exposes
 * the Mimir MCP Server (deployed on AgentCore Runtime) to Amazon Quick Suite.
 *
 * Architecture: Quick Suite → AgentCore Gateway (Cognito auth) → AgentCore Runtime (MCP server)
 */
export class McpGatewayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const region = this.region;
    const account = this.account;

    // Read the MCP server runtime ARN from SSM (deployed by AgentCoreStack)
    const mcpServerRuntimeArn = ssm.StringParameter.valueForStringParameter(
      this, '/fonn-custom-actions/agentcore/mimir-mcp-server/runtime-arn'
    );

    // --- Cognito User Pool for Gateway Auth ---
    const userPool = new cognito.UserPool(this, 'McpGatewayUserPool', {
      userPoolName: 'mcp-gateway-auth',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Add a resource server for OAuth scopes
    const resourceServer = userPool.addResourceServer('McpResourceServer', {
      identifier: 'mcp-gateway',
      scopes: [
        { scopeName: 'invoke', scopeDescription: 'Invoke MCP tools' },
      ],
    });

    // App client for Quick Suite (service-to-service auth)
    const appClient = userPool.addClient('QuickSuiteClient', {
      userPoolClientName: 'quick-suite-mcp-client',
      generateSecret: true,
      oAuth: {
        flows: { clientCredentials: true },
        scopes: [
          cognito.OAuthScope.custom('mcp-gateway/invoke'),
        ],
      },
    });
    // Client must wait for resource server (defines the custom scope)
    appClient.node.addDependency(resourceServer);

    // Add a domain for the Cognito hosted UI / token endpoint
    const domain = userPool.addDomain('McpGatewayDomain', {
      cognitoDomain: {
        domainPrefix: `mcp-gateway-${account}`,
      },
    });

    // --- IAM Role for Gateway ---
    const gatewayRole = new iam.Role(this, 'GatewayRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Role for AgentCore Gateway to invoke MCP server on Runtime',
    });

    // Allow Gateway to invoke the AgentCore Runtime (wildcard for runtime ID changes)
    gatewayRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: [
        `arn:aws:bedrock-agentcore:${region}:${account}:runtime/*`,
      ],
    }));

    // --- AgentCore Gateway ---
    const gateway = new cdk.CfnResource(this, 'McpGateway', {
      type: 'AWS::BedrockAgentCore::Gateway',
      properties: {
        Name: 'MimirSagaMcpGateway',
        Description: 'MCP Gateway for Mimir and Saga media asset management tools',
        ProtocolType: 'MCP',
        AuthorizerType: 'CUSTOM_JWT',
        AuthorizerConfiguration: {
          CustomJWTAuthorizer: {
            DiscoveryUrl: `https://cognito-idp.${region}.amazonaws.com/${userPool.userPoolId}/.well-known/openid-configuration`,
            AllowedClients: [appClient.userPoolClientId],
          },
        },
        RoleArn: gatewayRole.roleArn,
      },
    });

    const gatewayId = gateway.ref;
    const gatewayUrl = gateway.getAtt('GatewayUrl').toString();

    // --- Gateway Target (MCP Server on Runtime) ---
    // Build the Runtime invocation URL
    const escapedArn = cdk.Fn.join('', [
      'arn%3Aaws%3Abedrock-agentcore%3A', region,
      '%3A', account,
      '%3Aruntime%2F',
      // Extract runtime ID from the full ARN
      cdk.Fn.select(1, cdk.Fn.split('runtime/', mcpServerRuntimeArn)),
    ]);

    const runtimeEndpoint = cdk.Fn.join('', [
      'https://bedrock-agentcore.', region, '.amazonaws.com/runtimes/',
      escapedArn,
      '/invocations',
    ]);

    const gatewayTarget = new cdk.CfnResource(this, 'McpGatewayTarget', {
      type: 'AWS::BedrockAgentCore::GatewayTarget',
      properties: {
        GatewayIdentifier: gatewayId,
        Name: 'MimirSagaMcpServer',
        Description: 'Mimir and Saga MCP Server on AgentCore Runtime',
        TargetConfiguration: {
          Mcp: {
            McpServer: {
              Endpoint: runtimeEndpoint,
            },
          },
        },
        CredentialProviderConfigurations: [
          {
            CredentialProviderType: 'GATEWAY_IAM_ROLE',
            CredentialProvider: {
              IamCredentialProvider: {
                Service: 'bedrock-agentcore',
              },
            },
          },
        ],
      },
    });
    // Target must wait for the Gateway role policy to be attached
    // (otherwise tool discovery fails with InvokeAgentRuntime denied)
    gatewayTarget.addDependency(gateway);
    gatewayTarget.node.addDependency(gatewayRole);

    // --- Outputs ---
    new cdk.CfnOutput(this, 'GatewayUrl', {
      value: gatewayUrl,
      description: 'AgentCore Gateway URL — use this as the MCP Server Endpoint in Quick Suite',
    });

    new cdk.CfnOutput(this, 'GatewayMcpEndpoint', {
      value: cdk.Fn.join('', [gatewayUrl, '/mcp']),
      description: 'Full MCP endpoint URL for Quick Suite integration',
    });

    new cdk.CfnOutput(this, 'CognitoUserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'CognitoClientId', {
      value: appClient.userPoolClientId,
      description: 'Cognito App Client ID — use as Client ID in Quick Suite MCP auth',
    });

    new cdk.CfnOutput(this, 'CognitoTokenUrl', {
      value: `https://${domain.domainName}.auth.${region}.amazoncognito.com/oauth2/token`,
      description: 'Cognito Token URL — use as Token URL in Quick Suite MCP service auth',
    });

    // Store in SSM for reference
    new ssm.StringParameter(this, 'GatewayUrlParameter', {
      parameterName: '/fonn-custom-actions/mcp-gateway/url',
      stringValue: gatewayUrl,
      description: 'MCP Gateway URL',
    });
  }
}
