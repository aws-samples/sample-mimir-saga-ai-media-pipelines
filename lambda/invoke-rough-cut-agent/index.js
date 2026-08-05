/**
 * Invoke Rough Cut Agent via AgentCore Runtime with Task Token.
 *
 * Step Functions calls this Lambda with a TaskToken. The Lambda invokes
 * the AgentCore runtime (fire-and-forget), passing the token to the agent.
 * The agent calls SendTaskSuccess/SendTaskFailure when done.
 */

const { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } = require('@aws-sdk/client-bedrock-agentcore');
const { SFNClient, SendTaskFailureCommand } = require('@aws-sdk/client-sfn');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { randomUUID } = require('crypto');

const agentCoreClient = new BedrockAgentCoreClient();
const sfnClient = new SFNClient();
const ssmClient = new SSMClient();

async function sendTaskFailure(taskToken, error, cause) {
  try {
    await sfnClient.send(new SendTaskFailureCommand({
      taskToken,
      error,
      cause: cause.substring(0, 256),
    }));
  } catch (err) {
    console.error('Failed to send task failure:', err);
  }
}

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  const taskToken = event.TaskToken;
  if (!taskToken) throw new Error('TaskToken is required');

  try {
    // Resolve runtime ARN from SSM
    const { Parameter } = await ssmClient.send(new GetParameterCommand({
      Name: '/fonn-custom-actions/agentcore/rough-cut-agent/runtime-arn',
    }));
    const runtimeArn = Parameter?.Value;
    if (!runtimeArn) {
      await sendTaskFailure(taskToken, 'ConfigurationError', 'Runtime ARN not found in SSM');
      throw new Error('Runtime ARN not found');
    }

    console.log('Invoking AgentCore runtime:', runtimeArn);

    const sessionId = randomUUID();

    // Build payload — include task_token so the agent can callback
    const agentPayload = {
      task_token: taskToken,
      storyContext: event.storyContext || {},
      story: event.storyContext?.story || event.story || {},
      assets: event.storyContext?.assets || [],
      instances: event.storyContext?.instances || [],
      notes: event.storyContext?.notes || [],
      storyId: event.storyId || '',
      triggeredByUserId: event.triggeredByUserId || '',
      mimirApiKey: event.mimirApiKey || '',
      // Rough-cut variant selector; the agent maps this to a prompt/constraint
      // profile. Defaults to "full" when absent.
      roughCutType: event.roughCutType || 'full',
    };

    const command = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: runtimeArn,
      runtimeSessionId: sessionId,
      payload: Buffer.from(JSON.stringify(agentPayload)),
      qualifier: 'DEFAULT',
    });

    // Fire-and-forget: race invocation against a short timeout.
    // If it fails fast (bad ARN, auth error) we catch it.
    // If still running after 2s, the agent was accepted and will callback.
    const invokePromise = agentCoreClient.send(command);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT_OK')), 2000)
    );

    try {
      await Promise.race([invokePromise, timeoutPromise]);
      console.log('AgentCore responded quickly');
    } catch (err) {
      if (err.message === 'TIMEOUT_OK') {
        console.log('AgentCore invocation accepted — agent will callback via TaskToken');
      } else {
        console.error('AgentCore invocation failed:', err.message);
        await sendTaskFailure(taskToken, 'InvocationError', err.message);
        throw err;
      }
    }

    return { statusCode: 200, message: 'Agent invocation started', sessionId };
  } catch (err) {
    console.error('Error:', err);
    await sendTaskFailure(taskToken, 'UnknownError', err.message);
    throw err;
  }
};
