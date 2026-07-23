# Chapterize Custom Action - Design Document

## 1. Architecture Overview

### 1.1 System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Mimir Platform                              │
│                    (User selects videos & triggers action)               │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ POST /actions/chapterize
                                 │ (items, userToken, actionData, etc.)
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         API Gateway (Existing)                           │
│              https://<api-id>.execute-api.<region>.amazonaws.com         │
│                      /prod/actions/chapterize                            │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ Validates API Key
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      mimir-handler Lambda                                │
│  - Extracts action type from path                                       │
│  - Filters for video items only                                         │
│  - Starts ChapterizeContent state machine                               │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ Starts execution
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                  ChapterizeContent State Machine                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ 1. Store Variables (Pass state)                                  │  │
│  └────────────────────────────┬─────────────────────────────────────┘  │
│                                ▼                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ 2. Process Items (Map state, max concurrency: 3)                 │  │
│  │    ┌──────────────────────────────────────────────────────────┐ │  │
│  │    │ For each video item:                                      │ │  │
│  │    │   a. Check Item Type (Choice)                             │ │  │
│  │    │   b. Get Mimir Details (Lambda)                           │ │  │
│  │    │   c. Chapterize Content (Lambda)                          │ │  │
│  │    │   d. Update Mimir Logging (Lambda)                        │ │  │
│  │    └──────────────────────────────────────────────────────────┘ │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Component Interactions

```
mimir-handler
     │
     ├─> Secrets Manager (get API keys)
     ├─> Step Functions (start ChapterizeContent)
     │
     └─> ChapterizeContent State Machine
             │
             ├─> mimir-details-handler (existing)
             │       └─> Mimir API (GET /api/v1/items/{id})
             │
             ├─> chapterize-handler (new)
             │       ├─> Download video from URL
             │       ├─> Bedrock (Twelve Labs Pegasus)
             │       └─> Parse AI response for chapters
             │
             └─> mimir-logging-handler (new)
                     └─> Mimir API (PUT /api/v1/items/{id}/timedMetadata)
```

## 2. Data Models

### 2.1 Input Payload (from Mimir)

```json
{
  "items": [
    {
      "id": "uuid",
      "itemType": "video",
      "metadata": {}
    }
  ],
  "userToken": "string",
  "actionData": {},
  "userId": "uuid",
  "userEmail": "string"
}
```

### 2.2 Mimir Item Details Response

```json
{
  "id": "uuid",
  "title": "string",
  "itemType": "video",
  "proxyUrl": "https://...",
  "highResUrl": "https://...",
  "lowResUrl": "https://...",
  "mediaDuration": 120000,
  "metadata": {}
}
```

### 2.3 Chapter Data Structure

```json
{
  "id": "uuid",
  "title": "string",
  "chapters": [
    {
      "id": "chapter-uuid-1",
      "startMs": 0,
      "endMs": 30000,
      "title": "Introduction"
    },
    {
      "id": "chapter-uuid-2",
      "startMs": 30000,
      "endMs": 90000,
      "title": "Main Topic Discussion"
    }
  ],
  "modelUsed": "twelvelabs.pegasus-1-2-v1:0",
  "timestamp": "2026-01-16T..."
}
```


### 2.4 Mimir Timed Metadata Request

```json
{
  "items": {
    "chapter-uuid-1": {
      "id": "chapter-uuid-1",
      "startMs": 0,
      "endMs": 30000,
      "data": {
        "formId": "chapter-form-id",
        "formData": {
          "title": "Introduction"
        }
      }
    },
    "chapter-uuid-2": {
      "id": "chapter-uuid-2",
      "startMs": 30000,
      "endMs": 90000,
      "data": {
        "formId": "chapter-form-id",
        "formData": {
          "title": "Main Topic Discussion"
        }
      }
    }
  }
}
```

## 3. Component Design

### 3.1 API Gateway Configuration

**Resource Path**: `/actions/chapterize`
**Method**: POST
**Integration**: Lambda (mimir-handler)
**Authentication**: X-API-Key header validation

**CORS Configuration**:
- Allow-Origin: *
- Allow-Methods: POST, OPTIONS
- Allow-Headers: Content-Type, X-API-Key, Authorization

### 3.2 mimir-handler Lambda Updates

**Changes Required**:
1. Add new case in switch statement for 'chapterize' action
2. Add environment variable: `CHAPTERIZE_STATE_MACHINE_ARN`
3. Filter items for video type only
4. Start ChapterizeContent state machine

**Code Addition**:
```javascript
case 'chapterize':
  stateMachineArn = process.env.CHAPTERIZE_STATE_MACHINE_ARN;
  filteredItems = items.filter(item => item.itemType === 'video');
  if (filteredItems.length === 0) {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        message: 'No video items found to process for chapterize',
        status: 'success',
        processedItems: []
      })
    };
  }
  break;
```

### 3.3 chapterize-handler Lambda

**Function Name**: `chapterize-handler`
**Runtime**: Node.js 22.x
**Timeout**: 15 minutes
**Memory**: 10240 MB
**Ephemeral Storage**: 10240 MB

**Environment Variables**:
- `MIMIR_API_KEY_SECRET_ARN`: ARN of Mimir API key in Secrets Manager

**Input**:
```json
{
  "itemDetails": {
    "id": "uuid",
    "title": "string",
    "proxyUrl": "https://...",
    "mediaDuration": 120000
  },
  "mimirApiKey": "string"
}
```

**Output**:
```json
{
  "id": "uuid",
  "title": "string",
  "chapters": [...],
  "modelUsed": "twelvelabs.pegasus-1-2-v1:0",
  "timestamp": "2026-01-16T..."
}
```

**Processing Steps**:
1. Download video from proxyUrl
2. Base64 encode video content
3. Call Bedrock with Twelve Labs Pegasus model
4. Parse AI response to extract chapters
5. Return structured chapter data

**Bedrock Prompt**:
```
Analyze this video and create chapters at logical scene changes and topic transitions.

For each chapter, provide:
1. Start time in milliseconds
2. End time in milliseconds  
3. A descriptive title (5-10 words)

Guidelines:
- Create chapters at major scene changes or when the subject/topic changes
- For press conferences or interviews, create chapters for different topic areas
- For action sequences, create chapters for different activities or locations
- Aim for 3-10 chapters depending on video length
- Each chapter should be at least 10 seconds long
- Chapter titles should be clear and descriptive

Return the response in JSON format:
{
  "chapters": [
    {"startMs": 0, "endMs": 30000, "title": "Opening Remarks"},
    {"startMs": 30000, "endMs": 90000, "title": "Main Discussion"}
  ]
}
```


### 3.4 mimir-logging-handler Lambda

**Function Name**: `mimir-logging-handler`
**Runtime**: Node.js 22.x
**Timeout**: 30 seconds
**Memory**: 512 MB

**Environment Variables**:
- `MIMIR_API_KEY_SECRET_ARN`: ARN of Mimir API key in Secrets Manager

**Input**:
```json
{
  "itemId": "uuid",
  "chapters": [
    {
      "startMs": 0,
      "endMs": 30000,
      "title": "Introduction"
    }
  ],
  "mimirApiKey": "string"
}
```

**Output**:
```json
{
  "itemId": "uuid",
  "chaptersCreated": 5,
  "status": "success",
  "timestamp": "2026-01-16T..."
}
```

**Processing Steps**:
1. Retrieve Mimir API key from Secrets Manager
2. Generate unique IDs for each chapter
3. Format chapters according to UpdateTimedMetadataRequestDto schema
4. Call Mimir API: PUT `/api/v1/items/{itemId}/timedMetadata`
5. Return success confirmation

**Mimir API Call**:
```javascript
const timedMetadataItems = {};
chapters.forEach(chapter => {
  const chapterId = `${itemId}-${chapter.startMs}-${chapter.endMs}`;
  timedMetadataItems[chapterId] = {
    id: chapterId,
    startMs: chapter.startMs,
    endMs: chapter.endMs,
    data: {
      formId: 'chapter', // Default chapter form ID
      formData: {
        title: chapter.title
      }
    }
  };
});

const requestBody = {
  items: timedMetadataItems
};

// PUT https://mimir.mjoll.no/api/v1/items/{itemId}/timedMetadata
```

### 3.5 ChapterizeContent State Machine

**State Machine Name**: `ChapterizeContent`
**Type**: Standard
**Timeout**: 15 minutes

**State Definitions**:

```json
{
  "Comment": "Chapterize video content workflow",
  "StartAt": "StoreVariablesChapterize",
  "States": {
    "StoreVariablesChapterize": {
      "Type": "Pass",
      "Parameters": {
        "items.$": "$.items",
        "userToken.$": "$.userToken",
        "actionData.$": "$.actionData",
        "userId.$": "$.userId",
        "userEmail.$": "$.userEmail",
        "apiGatewayKey.$": "$.apiGatewayKey",
        "mimirApiKey.$": "$.mimirApiKey",
        "actionType.$": "$.actionType"
      },
      "Next": "ProcessItemsChapterize"
    },
    "ProcessItemsChapterize": {
      "Type": "Map",
      "ItemsPath": "$.items",
      "MaxConcurrency": 3,
      "Iterator": {
        "StartAt": "CheckItemTypeChapterize",
        "States": {
          "CheckItemTypeChapterize": {
            "Type": "Choice",
            "Choices": [
              {
                "Variable": "$.itemType",
                "StringEquals": "video",
                "Next": "GetMimirDetailsChapterize"
              }
            ],
            "Default": "SkipItemChapterize"
          },
          "GetMimirDetailsChapterize": {
            "Type": "Task",
            "Resource": "arn:aws:states:::lambda:invoke",
            "Parameters": {
              "FunctionName": "mimir-details-handler-infra",
              "Payload": {
                "id.$": "$.id",
                "itemType.$": "$.itemType",
                "metadata.$": "$.metadata",
                "mimirApiKey.$": "$.Execution.Input.mimirApiKey"
              }
            },
            "OutputPath": "$.Payload",
            "Next": "ChapterizeContent"
          },
          "ChapterizeContent": {
            "Type": "Task",
            "Resource": "arn:aws:states:::lambda:invoke",
            "Parameters": {
              "FunctionName": "chapterize-handler",
              "Payload": {
                "itemDetails.$": "$",
                "mimirApiKey.$": "$.Execution.Input.mimirApiKey"
              }
            },
            "OutputPath": "$.Payload",
            "Catch": [
              {
                "ErrorEquals": ["States.ALL"],
                "Next": "ChapterizeFailed"
              }
            ],
            "Next": "UpdateMimirWithChapters"
          },
          "UpdateMimirWithChapters": {
            "Type": "Task",
            "Resource": "arn:aws:states:::lambda:invoke",
            "Parameters": {
              "FunctionName": "mimir-logging-handler",
              "Payload": {
                "itemId.$": "$.id",
                "chapters.$": "$.chapters",
                "mimirApiKey.$": "$.Execution.Input.mimirApiKey"
              }
            },
            "End": true
          },
          "SkipItemChapterize": {
            "Type": "Pass",
            "Result": {
              "status": "skipped",
              "reason": "Not a video item"
            },
            "End": true
          },
          "ChapterizeFailed": {
            "Type": "Pass",
            "Result": {
              "status": "failed",
              "reason": "Chapterization failed"
            },
            "End": true
          }
        }
      },
      "End": true
    }
  }
}
```


## 4. Infrastructure as Code (CDK)

### 4.1 Lambda Function Definitions

```typescript
// Lambda function for chapterizing content
const chapterizeHandler = new lambda.Function(this, 'ChapterizeHandler', {
  functionName: 'chapterize-handler',
  runtime: lambda.Runtime.NODEJS_22_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('lambda/chapterize-handler'),
  timeout: cdk.Duration.minutes(15),
  memorySize: 10240,
  ephemeralStorageSize: cdk.Size.mebibytes(10240),
  environment: {
    MIMIR_API_KEY_SECRET_ARN: mimirApiKeySecret.secretArn,
  },
});

// Lambda function for updating Mimir with chapters
const mimirLoggingHandler = new lambda.Function(this, 'MimirLoggingHandler', {
  functionName: 'mimir-logging-handler',
  runtime: lambda.Runtime.NODEJS_22_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('lambda/mimir-logging-handler'),
  timeout: cdk.Duration.seconds(30),
  environment: {
    MIMIR_API_KEY_SECRET_ARN: mimirApiKeySecret.secretArn,
  },
});
```

### 4.2 IAM Permissions

```typescript
// Grant permissions to chapterize handler
chapterizeHandler.grantInvoke(new iam.ServicePrincipal('states.amazonaws.com'));
mimirApiKeySecret.grantRead(chapterizeHandler);
chapterizeHandler.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['bedrock:InvokeModel'],
  resources: ['*'],
}));

// Grant permissions to logging handler
mimirLoggingHandler.grantInvoke(new iam.ServicePrincipal('states.amazonaws.com'));
mimirApiKeySecret.grantRead(mimirLoggingHandler);

// Update mimir-handler with new state machine
processChapterizeStateMachine.grantStartExecution(mimirHandler);
```

### 4.3 State Machine Definition

```typescript
// Chapterize State Machine
const storeVariablesChapterize = new stepfunctions.Pass(this, 'StoreVariablesChapterize', {
  parameters: {
    'items.$': '$.items',
    'userToken.$': '$.userToken',
    'actionData.$': '$.actionData',
    'userId.$': '$.userId',
    'userEmail.$': '$.userEmail',
    'apiGatewayKey.$': '$.apiGatewayKey',
    'mimirApiKey.$': '$.mimirApiKey',
    'actionType.$': '$.actionType'
  }
});

const getMimirDetailsChapterize = new stepfunctionsTasks.LambdaInvoke(this, 'GetMimirDetailsChapterize', {
  lambdaFunction: mimirDetailsHandler,
  payload: stepfunctions.TaskInput.fromObject({
    'id.$': '$.id',
    'itemType.$': '$.itemType',
    'metadata.$': '$.metadata',
    'mimirApiKey.$': '$.Execution.Input.mimirApiKey'
  }),
  outputPath: '$.Payload'
});

const chapterizeContent = new stepfunctionsTasks.LambdaInvoke(this, 'ChapterizeContent', {
  lambdaFunction: chapterizeHandler,
  payload: stepfunctions.TaskInput.fromObject({
    'itemDetails.$': '$',
    'mimirApiKey.$': '$.Execution.Input.mimirApiKey'
  }),
  outputPath: '$.Payload'
});

const updateMimirWithChapters = new stepfunctionsTasks.LambdaInvoke(this, 'UpdateMimirWithChapters', {
  lambdaFunction: mimirLoggingHandler,
  payload: stepfunctions.TaskInput.fromObject({
    'itemId.$': '$.id',
    'chapters.$': '$.chapters',
    'mimirApiKey.$': '$.Execution.Input.mimirApiKey'
  })
});

const chapterizeFailed = new stepfunctions.Pass(this, 'ChapterizeFailed', {
  result: stepfunctions.Result.fromObject({ 
    status: 'failed', 
    reason: 'Chapterization failed' 
  })
});

const skipItemChapterize = new stepfunctions.Pass(this, 'SkipItemChapterize', {
  result: stepfunctions.Result.fromObject({ 
    status: 'skipped', 
    reason: 'Not a video item' 
  })
});

const checkItemTypeChapterize = new stepfunctions.Choice(this, 'CheckItemTypeChapterize')
  .when(
    stepfunctions.Condition.stringEquals('$.itemType', 'video'),
    getMimirDetailsChapterize
      .next(chapterizeContent.addCatch(chapterizeFailed))
      .next(updateMimirWithChapters)
  )
  .otherwise(skipItemChapterize);

const processItemsChapterize = new stepfunctions.Map(this, 'ProcessItemsChapterize', {
  itemsPath: stepfunctions.JsonPath.stringAt('$.items'),
  maxConcurrency: 3
}).iterator(checkItemTypeChapterize);

const chapterizeDefinition = storeVariablesChapterize.next(processItemsChapterize);

const processChapterizeStateMachine = new stepfunctions.StateMachine(this, 'ProcessChapterizeStateMachine', {
  stateMachineName: 'ChapterizeContent',
  definition: chapterizeDefinition,
  timeout: cdk.Duration.minutes(15)
});
```

### 4.4 API Gateway Resource

```typescript
// POST /actions/chapterize endpoint
const chapterizeResource = actionsResource.addResource('chapterize');
chapterizeResource.addMethod('POST', new apigateway.LambdaIntegration(mimirHandler));
```

### 4.5 Environment Variable Update

```typescript
// Update mimir-handler environment variables
const mimirHandler = new lambda.Function(this, 'MimirCustomActionHandler', {
  functionName: 'mimir-handler',
  runtime: lambda.Runtime.NODEJS_22_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('lambda/mimir-handler'),
  timeout: cdk.Duration.seconds(30),
  environment: {
    API_KEY_SECRET_ARN: apiKeySecret.secretArn,
    MIMIR_API_KEY_SECRET_ARN: mimirApiKeySecret.secretArn,
    SUMMARIZER_STATE_MACHINE_ARN: processSummarizerStateMachine.stateMachineArn,
    CHAPTERIZE_STATE_MACHINE_ARN: processChapterizeStateMachine.stateMachineArn,
  },
});
```

### 4.6 CloudFormation Outputs

```typescript
new cdk.CfnOutput(this, 'ChapterizeEndpoint', {
  value: api.url + 'actions/chapterize',
  description: 'Mimir Chapterize Custom Action Endpoint URL',
});

new cdk.CfnOutput(this, 'ChapterizeStateMachineArn', {
  value: processChapterizeStateMachine.stateMachineArn,
  description: 'Step Functions state machine for content chapterization workflow',
});
```


## 5. Implementation Details

### 5.1 chapterize-handler Implementation

**File**: `lambda/chapterize-handler/index.js`

```javascript
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const bedrockClient = new BedrockRuntimeClient();
const secretsClient = new SecretsManagerClient();

let cachedMimirApiKey = null;

async function getMimirApiKey() {
  if (cachedMimirApiKey) return cachedMimirApiKey;
  
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: process.env.MIMIR_API_KEY_SECRET_ARN })
  );
  cachedMimirApiKey = response.SecretString;
  return cachedMimirApiKey;
}

exports.handler = async (event) => {
  console.log('Chapterize handler received:', JSON.stringify(event, null, 2));
  
  try {
    const { itemDetails, mimirApiKey } = event;
    
    // Download video from proxy URL
    const videoUrl = itemDetails.proxyUrl;
    console.log('Downloading video from URL:', videoUrl);
    
    const videoResponse = await fetch(videoUrl);
    if (!videoResponse.ok) {
      throw new Error(`Failed to download video: ${videoResponse.status} ${videoResponse.statusText}`);
    }
    
    const videoBuffer = await videoResponse.arrayBuffer();
    const base64Video = Buffer.from(videoBuffer).toString('base64');
    
    console.log('Video downloaded and encoded, size:', Math.round(videoBuffer.byteLength / 1024), 'KB');

    // Prepare prompt for scene detection and chapter creation
    const prompt = `Analyze this video and create chapters at logical scene changes and topic transitions.

For each chapter, provide:
1. Start time in milliseconds
2. End time in milliseconds  
3. A descriptive title (5-10 words)

Guidelines:
- Create chapters at major scene changes or when the subject/topic changes
- For press conferences or interviews, create chapters for different topic areas
- For action sequences, create chapters for different activities or locations
- Aim for 3-10 chapters depending on video length
- Each chapter should be at least 10 seconds long
- Chapter titles should be clear and descriptive

Return the response in JSON format:
{
  "chapters": [
    {"startMs": 0, "endMs": 30000, "title": "Opening Remarks"},
    {"startMs": 30000, "endMs": 90000, "title": "Main Discussion"}
  ]
}`;

    // Call Bedrock with Twelve Labs Pegasus model
    const modelId = 'twelvelabs.pegasus-1-2-v1:0';
    
    const requestBody = {
      inputPrompt: prompt,
      mediaSource: {
        base64String: base64Video
      },
      temperature: 0.3
    };
    
    const command = new InvokeModelCommand({
      modelId: modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(requestBody)
    });
    
    console.log('Calling Bedrock with model:', modelId);
    const bedrockResponse = await bedrockClient.send(command);
    
    // Parse the response
    const responseBody = JSON.parse(new TextDecoder().decode(bedrockResponse.body));
    console.log('Bedrock response:', responseBody);
    
    // Extract chapters from response
    let chapters = [];
    const responseText = responseBody.message || responseBody.completion || responseBody.text || '';
    
    try {
      // Try to parse JSON from response
      const jsonMatch = responseText.match(/\{[\s\S]*"chapters"[\s\S]*\}/);
      if (jsonMatch) {
        const parsedResponse = JSON.parse(jsonMatch[0]);
        chapters = parsedResponse.chapters || [];
      }
    } catch (parseError) {
      console.error('Failed to parse chapters from response:', parseError);
      throw new Error('Failed to extract chapters from AI response');
    }
    
    // Validate chapters
    if (!chapters || chapters.length === 0) {
      throw new Error('No chapters generated from video analysis');
    }
    
    // Ensure chapters have required fields
    chapters = chapters.map((chapter, index) => ({
      startMs: chapter.startMs || 0,
      endMs: chapter.endMs || itemDetails.mediaDuration || 0,
      title: chapter.title || `Chapter ${index + 1}`
    }));
    
    console.log(`Generated ${chapters.length} chapters`);
    
    return {
      id: itemDetails.id,
      title: itemDetails.title,
      chapters: chapters,
      modelUsed: modelId,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    console.error('Error in chapterize handler:', error);
    
    // Return error information but don't fail the entire workflow
    return {
      id: event.itemDetails?.id || 'unknown',
      title: event.itemDetails?.title || 'Unknown',
      chapters: [],
      error: true,
      errorMessage: error.message,
      timestamp: new Date().toISOString()
    };
  }
};
```


### 5.2 mimir-logging-handler Implementation

**File**: `lambda/mimir-logging-handler/index.js`

```javascript
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const secretsClient = new SecretsManagerClient();

let cachedMimirApiKey = null;

async function getMimirApiKey() {
  if (cachedMimirApiKey) return cachedMimirApiKey;
  
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: process.env.MIMIR_API_KEY_SECRET_ARN })
  );
  cachedMimirApiKey = response.SecretString;
  return cachedMimirApiKey;
}

exports.handler = async (event) => {
  console.log('Mimir logging handler received:', JSON.stringify(event, null, 2));
  
  try {
    const { itemId, chapters, mimirApiKey } = event;
    
    if (!chapters || chapters.length === 0) {
      console.log('No chapters to create');
      return {
        itemId: itemId,
        chaptersCreated: 0,
        status: 'success',
        message: 'No chapters to create',
        timestamp: new Date().toISOString()
      };
    }
    
    // Get Mimir API key
    const apiKey = mimirApiKey || await getMimirApiKey();
    
    // Format chapters according to Mimir's timed metadata schema
    const timedMetadataItems = {};
    
    chapters.forEach(chapter => {
      // Generate unique ID for each chapter
      const chapterId = `${itemId}-${chapter.startMs}-${chapter.endMs}`;
      
      timedMetadataItems[chapterId] = {
        id: chapterId,
        startMs: chapter.startMs,
        endMs: chapter.endMs,
        data: {
          formId: 'chapter', // Default chapter form ID
          formData: {
            title: chapter.title
          }
        }
      };
    });
    
    const requestBody = {
      items: timedMetadataItems
    };
    
    console.log('Updating Mimir with chapters:', JSON.stringify(requestBody, null, 2));
    
    // Call Mimir API to update timed metadata
    const mimirUrl = `https://mimir.mjoll.no/api/v1/items/${itemId}/timedMetadata`;
    
    const response = await fetch(mimirUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-mimir-cognito-id-token': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Mimir API error: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    console.log(`Successfully created ${chapters.length} chapters in Mimir`);
    
    return {
      itemId: itemId,
      chaptersCreated: chapters.length,
      status: 'success',
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    console.error('Error in mimir logging handler:', error);
    
    // Return error but don't fail the workflow
    return {
      itemId: event.itemId || 'unknown',
      chaptersCreated: 0,
      status: 'error',
      error: true,
      errorMessage: error.message,
      timestamp: new Date().toISOString()
    };
  }
};
```

### 5.3 Package Dependencies

**File**: `lambda/chapterize-handler/package.json`

```json
{
  "name": "chapterize-handler",
  "version": "1.0.0",
  "description": "Lambda function to chapterize video content using Bedrock",
  "main": "index.js",
  "dependencies": {
    "@aws-sdk/client-bedrock-runtime": "^3.0.0",
    "@aws-sdk/client-secrets-manager": "^3.0.0"
  }
}
```

**File**: `lambda/mimir-logging-handler/package.json`

```json
{
  "name": "mimir-logging-handler",
  "version": "1.0.0",
  "description": "Lambda function to update Mimir with chapter logging data",
  "main": "index.js",
  "dependencies": {
    "@aws-sdk/client-secrets-manager": "^3.0.0"
  }
}
```

## 6. Error Handling

### 6.1 Error Scenarios and Responses

| Error Scenario | Handler | Response | Impact |
|---------------|---------|----------|--------|
| Invalid API Key | mimir-handler | 401 Unauthorized | Request rejected |
| No video items | mimir-handler | 200 with empty result | Graceful skip |
| Video download fails | chapterize-handler | Error object returned | Item skipped, others continue |
| Bedrock API fails | chapterize-handler | Error object returned | Item skipped, others continue |
| Chapter parsing fails | chapterize-handler | Error object returned | Item skipped, others continue |
| Mimir API fails | mimir-logging-handler | Error object returned | Item skipped, others continue |
| State machine timeout | Step Functions | Execution fails | Logged for review |

### 6.2 Error Response Format

```json
{
  "id": "item-uuid",
  "title": "Video Title",
  "chapters": [],
  "error": true,
  "errorMessage": "Detailed error message",
  "timestamp": "2026-01-16T..."
}
```

### 6.3 Retry Strategy

- **Lambda Invocations**: No automatic retries (handled by Step Functions)
- **Step Functions**: Catch errors and continue with next item
- **Bedrock API**: Single attempt per video (timeout: 15 minutes)
- **Mimir API**: Single attempt per update (timeout: 30 seconds)


## 7. Testing Strategy

### 7.1 Unit Tests

**chapterize-handler Tests**:
- Test video download and encoding
- Test Bedrock API integration
- Test chapter parsing from AI response
- Test error handling for invalid responses
- Test error handling for download failures

**mimir-logging-handler Tests**:
- Test Mimir API integration
- Test chapter formatting
- Test error handling for API failures
- Test handling of empty chapter arrays

**mimir-handler Tests**:
- Test action type extraction
- Test video filtering
- Test state machine invocation
- Test error responses

### 7.2 Integration Tests

**End-to-End Workflow**:
1. Send POST request to `/actions/chapterize` with test video items
2. Verify state machine execution starts
3. Verify mimir-details-handler is invoked
4. Verify chapterize-handler processes video
5. Verify mimir-logging-handler updates Mimir
6. Verify chapters appear in Mimir UI

**API Gateway Tests**:
- Test valid API key authentication
- Test invalid API key rejection
- Test CORS headers
- Test request/response format

**State Machine Tests**:
- Test single video processing
- Test multiple video processing
- Test concurrent execution (max 3)
- Test error handling and continuation
- Test timeout scenarios

### 7.3 Manual Testing Checklist

- [ ] Deploy infrastructure to AWS
- [ ] Verify API Gateway endpoint is accessible
- [ ] Test with short video (< 1 minute)
- [ ] Test with medium video (5-10 minutes)
- [ ] Test with long video (30+ minutes)
- [ ] Test with press conference video
- [ ] Test with action sequence video
- [ ] Verify chapters appear in Mimir
- [ ] Verify chapter timestamps are accurate
- [ ] Verify chapter titles are descriptive
- [ ] Test error handling with invalid video URL
- [ ] Test error handling with corrupted video
- [ ] Monitor CloudWatch logs for errors
- [ ] Monitor Step Functions execution history

### 7.4 Performance Testing

**Metrics to Monitor**:
- Lambda execution duration (chapterize-handler)
- Lambda memory usage
- Bedrock API response time
- State machine execution time
- API Gateway response time
- Error rate per 100 executions

**Expected Performance**:
- API Gateway response: < 1 second (async)
- Video download: 10-60 seconds (depends on size)
- Bedrock processing: 2-10 minutes (depends on video length)
- Mimir API update: < 5 seconds
- Total workflow: 3-15 minutes per video

## 8. Deployment Plan

### 8.1 Pre-Deployment Checklist

- [ ] Verify parameters.json contains Mimir API key
- [ ] Verify AWS credentials are configured
- [ ] Verify CDK is bootstrapped in target account
- [ ] Review infrastructure-stack.ts changes
- [ ] Create lambda/chapterize-handler directory and files
- [ ] Create lambda/mimir-logging-handler directory and files
- [ ] Update lambda/mimir-handler/index.js
- [ ] Install Lambda dependencies (npm install in each lambda dir)
- [ ] Run `npm run build` to compile TypeScript
- [ ] Run `cdk diff` to review changes

### 8.2 Deployment Steps

```bash
# 1. Navigate to project directory
cd /path/to/fonn-group-custom-actions

# 2. Install root dependencies
npm install

# 3. Create Lambda function directories
mkdir -p lambda/chapterize-handler
mkdir -p lambda/mimir-logging-handler

# 4. Create Lambda function files
# (Create index.js and package.json in each directory)

# 5. Install Lambda dependencies
cd lambda/chapterize-handler && npm install && cd ../..
cd lambda/mimir-logging-handler && npm install && cd ../..

# 6. Build CDK
npm run build

# 7. Review changes
npx cdk diff

# 8. Deploy
npx cdk deploy --all --require-approval never

# 9. Verify deployment
# Check CloudFormation outputs for new endpoint URL
```

### 8.3 Post-Deployment Verification

- [ ] Verify ChapterizeEndpoint output URL
- [ ] Verify ChapterizeStateMachineArn output
- [ ] Test API endpoint with curl or Postman
- [ ] Check Lambda functions exist in AWS Console
- [ ] Check State Machine exists in Step Functions Console
- [ ] Verify IAM permissions are correct
- [ ] Test with sample video from Mimir
- [ ] Monitor CloudWatch logs for first execution
- [ ] Verify chapters appear in Mimir

### 8.4 Rollback Plan

If deployment fails or issues are discovered:

```bash
# Option 1: Rollback via CloudFormation
aws cloudformation rollback-stack --stack-name InfrastructureStack

# Option 2: Redeploy previous version
git checkout <previous-commit>
npm run build
npx cdk deploy --all

# Option 3: Manual cleanup
# - Delete new Lambda functions
# - Delete new State Machine
# - Remove API Gateway resource
# - Revert mimir-handler code
```

## 9. Monitoring and Observability

### 9.1 CloudWatch Metrics

**Lambda Metrics**:
- Invocations
- Duration
- Errors
- Throttles
- Concurrent Executions
- Memory Usage

**Step Functions Metrics**:
- ExecutionsStarted
- ExecutionsSucceeded
- ExecutionsFailed
- ExecutionTime

**API Gateway Metrics**:
- Count (requests)
- 4XXError
- 5XXError
- Latency

### 9.2 CloudWatch Logs

**Log Groups**:
- `/aws/lambda/chapterize-handler`
- `/aws/lambda/mimir-logging-handler`
- `/aws/lambda/mimir-handler`
- `/aws/states/ChapterizeContent`

**Log Retention**: 7 days (configurable)

### 9.3 Alarms

**Recommended CloudWatch Alarms**:
1. chapterize-handler error rate > 10%
2. chapterize-handler duration > 14 minutes
3. mimir-logging-handler error rate > 5%
4. ChapterizeContent execution failures > 3 per hour
5. API Gateway 5XX errors > 5 per minute

### 9.4 Debugging

**Common Issues and Solutions**:

| Issue | Symptom | Solution |
|-------|---------|----------|
| Video too large | Lambda timeout | Increase ephemeral storage or use smaller proxy |
| Bedrock quota exceeded | Throttling errors | Request quota increase or add retry logic |
| Invalid chapter format | Parsing errors | Update prompt or add fallback parsing |
| Mimir API auth fails | 401 errors | Verify API key in Secrets Manager |
| State machine timeout | Execution timeout | Increase timeout or optimize processing |


## 10. Security Considerations

### 10.1 Authentication and Authorization

**API Gateway**:
- X-API-Key header validation
- API key stored in Secrets Manager
- Rotatable API keys

**Mimir API**:
- Bearer token authentication
- API key stored in Secrets Manager
- Separate key per environment

**IAM Roles**:
- Least privilege principle
- Separate roles per Lambda function
- No wildcard permissions except Bedrock (required)

### 10.2 Data Security

**In Transit**:
- HTTPS for all API calls
- TLS 1.2+ for Mimir API
- Encrypted Bedrock API calls

**At Rest**:
- Secrets Manager encryption (AWS managed keys)
- Lambda environment variables encrypted
- No sensitive data in logs

**Video Content**:
- Downloaded to Lambda ephemeral storage
- Automatically deleted after execution
- Not persisted to S3 or other storage
- Base64 encoded for Bedrock transmission

### 10.3 Input Validation

**mimir-handler**:
- Validate request body structure
- Validate API key format
- Validate items array exists
- Filter for video items only

**chapterize-handler**:
- Validate video URL format
- Validate video size (< 10GB)
- Validate Bedrock response structure
- Sanitize chapter titles

**mimir-logging-handler**:
- Validate chapter array structure
- Validate timestamp ranges
- Validate chapter IDs are unique
- Sanitize form data

### 10.4 Rate Limiting

**API Gateway**:
- Default throttling: 10,000 requests/second
- Burst: 5,000 requests
- Per-client rate limiting via API key

**Bedrock**:
- Model-specific quotas
- Automatic throttling by AWS
- Retry with exponential backoff

**Step Functions**:
- Max concurrency: 3 (configurable)
- Prevents overwhelming Bedrock API
- Prevents overwhelming Mimir API

## 11. Cost Estimation

### 11.1 AWS Service Costs

**Lambda**:
- chapterize-handler: ~$0.20 per video (15 min @ 10GB)
- mimir-logging-handler: ~$0.001 per video (30 sec @ 512MB)
- mimir-handler: ~$0.0001 per request (< 1 sec @ 512MB)

**Bedrock (Twelve Labs Pegasus)**:
- ~$0.05-0.15 per minute of video analyzed
- Average 5-minute video: ~$0.25-0.75

**Step Functions**:
- $0.025 per 1,000 state transitions
- ~10 transitions per video: ~$0.0003

**API Gateway**:
- $3.50 per million requests
- Negligible for typical usage

**Secrets Manager**:
- $0.40 per secret per month
- 2 secrets: $0.80/month

**CloudWatch Logs**:
- $0.50 per GB ingested
- ~10MB per video: ~$0.005

**Total Estimated Cost per Video**: ~$0.50-1.00

### 11.2 Cost Optimization

**Strategies**:
1. Use proxy URLs (lower resolution) instead of high-res
2. Implement caching for frequently accessed videos
3. Batch process videos during off-peak hours
4. Set appropriate Lambda memory (don't over-provision)
5. Use CloudWatch Logs retention policies
6. Monitor and optimize Bedrock usage

## 12. Future Enhancements

### 12.1 Potential Improvements

**Chapter Quality**:
- Add confidence scores for each chapter
- Support manual chapter editing
- Add chapter thumbnail generation
- Support chapter descriptions (not just titles)

**Performance**:
- Implement video preprocessing (compression)
- Cache Bedrock responses for similar videos
- Parallel processing of multiple videos
- Streaming video analysis (not full download)

**Features**:
- Support for audio-only content
- Multi-language chapter titles
- Chapter export to SRT/VTT format
- Integration with video editing tools
- Automatic chapter validation

**User Experience**:
- Preview chapters before saving
- Adjust chapter boundaries in UI
- Merge/split chapters
- Chapter templates for common video types
- Bulk chapter operations

### 12.2 Technical Debt

**Known Limitations**:
- Video size limited to 10GB (Lambda ephemeral storage)
- Processing time limited to 15 minutes (Lambda timeout)
- No retry logic for transient Bedrock failures
- Chapter form ID hardcoded ('chapter')
- No support for custom chapter metadata fields

**Recommended Refactoring**:
- Extract Bedrock client to shared layer
- Create reusable Mimir API client
- Implement circuit breaker pattern
- Add comprehensive error codes
- Create shared TypeScript types

## 13. Documentation

### 13.1 User Documentation

**Mimir Custom Action Setup**:
1. Navigate to Mimir settings
2. Add custom action with endpoint URL
3. Configure action name: "Chapterize"
4. Set action icon and description
5. Test with sample video

**Using the Chapterize Action**:
1. Select one or more video items in Mimir
2. Click "Actions" dropdown
3. Select "Chapterize"
4. Wait for processing (notification when complete)
5. View chapters in video player timeline

### 13.2 Developer Documentation

**Adding New Custom Actions**:
- Follow the pattern established by chapterize
- Create Lambda handlers in `lambda/` directory
- Update `mimir-handler` with new action case
- Create State Machine definition
- Add API Gateway resource
- Update CDK infrastructure
- Add tests and documentation

**Debugging Guide**:
- Check CloudWatch Logs for Lambda errors
- Review Step Functions execution history
- Verify Secrets Manager contains valid keys
- Test Mimir API calls with curl
- Monitor Bedrock quotas and throttling

### 13.3 API Documentation

**Endpoint**: `POST /actions/chapterize`

**Headers**:
```
Content-Type: application/json
X-API-Key: <your-api-key>
```

**Request Body**:
```json
{
  "items": [
    {
      "id": "uuid",
      "itemType": "video",
      "metadata": {}
    }
  ],
  "userToken": "string",
  "actionData": {},
  "userId": "uuid",
  "userEmail": "string"
}
```

**Response**:
```json
{
  "message": "Started processing 2 items with chapterize action",
  "status": "success",
  "executionArn": "arn:aws:states:...",
  "itemsToProcess": 2,
  "actionType": "chapterize"
}
```

## 14. Acceptance Criteria Mapping

| Requirement ID | Design Section | Implementation |
|---------------|----------------|----------------|
| AC 3.1.1 | 3.1, 4.4 | API Gateway resource |
| AC 3.1.2 | 3.1 | POST method configuration |
| AC 3.1.3 | 3.2, 10.1 | API key validation |
| AC 3.2.1 | 3.2 | mimir-handler switch case |
| AC 3.2.2 | 3.2 | Video filtering logic |
| AC 3.3.1-3.3.5 | 3.5, 4.3 | State machine definition |
| AC 3.4.1-3.4.10 | 3.3, 5.1 | chapterize-handler Lambda |
| AC 3.5.1-3.5.5 | 3.3 | Bedrock prompt design |
| AC 3.6.1-3.6.8 | 3.4, 5.2 | mimir-logging-handler Lambda |
| AC 3.7.1-3.7.4 | 4.2 | IAM permissions |
| AC 3.8.1-3.8.5 | 6.1, 6.2 | Error handling |
| AC 3.9.1-3.9.4 | 4.1, 4.5 | Configuration management |
| AC 3.10.1-3.10.4 | 4.1, 4.3, 4.4 | Naming conventions |

## 15. Conclusion

This design document provides a comprehensive blueprint for implementing the chapterize custom action feature. The architecture follows established patterns from the existing summarizer implementation while introducing new capabilities for video chapter generation using AI-powered scene detection.

Key design decisions:
- Reuse existing infrastructure (API Gateway, Secrets Manager, mimir-details-handler)
- Follow naming conventions and patterns from summarizer
- Implement robust error handling to prevent workflow failures
- Use Twelve Labs Pegasus model via Bedrock for scene detection
- Store chapters as timed metadata in Mimir
- Support concurrent processing with appropriate limits

The implementation is ready to proceed with the tasks outlined in the next phase.
