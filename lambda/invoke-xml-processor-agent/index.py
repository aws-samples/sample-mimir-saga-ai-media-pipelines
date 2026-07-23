"""
Lambda function to invoke Sample Agent via AgentCore Runtime for XML processing.

This function reads XML files from S3, invokes the agent to map XML to Saga feeds format,
and returns the mapped data for the Step Functions workflow.
"""

import json
import boto3
import os
import uuid
import logging
from typing import Dict, Any, Optional

# Configure logging
logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

# Initialize AWS clients
bedrock_agentcore = boto3.client(
    'bedrock-agentcore',
    config=boto3.session.Config(
        read_timeout=60,
        connect_timeout=10,
        retries={'max_attempts': 2}
    )
)
stepfunctions = boto3.client('stepfunctions')
s3 = boto3.client('s3')
ssm = boto3.client('ssm')


def validate_event(event: Dict[str, Any]) -> tuple[str, Dict[str, Any]]:
    """
    Validate the Lambda event contains required fields.
    
    Args:
        event: Lambda event from Step Functions
        
    Returns:
        Tuple of (task_token, feed_data)
        
    Raises:
        ValueError: If required fields are missing
    """
    # Extract task token
    task_token = event.get('TaskToken')
    if not task_token:
        raise ValueError('TaskToken is required for callback pattern')
    
    # Extract feed data
    feed_data = event.get('feedData', {})
    if not feed_data:
        raise ValueError('feedData is required')
    
    # Validate required fields
    if not feed_data.get('destinationBucket'):
        raise ValueError('destinationBucket is required in feedData')
    
    if not feed_data.get('xmlKey'):
        raise ValueError('xmlKey is required in feedData')
    
    return task_token, feed_data


def read_xml_from_s3(bucket: str, key: str) -> str:
    """
    Read XML content from S3.
    
    Args:
        bucket: S3 bucket name
        key: S3 object key
        
    Returns:
        XML content as string
    """
    try:
        response = s3.get_object(Bucket=bucket, Key=key)
        return response['Body'].read().decode('utf-8')
    except Exception as e:
        logger.error(f"Failed to read XML from S3: {str(e)}")
        raise


def get_agentcore_parameters() -> Dict[str, str]:
    """
    Get AgentCore parameters from SSM Parameter Store.
    
    Returns:
        Dictionary with runtime ARN and memory ID
    """
    try:
        # Get XML processor agent runtime ARN
        runtime_response = ssm.get_parameter(
            Name='/agentcore/xml_processor_agent/runtime-arn'
        )
        runtime_arn = runtime_response['Parameter']['Value']
        
        # Get shared memory ID
        memory_response = ssm.get_parameter(
            Name='/agentcore/shared/memory-id'
        )
        memory_id = memory_response['Parameter']['Value']
        
        return {
            'runtime_arn': runtime_arn,
            'memory_id': memory_id
        }
    except Exception as e:
        logger.error(f"Failed to get AgentCore parameters: {str(e)}")
        raise


def create_agent_payload(xml_content: str, feed_data: Dict[str, Any], task_token: str, memory_id: str) -> Dict[str, Any]:
    """
    Create payload for the XML processor agent.
    
    Args:
        xml_content: Raw XML content
        feed_data: Feed data from Step Functions
        task_token: Task token for callback
        memory_id: AgentCore memory ID
        
    Returns:
        Agent payload
    """
    return {
        'xml_content': xml_content,
        'task_token': task_token,
        'provider': feed_data.get('provider', 'ABC'),  # Pass provider from feedData
        'memory_id': memory_id,
        'storage_mode': 'memory',
        'actor_id': 'xml-processor',
        'session_id': str(uuid.uuid4())
    }


def send_task_failure(task_token: str, error: str, cause: str) -> None:
    """Send task failure to Step Functions."""
    try:
        stepfunctions.send_task_failure(
            taskToken=task_token,
            error=error,
            cause=cause[:256]
        )
        logger.info(f"Sent task failure: {error}")
    except Exception as callback_error:
        logger.error(f"Failed to send task failure: {str(callback_error)}")


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Invoke Sample Agent for XML processing with callback pattern.
    
    Args:
        event: Contains feedData and task token from Step Functions
        context: Lambda context
        
    Returns:
        Success response (agent will callback asynchronously)
    """
    task_token: Optional[str] = None
    
    try:
        # Validate event
        task_token, feed_data = validate_event(event)
        
        logger.info(
            "Processing XML mapping request",
            extra={
                'bucket': feed_data.get('sourceBucket'),
                'xml_key': feed_data.get('xmlKey'),
                'has_task_token': bool(task_token)
            }
        )
        
        # Read XML content from destination bucket (since it was moved by WaitForMp4Task)
        xml_content = read_xml_from_s3(
            feed_data['destinationBucket'], 
            feed_data.get('processedXmlKey', feed_data['xmlKey'])  # Use processedXmlKey if available
        )
        
        # Get AgentCore parameters
        agentcore_params = get_agentcore_parameters()
        
        # Create agent payload
        agent_payload = create_agent_payload(
            xml_content, 
            feed_data, 
            task_token, 
            agentcore_params['memory_id']
        )
        
        logger.info(
            "Invoking AgentCore Runtime",
            extra={
                'runtime_arn': agentcore_params['runtime_arn'],
                'memory_id': agentcore_params['memory_id'],
                'xml_size': len(xml_content)
            }
        )
        
        # Generate unique session ID
        session_id = str(uuid.uuid4())
        
        # Invoke AgentCore Runtime (async - don't wait for response)
        bedrock_agentcore.invoke_agent_runtime(
            agentRuntimeArn=agentcore_params['runtime_arn'],
            runtimeSessionId=session_id,
            payload=json.dumps(agent_payload).encode('utf-8')
        )
        
        logger.info(
            "AgentCore invocation initiated successfully",
            extra={
                'session_id': session_id,
                'callback_info': 'Agent will callback to Step Functions when complete'
            }
        )
        
        # Return immediately - agent will callback
        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': 'XML processing initiated',
                'session_id': session_id
            })
        }
        
    except ValueError as e:
        error_msg = str(e)
        logger.error(f"Validation error: {error_msg}")
        
        if task_token:
            send_task_failure(task_token, 'ValidationError', error_msg)
        
        raise
        
    except Exception as e:
        error_msg = str(e)
        logger.exception("Unexpected error invoking AgentCore")
        
        if task_token:
            send_task_failure(task_token, 'UnknownError', error_msg)
        
        raise
