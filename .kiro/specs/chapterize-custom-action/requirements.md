# Chapterize Custom Action - Requirements

## 1. Feature Overview

Create a new Mimir custom action called "chapterize" that automatically generates video chapters using AI-powered scene detection. The action will analyze video content using Twelve Labs API via Amazon Bedrock, identify logical scene changes and topic transitions, and create chapter markers in Mimir using the logging API.

## 2. User Stories

### 2.1 As a Mimir user
I want to select one or more video items and run the "chapterize" action so that chapters are automatically created at logical scene transitions and topic changes.

### 2.2 As a video editor
I want the system to analyze long-form content (like press conferences) and create chapters at different topic areas so that I can quickly navigate to specific segments.

### 2.3 As a content manager
I want chapters to be created based on scene detection and subject changes so that viewers can easily find relevant sections in long videos.

## 3. Acceptance Criteria

### 3.1 API Gateway Integration
- **AC 3.1.1**: A new resource path `/actions/chapterize` MUST be added to the existing API Gateway (deployed by this stack)
- **AC 3.1.2**: The endpoint MUST accept POST requests with the standard Mimir custom action payload format
- **AC 3.1.3**: The endpoint MUST validate requests using the existing API Gateway key authentication mechanism
- **AC 3.1.4**: The endpoint MUST return a 200 status with execution details upon successful invocation

### 3.2 Lambda Handler Updates
- **AC 3.2.1**: The `mimir-handler` Lambda function MUST recognize the "chapterize" action type from the resource path
- **AC 3.2.2**: The handler MUST filter items to process only video items (itemType === 'video')
- **AC 3.2.3**: The handler MUST start the appropriate Step Functions state machine for chapterize workflow
- **AC 3.2.4**: The handler MUST return appropriate error messages if no video items are found

### 3.3 State Machine Workflow
- **AC 3.3.1**: A new Step Functions state machine named "ChapterizeContent" MUST be created
- **AC 3.3.2**: The state machine MUST follow the same pattern as "SummarizeContent" workflow
- **AC 3.3.3**: The workflow MUST:
  - Store input variables (items, userToken, actionData, userId, userEmail, apiGatewayKey, mimirApiKey)
  - Get Mimir item details for each video
  - Invoke the chapterize Lambda function to analyze video and generate chapters
  - Invoke the logging update Lambda function to create chapters in Mimir
- **AC 3.3.4**: The state machine MUST process multiple items with a max concurrency of 3
- **AC 3.3.5**: The state machine MUST handle errors gracefully and continue processing remaining items

### 3.4 Chapterize Lambda Function
- **AC 3.4.1**: A new Lambda function named "chapterize-handler" MUST be created
- **AC 3.4.2**: The function MUST use Node.js 22.x runtime (lambda.Runtime.NODEJS_22_X)
- **AC 3.4.3**: The function MUST have a timeout of 15 minutes (maximum)
- **AC 3.4.4**: The function MUST have 10GB memory allocation
- **AC 3.4.5**: The function MUST have 10GB ephemeral storage
- **AC 3.4.6**: The function MUST retrieve the Mimir API key from Secrets Manager using the environment variable
- **AC 3.4.7**: The function MUST download the video from the provided URL
- **AC 3.4.8**: The function MUST call Twelve Labs API via Bedrock with a scene detection prompt
- **AC 3.4.9**: The function MUST parse the AI response to extract chapter information (timestamps and titles)
- **AC 3.4.10**: The function MUST return structured chapter data including:
  - Item ID
  - Array of chapters with startMs, endMs, and title
  - Timestamp of processing
  - Model used

### 3.5 Scene Detection Prompt
- **AC 3.5.1**: The prompt MUST instruct the AI to analyze video for scene changes and subject transitions
- **AC 3.5.2**: The prompt MUST request chapter markers at logical breakpoints
- **AC 3.5.3**: For press conferences or similar content, the prompt MUST identify different topic areas
- **AC 3.5.4**: The prompt MUST request descriptive chapter titles
- **AC 3.5.5**: The prompt MUST request timestamps in milliseconds

### 3.6 Logging Update Lambda Function
- **AC 3.6.1**: A new Lambda function named "mimir-logging-handler" MUST be created
- **AC 3.6.2**: The function MUST use Node.js 22.x runtime
- **AC 3.6.3**: The function MUST have a timeout of 30 seconds
- **AC 3.6.4**: The function MUST retrieve the Mimir API key from Secrets Manager
- **AC 3.6.5**: The function MUST call the Mimir logging API (PUT `/api/v1/items/{itemId}/timedMetadata`)
- **AC 3.6.6**: The function MUST format chapter data according to the UpdateTimedMetadataRequestDto schema:
  - Each chapter as a TimedMetadataItem with unique ID, startMs, endMs, and data
  - Data must include formId and formData with chapter title
- **AC 3.6.7**: The function MUST handle API errors and return appropriate error messages
- **AC 3.6.8**: The function MUST return success confirmation with item ID and number of chapters created

### 3.7 IAM Permissions
- **AC 3.7.1**: The chapterize-handler Lambda MUST have permissions to:
  - Read from Secrets Manager (Mimir API key)
  - Invoke Bedrock models
- **AC 3.7.2**: The mimir-logging-handler Lambda MUST have permissions to:
  - Read from Secrets Manager (Mimir API key)
- **AC 3.7.3**: The Step Functions state machine MUST have permissions to:
  - Invoke all Lambda functions in the workflow
- **AC 3.7.4**: The mimir-handler Lambda MUST have permissions to:
  - Start execution of the ChapterizeContent state machine

### 3.8 Error Handling
- **AC 3.8.1**: If video download fails, the function MUST return an error with details
- **AC 3.8.2**: If Bedrock API call fails, the function MUST return an error with details
- **AC 3.8.3**: If chapter parsing fails, the function MUST return an error with details
- **AC 3.8.4**: If Mimir logging API call fails, the function MUST return an error with details
- **AC 3.8.5**: Errors MUST NOT stop processing of other items in the batch

### 3.9 Configuration
- **AC 3.9.1**: The Mimir API key MUST be read from the parameters.json file during deployment
- **AC 3.9.2**: The Mimir API key MUST be stored in AWS Secrets Manager
- **AC 3.9.3**: All Lambda functions MUST receive the Secrets Manager ARN via environment variables
- **AC 3.9.4**: The state machine ARN MUST be passed to mimir-handler via environment variable

### 3.10 Naming Conventions
- **AC 3.10.1**: Lambda functions MUST follow the naming pattern: `{action}-handler`
- **AC 3.10.2**: State machine MUST be named: `ChapterizeContent`
- **AC 3.10.3**: API resource path MUST be: `/actions/chapterize`
- **AC 3.10.4**: Lambda function names MUST be explicitly set (not CDK-generated)

## 4. Technical Constraints

### 4.1 AWS Services
- Must use existing API Gateway instance
- Must use AWS Lambda with Node.js 22.x runtime
- Must use AWS Step Functions for workflow orchestration
- Must use AWS Secrets Manager for API key storage
- Must use Amazon Bedrock for AI model invocation

### 4.2 External APIs
- Must use Twelve Labs Pegasus model via Bedrock
- Must use Mimir REST API for logging/timed metadata
- Must authenticate with Mimir using API key from Secrets Manager

### 4.3 Video Processing
- Must support video files accessible via pre-signed URLs
- Must handle videos up to the Lambda ephemeral storage limit (10GB)
- Must base64 encode video for Twelve Labs API

### 4.4 Integration
- Must follow existing patterns from summarizer implementation
- Must reuse existing mimir-details-handler Lambda
- Must integrate with existing infrastructure stack

## 5. Dependencies

### 5.1 Existing Resources
- API Gateway: Deployed by this CDK stack (`/prod/actions`)
- Lambda: `mimir-handler`
- Lambda: `mimir-details-handler`
- Secrets Manager: Mimir API key secret
- Parameters file: `parameters.json`

### 5.2 External Services
- Mimir API: `https://<your-instance>.mjoll.no/api/v1`
- Amazon Bedrock: Twelve Labs Pegasus model
- Twelve Labs API: Scene detection capabilities

### 5.3 Reference Documentation
- Mimir OpenAPI spec: `reference/openapi-mimir.json`
- Existing summarizer implementation for patterns

## 6. Out of Scope

### 6.1 Not Included in This Feature
- Manual chapter editing UI
- Chapter preview before saving
- Custom chapter templates
- Audio-only content chapterization
- Real-time chapter generation during upload
- Chapter export to external formats
- Multi-language chapter titles
- Chapter thumbnail generation

## 7. Success Metrics

### 7.1 Functional Metrics
- Successfully processes video items and creates chapters
- Chapters are visible in Mimir logging interface
- Chapter timestamps align with scene changes
- Chapter titles are descriptive and accurate

### 7.2 Performance Metrics
- Processing completes within 15 minutes per video
- API response time < 30 seconds for workflow initiation
- State machine execution completes successfully for 95%+ of requests

### 7.3 Quality Metrics
- Chapters are created at logical breakpoints
- Chapter titles accurately describe content
- No duplicate or overlapping chapters
- Proper error handling and logging
