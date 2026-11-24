import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

/**
 * A Secrets Manager secret whose value is never part of the CloudFormation
 * template. CloudFormation creates it empty, and deploy.sh writes the value
 * from parameters.json with PutSecretValue (scripts/sync-api-key-secrets.js).
 *
 * Keep the construct id unchanged: it fixes the CloudFormation logical id, and
 * a new logical id would delete the existing secret and change its ARN, which
 * other stacks read from SSM. RETAIN also keeps the secret if the resource is
 * ever removed from the stack, because CloudFormation deletes secrets with no
 * recovery window.
 */
export function valueLessSecret(scope: Construct, id: string, description: string): secretsmanager.Secret {
  const secret = new secretsmanager.Secret(scope, id, {
    description,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
  // The L2 construct adds an empty GenerateSecretString when no value is given,
  // which would make CloudFormation write a random value over the real key.
  // With neither SecretString nor GenerateSecretString the secret is created empty.
  (secret.node.defaultChild as secretsmanager.CfnSecret).addPropertyDeletionOverride('GenerateSecretString');
  return secret;
}
