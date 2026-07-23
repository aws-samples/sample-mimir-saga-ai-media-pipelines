const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const ssmClient = new SSMClient();

exports.handler = async (event) => {
    console.log('Getting AgentCore parameters:', JSON.stringify(event, null, 2));
    
    try {
        // Get XML processor agent runtime ARN
        const runtimeResponse = await ssmClient.send(new GetParameterCommand({
            Name: '/agentcore/xml_processor_agent/runtime-arn'
        }));
        
        // Get shared memory ID  
        const memoryResponse = await ssmClient.send(new GetParameterCommand({
            Name: '/agentcore/shared/memory-id'
        }));
        
        const result = {
            xmlProcessorAgentRuntimeArn: runtimeResponse.Parameter.Value,
            sharedMemoryId: memoryResponse.Parameter.Value,
            // Pass through the original event data
            ...event
        };
        
        console.log('AgentCore parameters retrieved:', {
            runtimeArn: result.xmlProcessorAgentRuntimeArn,
            memoryId: result.sharedMemoryId
        });
        
        return result;
        
    } catch (error) {
        console.error('Error getting AgentCore parameters:', error);
        throw error;
    }
};
