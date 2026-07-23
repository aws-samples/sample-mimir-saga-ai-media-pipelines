#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { ObservabilityStack } from '../lib/observability-stack';
import { AgentCoreStack } from '../lib/agentcore-stack';
import { InfrastructureStack } from '../lib/infrastructure-stack';
import { SagaFeedsStack } from '../lib/saga-feeds-stack';
import { McpGatewayStack } from '../lib/mcp-gateway-stack';
import * as path from 'path';
import * as fs from 'fs';

const app = new cdk.App();

// Load parameters from parameters.json and merge into context
const loadParametersAsContext = () => {
  const parametersPath = path.join(__dirname, '..', 'parameters.json');
  if (fs.existsSync(parametersPath)) {
    try {
      const parametersContent = fs.readFileSync(parametersPath, 'utf-8');
      const parameters = JSON.parse(parametersContent);
      const contextMap: { [key: string]: string } = {};

      for (const param of parameters) {
        if (param.ParameterKey && param.ParameterValue) {
          // Convert parameter keys to camelCase for context (e.g., MimirApiKey -> mimirApiKey)
          const contextKey = param.ParameterKey.charAt(0).toLowerCase() + param.ParameterKey.slice(1);
          contextMap[contextKey] = param.ParameterValue;
        }
      }
      return contextMap;
    } catch (error) {
      console.warn('Warning: Could not parse parameters.json:', error);
      return {};
    }
  }
  return {};
};

// Load parameters and make them available via app context
const parametersContext = loadParametersAsContext();

// Helper function to get context value with fallback to parameters.json
const getContextOrParameter = (key: string): string | undefined => {
  // First check CLI context (-c flag), then cdk.json context, then parameters.json
  return app.node.tryGetContext(key) || parametersContext[key] || undefined;
};

// Make getContextOrParameter available to stacks via app context
// Merge parametersContext into the app's context so stacks can access via this.node.tryGetContext()
for (const [key, value] of Object.entries(parametersContext)) {
  // Only set if not already set via CLI or cdk.json (those take precedence)
  if (!app.node.tryGetContext(key)) {
    app.node.setContext(key, value);
  }
}

// Product naming conventions (derived from productName in cdk.json context)
const productName = app.node.tryGetContext('productName') || 'Mimir Saga AI';

const createNamingConventions = (name: string) => {
  const cleaned = name.trim().replace(/\s+/g, ' ');
  return {
    displayName: cleaned,
    pascalCase: cleaned.replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, ''),
    kebabCase: cleaned.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
    // Acronym: keep all letters of already-uppercase words (e.g. "AI"), otherwise
    // take the first letter. "Mimir Saga AI" -> "MSAI", "Media Resource Manager" -> "MRM".
    acronym: cleaned
      .split(' ')
      .map(word => (word === word.toUpperCase() ? word : word.charAt(0).toUpperCase()))
      .join(''),
  };
};

const naming = createNamingConventions(productName);

// Apply cdk-nag AWS Solutions checks
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// Deploy observability stack first
const observabilityStack = new ObservabilityStack(app, `${naming.acronym}-ObservabilityStack`, {
  productName: naming.displayName,
  acronym: naming.acronym,
});

// Deploy AgentCore stack after observability (needs logging infrastructure)
const agentCoreStack = new AgentCoreStack(app, `${naming.acronym}-AgentCoreStack`, {
  productName: naming.displayName,
  acronym: naming.acronym,
});
agentCoreStack.addDependency(observabilityStack);

// Deploy other stacks with dependencies
const infrastructureStack = new InfrastructureStack(app, `${naming.acronym}-CoreStack`, {
  productName: naming.displayName,
  acronym: naming.acronym,
});
infrastructureStack.addDependency(observabilityStack);

const sagaFeedsStack = new SagaFeedsStack(app, `${naming.acronym}-SagaFeedsStack`, {
  productName: naming.displayName,
  acronym: naming.acronym,
});
sagaFeedsStack.addDependency(observabilityStack);
sagaFeedsStack.addDependency(infrastructureStack);

// Deploy MCP Gateway after AgentCore (needs the mimir-mcp-server runtime ARN)
const mcpGatewayStack = new McpGatewayStack(app, `${naming.acronym}-McpGatewayStack`, {});
mcpGatewayStack.addDependency(agentCoreStack);

// ===== cdk-nag NagSuppressions =====
// These suppressions cover patterns that are by-design for this sample project.
// Each suppression includes a justification explaining why it is acceptable.

const commonSuppressions = [
  {
    id: 'AwsSolutions-IAM4',
    reason: 'AWS managed policies (AWSLambdaBasicExecutionRole, AmazonBedrockFullAccess) are used for Lambda execution roles and AgentCore memory roles. These are standard CDK-generated patterns appropriate for sample code.',
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'Wildcard permissions are required for: Bedrock model invocations (model IDs not known at deploy time), AgentCore runtimes (IDs generated dynamically), S3 CDK bootstrap bucket access, and CloudWatch Logs (log group names include dynamic resource IDs). These are the minimum permissions required for the services to function.',
  },
];

// Apply common IAM suppressions to all stacks
for (const stack of [observabilityStack, agentCoreStack, infrastructureStack, sagaFeedsStack, mcpGatewayStack]) {
  NagSuppressions.addStackSuppressions(stack, commonSuppressions);
}

// Infrastructure stack specific suppressions
NagSuppressions.addStackSuppressions(infrastructureStack, [
  {
    id: 'AwsSolutions-APIG4',
    reason: 'API uses X-API-Key authentication which is Mimir\'s custom action authentication pattern. The API is called by Mimir\'s backend service, not end users, so Cognito authorizer is not applicable.',
  },
  {
    id: 'AwsSolutions-COG4',
    reason: 'API uses X-API-Key authentication for Mimir custom actions. Cognito user pool authorizer is not applicable for server-to-server API calls from Mimir.',
  },
  {
    id: 'AwsSolutions-APIG2',
    reason: 'Request validation is performed in the Lambda functions (checking actionType, items array, etc.). API Gateway schema validation would require maintaining a JSON schema in sync with Lambda logic and is not required for sample code.',
  },
  {
    id: 'AwsSolutions-APIG3',
    reason: 'WAF is not required for sample code. In production, WAF should be added for protection against common web exploits.',
  },
  {
    id: 'AwsSolutions-SMG4',
    reason: 'Secrets contain third-party API keys (Mimir, Saga) that cannot be auto-rotated by AWS — rotation requires coordination with the external service provider.',
  },
  {
    id: 'AwsSolutions-S1',
    reason: 'S3 server access logging is not enabled for sample code. In production, a dedicated logging bucket should be configured. Enabling it here would create a circular dependency or require an additional bucket.',
  },
  {
    id: 'AwsSolutions-L1',
    reason: 'CDK BucketDeployment uses an internally managed Lambda (Custom::CDKBucketDeployment) whose runtime is controlled by the CDK framework and cannot be configured by the application. The runtime is kept current by CDK library updates.',
  },
]);

// AgentCore stack specific suppressions
NagSuppressions.addStackSuppressions(agentCoreStack, [
  {
    id: 'AwsSolutions-CB4',
    reason: 'CodeBuild projects build Docker images for AgentCore agents. KMS encryption for build artifacts is not required for this use case and adds operational overhead not appropriate for sample code.',
  },
  {
    id: 'AwsSolutions-S1',
    reason: 'S3 server access logging not required for CDK bootstrap bucket used by CodeBuild source assets in sample code.',
  },
]);

// MCP Gateway stack specific suppressions
NagSuppressions.addStackSuppressions(mcpGatewayStack, [
  {
    id: 'AwsSolutions-COG1',
    reason: 'Cognito user pool is used for MCP Gateway machine-to-machine OAuth (client credentials flow), not for human users. Password policies are not applicable to service accounts.',
  },
  {
    id: 'AwsSolutions-COG2',
    reason: 'MFA is not applicable for machine-to-machine OAuth client credentials flow used by the MCP Gateway. There are no human users authenticating to this user pool.',
  },
  {
    id: 'AwsSolutions-COG8',
    reason: 'Cognito Plus tier advanced security features are not required for machine-to-machine OAuth client credentials flow used by the MCP Gateway.',
  },
]);

// Observability stack specific suppressions
NagSuppressions.addStackSuppressions(observabilityStack, [
  {
    id: 'AwsSolutions-S1',
    reason: 'The Bedrock logging bucket is itself the access log destination. Enabling access logging on it would create a circular dependency.',
  },
]);

// Saga Feeds stack specific suppressions
NagSuppressions.addStackSuppressions(sagaFeedsStack, [
  {
    id: 'AwsSolutions-SMG4',
    reason: 'Secrets contain third-party API keys (Mimir, Saga) that cannot be auto-rotated by AWS — rotation requires coordination with the external service provider.',
  },
  {
    id: 'AwsSolutions-S1',
    reason: 'S3 server access logging not enabled for wire feed source/destination buckets in sample code.',
  },
]);
