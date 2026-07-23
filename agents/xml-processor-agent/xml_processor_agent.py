from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent, tool
from strands.models import BedrockModel
import json
import logging
import boto3
from datetime import datetime

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

app = BedrockAgentCoreApp()

# Initialize Step Functions client for callbacks
stepfunctions = boto3.client('stepfunctions')

# System prompt for XML mapping
XML_MAPPING_SYSTEM_PROMPT = """You are an expert XML parser and data mapper specializing in converting various XML feed formats to standardized Saga feeds API format.

Your task is to analyze XML content from different news providers and intelligently map the fields to the required Saga feeds format. Different providers use different XML schemas and field names, so you need to:

1. Parse the XML content and identify all available fields
2. Map the fields to the standardized Saga feeds format using your best judgment
3. Handle missing fields gracefully with appropriate defaults
4. Extract provider information from the content when possible
5. Format body content with proper HTML structure (use <p> tags for paragraphs)

COMPLETE Saga feeds format specification (based on ninjs standard):

REQUIRED FIELDS:
- "uri": Unique ID for feed item (string)
- "provider": Provider name, a-z only, no symbols/spaces (string)
- "infosource": Information source, can differ from provider (string)
- "versioncreated": Version created date in ISO format (string)

OPTIONAL FIELDS:
- "version": Version number (string or number)
- "firstcreated": First created date in ISO format (string)
- "section": Content section (string)
- "urgency": Urgency/Priority value 1-9 (number) - map "Primary"=1, "Secondary"=2, etc.
- "priority": Priority value 1-9 (number) - same as urgency
- "pubstatus": Publication status, typically "usable" (string)
- "ednotes": Editorial notes (string)
- "mediatopics": IPTC media topics array (array of strings)
  Example: ["medtop:15000000", "medtop:01000000"] - use standard IPTC codes if available
- "headline": Story title/headline (string)
- "byline": Author/byline information (string)
- "body_text": Content in plain text (string) - USE THIS OR body_html
- "body_html": Content with HTML markup (string) - USE THIS OR body_text
- "description_text": Description. Use this or description_html (string)
- "description_html": Description with HTML markup. Use this or description_text (string)
- "located": Single location as string (string)
- "places": Geo locations as JSON string with name, rel, geojson (string)
  Example: "[{\"name\": \"Pennsylvania\", \"rel\": \"direct\", \"geojson\": {\"type\": \"Point\", \"coordinates\": [-76.90567, 40.27245]}}]"
- "people": People as JSON string with name, rel (string)
  Example: "[{\"name\": \"Greg Lavin\", \"rel\": \"direct\"}]"
- "keywords": Keywords as JSON string array (string) - extract from categories/topics
  Example: "[\"Ecuador\", \"Chile\", \"migrants\"]"
- "embargoed": Embargo date in ISO format (string)
- "copyrightnotice": Copyright notice text (string)
- "usageterms": Usage terms text (string)
- "language": Content language using ISO-639-1 code, default "en" (string)
- "slugline": Human readable identifier (string)
- "href": URL linking to source (string)
- "ttl": Time to live timestamp (number) - Unix timestamp when content expires
- "revision": Revision number (number)
- "associations": Array with media assets (array) - DO NOT include, this will be handled by the lambda

ASSOCIATIONS FORMAT (for media assets):
{
  "byline": "media asset byline",
  "type": "image|video|audio",
  "headline": "asset title",
  "renditions": [{
    "uri": "link to asset (REQUIRED)",
    "mimetype": "asset mimetype (e.g., video/mp4)",
    "duration": "duration in seconds for video/audio",
    "videoaspectratio": "aspect ratio (e.g., 16:9)",
    "format": "format (e.g., fmt:mp4)",
    "height": "height in pixels",
    "width": "width in pixels", 
    "sizeinbytes": "file size in bytes",
    "filename": "filename",
    "videoPreviewUri": "low res preview URL",
    "thumbnailUri": "thumbnail image URL"
  }]
}

Common XML field mappings to look for:
- URI/ID: StoryNumber (PRIMARY), id, uri, guid, story_id, ItemID
- Headlines: Synopsis (PRIMARY), headline, title, Headline, story_title, Title
- Content: body_text, description, content, story_content, Script, Body
- Provider: provider, source, agency, network, Source
- Byline: byline, author, Byline, reporter, Author
- Timestamps: created, updated, published, date, CreatedDate, ModifiedDate
- Section: section, category, Section, Category
- Location: location, located, dateline, Location
- Keywords: keywords, tags, subjects, Keywords, Tags
- Slugline: Slug (PRIMARY), slugline, identifier

IMPORTANT FORMATTING RULES:
- Use body_html (not body_text) and format with <p> tags for paragraphs
- Use description_html (not description_text) for descriptions with <p> tags
- Always include required fields: uri, provider, infosource, versioncreated
- Set pubstatus to "usable" by default
- Use current ISO timestamp if creation dates not available (use get_current_timestamp tool)
- Provider names must be alphanumeric only (a-z, no spaces/symbols)
- EXTRACT ALL AVAILABLE OPTIONAL FIELDS - don't be conservative, include any field you can map from the XML

SPECIFIC DATA TYPE REQUIREMENTS:
- urgency: Must be a NUMBER (1-9), map "Primary"=1, "Secondary"=2, "Routine"=3
- priority: Must be a NUMBER (1-9), same as urgency
- version: Can be string or number
- revision: Must be a NUMBER, start with 1
- ttl: Must be a NUMBER (Unix timestamp), default to 30 days from now if not specified
- keywords: Must be ARRAY of strings, extract from Category field
- section: Extract from Category field as comma-separated string
- ednotes: Extract from notes/comments in XML
- slugline: Use Slug field from XML
- description_html: Format Synopsis with <p> tags
- located: Extract any location mentions from content (single location string)
- places: Extract locations with coordinates if possible, format as array with geojson
- people: Must be JSON STRING of objects with "name" and "rel" fields, extract all person names mentioned in content
  Example: "[{\"name\": \"Jimmy Kimmel\", \"rel\": \"direct\"}, {\"name\": \"Charlie Kirk\", \"rel\": \"mentioned\"}]"
- firstcreated: Use earliest timestamp available, or same as versioncreated
- copyrightnotice: Look for copyright information in XML
- usageterms: Look for usage/rights information in XML
- associations: DO NOT include video associations - lambda will handle video URLs. Only include if XML has image/audio assets.

Always return valid JSON in the exact Saga feeds format with AS MANY FIELDS AS POSSIBLE extracted from the XML."""

@tool
def get_current_timestamp() -> str:
    """Get the current timestamp in ISO format."""
    return datetime.now().isoformat() + "Z"

@tool
def send_stepfunctions_callback(task_token: str, result_data: str, feed_data: str = "{}") -> str:
    """Send success callback to Step Functions with processed data."""
    try:
        # Parse the result data to ensure it's valid JSON
        parsed_result = json.loads(result_data)
        
        # Prepare callback output
        callback_output = {
            'statusCode': 200,
            'mappedFeedData': parsed_result,
            'message': 'XML successfully mapped to Saga feeds format'
        }
        
        # Include original feedData if provided (preserves actualMp4Key from WaitForMp4Task)
        if feed_data:
            try:
                parsed_feed_data = json.loads(feed_data)
                callback_output['feedData'] = parsed_feed_data
            except json.JSONDecodeError:
                logger.warning("Could not parse feedData, skipping")
        
        # Send success callback
        stepfunctions.send_task_success(
            taskToken=task_token,
            output=json.dumps(callback_output)
        )
        
        return "Callback sent successfully to Step Functions"
        
    except Exception as e:
        logger.error(f"Error sending callback: {str(e)}")
        
        # Send failure callback
        try:
            stepfunctions.send_task_failure(
                taskToken=task_token,
                error='CallbackError',
                cause=str(e)
            )
        except Exception as callback_error:
            logger.error(f"Failed to send failure callback: {str(callback_error)}")
        
        return f"Failed to send callback: {str(e)}"

@app.entrypoint
def invoke(payload):
    """Main entrypoint for the XML Processing Agent."""
    task_token = payload.get("task_token")
    
    try:
        logger.info(f"XML Processing Agent invoked with payload keys: {list(payload.keys())}")
        
        # Create Bedrock model and agent inside the function to avoid initialization issues
        # Nova Pro requires specific parameters for reliable tool use
        bedrock_model = BedrockModel(
            model_id="amazon.nova-pro-v1:0",
            temperature=0,  # Greedy decoding required for Nova Pro tool use
            max_tokens=4000,  # Increased token limit for tool outputs
            streaming=False,
            additional_request_fields={
                "inferenceConfig": {
                    "topK": 1  # Additional greedy decoding parameter
                }
            }
        )
        
        agent = Agent(
            model=bedrock_model,
            tools=[get_current_timestamp, send_stepfunctions_callback],
            system_prompt=XML_MAPPING_SYSTEM_PROMPT
        )
        
        # Extract XML content
        xml_content = payload.get("xml_content", "")
        
        if not xml_content:
            raise ValueError("No XML content provided in payload")
        
        logger.info(f"Processing XML content with task token: {bool(task_token)}")
        
        # If we have a task token, process in background and return immediately
        if task_token:
            import threading
            
            def background_processing():
                try:
                    logger.info("Background processing started for XML mapping")
                    
                    # Create prompt for the agent to process XML content
                    user_message = f"""Please analyze and map the following XML content to the Saga feeds API format:

<xml_content>
{xml_content}
</xml_content>

IMPORTANT: Use "{payload.get('provider', 'ABC')}" as the provider name (extracted from S3 bucket prefix).

Return only the mapped JSON in the exact Saga feeds format. Use the send_stepfunctions_callback tool to send the result with task token: {task_token}

Also preserve this feedData in the callback: {json.dumps(payload.get('feedData', {}))}"""
                    
                    # Use agent to intelligently process the XML mapping
                    response = agent(user_message)
                    logger.info("Background XML processing completed successfully")
                    
                except Exception as e:
                    logger.error(f"Background processing error: {str(e)}")
                    try:
                        stepfunctions.send_task_failure(
                            taskToken=task_token,
                            error='ProcessingError',
                            cause=str(e)
                        )
                    except Exception as callback_error:
                        logger.error(f"Failed to send failure callback: {str(callback_error)}")
            
            thread = threading.Thread(target=background_processing, daemon=False)
            thread.start()
            
            logger.info("Background processing started, returning immediately")
            return {"status": "processing", "message": "XML processing started in background"}
        
        # Synchronous processing (no task token)
        user_message = f"""Please analyze and map the following XML content to the Saga feeds API format:

<xml_content>
{xml_content}
</xml_content>

IMPORTANT: Use "{payload.get('provider', 'ABC')}" as the provider name (extracted from S3 bucket prefix).

Return only the mapped JSON in the exact Saga feeds format."""
        
        response = agent(user_message)
        
        # Try to parse the response as JSON to validate it
        try:
            mapped_data = json.loads(str(response))
            result = {
                "result": mapped_data,
                "status": "success",
                "agent": "xml-processing-agent"
            }
        except json.JSONDecodeError:
            # If response isn't JSON, wrap it
            result = {
                "result": str(response),
                "status": "success", 
                "agent": "xml-processing-agent"
            }
        
        logger.info(f"Agent response (no callback): {json.dumps(result)}")
        return result
        
    except Exception as e:
        logger.error(f"Error in XML Processing Agent: {str(e)}")
        
        # If we have a task token, send failure callback
        if task_token:
            try:
                stepfunctions.send_task_failure(
                    taskToken=task_token,
                    error='AgentError',
                    cause=str(e)
                )
            except Exception as callback_error:
                logger.error(f"Failed to send failure callback: {str(callback_error)}")
        
        return {
            "error": str(e),
            "status": "error",
            "agent": "xml-processing-agent"
        }

# Note: no custom @app.ping handler — the BedrockAgentCoreApp default reports
# PingStatus.HEALTHY_BUSY while a task is running and PingStatus.HEALTHY otherwise.
# A custom handler must return a PingStatus enum (not a dict), or the SDK's
# _handle_ping crashes on status.value; the default already does the right thing.

if __name__ == "__main__":
    app.run()
