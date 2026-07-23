# Mimir Custom Actions API Guide

This API Gateway supports multiple custom actions for Mimir. The current structure allows you to easily add new custom actions.

## Current API Structure

- **Base URL**: `https://your-api-gateway-url/prod/actions/`
- **Summarizer Action**: `POST /actions/summarizer`
- **Chapterize Action**: `POST /actions/chapterize`
- **Rough Cut Action**: `POST /actions/rough-cut`

## Adding New Custom Actions

To add a new custom action, follow these steps:

### 1. Create Lambda Function

Create a new Lambda function in the `lambda/` directory:

```javascript
// lambda/your-new-action/index.js
const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-API-Key,Authorization',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

exports.handler = async (event) => {
  console.log('Received request for new action:', JSON.stringify(event, null, 2));
  
  try {
    const body = JSON.parse(event.body);
    const { items, userToken, actionData, userId, userEmail } = body;
    
    // Your custom action logic here
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        message: 'Custom action completed successfully',
        status: 'success',
        processedItems: items.length
      })
    };
    
  } catch (error) {
    console.error('Error processing request:', error);
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        message: 'Error processing action: ' + error.message,
        status: 'error'
      })
    };
  }
};
```

### 2. Update Infrastructure Stack

Add the new Lambda function and endpoint to `lib/infrastructure-stack.ts`:

```typescript
// Add after the existing mimirHandler Lambda function
const yourNewActionHandler = new lambda.Function(this, 'YourNewActionHandler', {
  functionName: 'your-new-action-handler',
  runtime: lambda.Runtime.NODEJS_22_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('lambda/your-new-action'),
  timeout: cdk.Duration.seconds(30),
  environment: {
    // Add any environment variables your action needs
  },
});

// Add the API Gateway endpoint
const yourNewActionResource = actionsResource.addResource('your-new-action');
yourNewActionResource.addMethod('POST', new apigateway.LambdaIntegration(yourNewActionHandler));
```

### 3. Add Output (Optional)

Add an output for the new endpoint:

```typescript
new cdk.CfnOutput(this, 'YourNewActionEndpoint', {
  value: api.url + 'actions/your-new-action',
  description: 'Your New Custom Action Endpoint URL',
});
```

### 4. Deploy

Deploy the updated infrastructure:

```bash
npm run build
cdk deploy FonnGroupCustomActionsStack
```

## Current Endpoints

### Summarizer Action
- **Endpoint**: `POST /actions/summarizer`
- **Description**: Generates summaries for content using Bedrock Twelve Labs Pegasus model
- **Handler**: `lambda/mimir-handler/index.js` → `SummarizeContent` State Machine
- **Supported Items**: Video, audio, and text items

### Chapterize Action
- **Endpoint**: `POST /actions/chapterize`
- **Description**: Generates chapter markers for video content using Bedrock
- **Handler**: `lambda/mimir-handler/index.js` → `ChapterizeContent` State Machine
- **Supported Items**: Video items only

### Rough Cut Action
- **Endpoint**: `POST /actions/rough-cut`
- **Description**: Generates a rough cut timeline from a Saga story using AgentCore
- **Handler**: `lambda/saga-action-handler/index.js` → `RoughCutTimeline` State Machine
- **Supported Items**: Saga stories with video assets

## State Machine Workflows

### Summarizer Workflow (`SummarizeContent`)
1. Store input variables
2. Process items in parallel (max 3 concurrent)
3. For each supported item:
   - Get Mimir item details
   - Call Bedrock Twelve Labs Pegasus for summarization
   - Update original Mimir item with generated summary

### Chapterize Workflow (`ChapterizeContent`)
1. Store input variables
2. Process items in parallel (max 3 concurrent)
3. For each video item:
   - Get Mimir item details
   - Call Bedrock for chapter detection
   - Update Mimir item with timed metadata chapters

### Rough Cut Workflow (`RoughCutTimeline`)
1. Fetch story context from Saga API
2. Evaluate asset readiness (embeddings + transcripts)
3. Invoke AgentCore rough cut agent (script analysis → source material → timeline assembly)
4. Create Mimir item with sequence details

## Example Request Format

All custom actions should expect the following request format from Mimir:

```json
{
  "items": [
    {
      "id": "item-id",
      "itemType": "video",
      "metadata": {
        // Item metadata
      }
    }
  ],
  "userToken": "user-token",
  "actionData": {
    // Action-specific data
  },
  "userId": "user-id",
  "userEmail": "user@example.com"
}
```

## Response Format

All custom actions should return responses in this format:

```json
{
  "message": "Action completed successfully",
  "status": "success|error",
  "processedItems": 1,
  // Additional action-specific data
}
```

## Authentication

All endpoints require the `X-API-Key` header with the API Gateway key stored in AWS Secrets Manager.
