# Chapterize Custom Action - Implementation Tasks

## Task Status Legend
- `[ ]` Not started
- `[~]` Queued
- `[-]` In progress
- `[x]` Completed

## 1. Infrastructure Setup

### 1.1 Create Lambda Function Directories
- [ ] 1.1.1 Create `lambda/chapterize-handler` directory
- [ ] 1.1.2 Create `lambda/mimir-logging-handler` directory

### 1.2 Create chapterize-handler Lambda
- [ ] 1.2.1 Create `lambda/chapterize-handler/index.js` with handler implementation
- [ ] 1.2.2 Create `lambda/chapterize-handler/package.json` with dependencies
- [ ] 1.2.3 Install dependencies: `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-secrets-manager`

### 1.3 Create mimir-logging-handler Lambda
- [ ] 1.3.1 Create `lambda/mimir-logging-handler/index.js` with handler implementation
- [ ] 1.3.2 Create `lambda/mimir-logging-handler/package.json` with dependencies
- [ ] 1.3.3 Install dependencies: `@aws-sdk/client-secrets-manager`

## 2. Update Existing Lambda Functions

### 2.1 Update mimir-handler
- [ ] 2.1.1 Add 'chapterize' case to switch statement in `lambda/mimir-handler/index.js`
- [ ] 2.1.2 Add video filtering logic for chapterize action
- [ ] 2.1.3 Add error handling for no video items found

## 3. CDK Infrastructure Updates

### 3.1 Add Lambda Function Definitions
- [ ] 3.1.1 Add chapterizeHandler Lambda function definition to `lib/infrastructure-stack.ts`
- [ ] 3.1.2 Add mimirLoggingHandler Lambda function definition to `lib/infrastructure-stack.ts`
- [ ] 3.1.3 Configure Lambda timeouts, memory, and ephemeral storage

### 3.2 Configure IAM Permissions
- [ ] 3.2.1 Grant Secrets Manager read permissions to chapterizeHandler
- [ ] 3.2.2 Grant Bedrock InvokeModel permissions to chapterizeHandler
- [ ] 3.2.3 Grant Secrets Manager read permissions to mimirLoggingHandler
- [ ] 3.2.4 Grant Step Functions invoke permissions to both Lambda functions

### 3.3 Create State Machine
- [ ] 3.3.1 Define StoreVariablesChapterize Pass state
- [ ] 3.3.2 Define GetMimirDetailsChapterize Lambda invoke task
- [ ] 3.3.3 Define ChapterizeContent Lambda invoke task
- [ ] 3.3.4 Define UpdateMimirWithChapters Lambda invoke task
- [ ] 3.3.5 Define CheckItemTypeChapterize Choice state
- [ ] 3.3.6 Define SkipItemChapterize Pass state
- [ ] 3.3.7 Define ChapterizeFailed Pass state
- [ ] 3.3.8 Define ProcessItemsChapterize Map state with max concurrency 3
- [ ] 3.3.9 Create processChapterizeStateMachine with complete definition
- [ ] 3.3.10 Set state machine timeout to 15 minutes

### 3.4 Update API Gateway
- [ ] 3.4.1 Add chapterize resource to actionsResource
- [ ] 3.4.2 Add POST method with Lambda integration to chapterize resource

### 3.5 Update mimir-handler Environment Variables
- [ ] 3.5.1 Add CHAPTERIZE_STATE_MACHINE_ARN to mimir-handler environment variables

### 3.6 Grant State Machine Permissions
- [ ] 3.6.1 Grant mimir-handler permission to start ChapterizeContent state machine

### 3.7 Add CloudFormation Outputs
- [ ] 3.7.1 Add ChapterizeEndpoint output with API URL
- [ ] 3.7.2 Add ChapterizeStateMachineArn output

## 4. Implementation Details

### 4.1 Implement chapterize-handler Logic
- [ ] 4.1.1 Implement getMimirApiKey() function with caching
- [ ] 4.1.2 Implement video download from proxyUrl
- [ ] 4.1.3 Implement base64 encoding of video buffer
- [ ] 4.1.4 Implement Bedrock prompt construction
- [ ] 4.1.5 Implement Bedrock API call with Twelve Labs Pegasus model
- [ ] 4.1.6 Implement chapter parsing from AI response
- [ ] 4.1.7 Implement chapter validation logic
- [ ] 4.1.8 Implement error handling and error response format
- [ ] 4.1.9 Add comprehensive logging

### 4.2 Implement mimir-logging-handler Logic
- [ ] 4.2.1 Implement getMimirApiKey() function with caching
- [ ] 4.2.2 Implement chapter ID generation logic
- [ ] 4.2.3 Implement timed metadata formatting per Mimir schema
- [ ] 4.2.4 Implement Mimir API call (PUT /api/v1/items/{id}/timedMetadata)
- [ ] 4.2.5 Implement error handling for API failures
- [ ] 4.2.6 Implement success response format
- [ ] 4.2.7 Add comprehensive logging


## 5. Testing

### 5.1 Unit Tests
- [ ] 5.1.1 Write tests for chapterize-handler video download
- [ ] 5.1.2 Write tests for chapterize-handler Bedrock integration
- [ ] 5.1.3 Write tests for chapterize-handler chapter parsing
- [ ] 5.1.4 Write tests for chapterize-handler error handling
- [ ] 5.1.5 Write tests for mimir-logging-handler chapter formatting
- [ ] 5.1.6 Write tests for mimir-logging-handler Mimir API integration
- [ ] 5.1.7 Write tests for mimir-logging-handler error handling
- [ ] 5.1.8 Write tests for mimir-handler action routing

### 5.2 Integration Tests
- [ ] 5.2.1 Test API Gateway endpoint with valid API key
- [ ] 5.2.2 Test API Gateway endpoint with invalid API key
- [ ] 5.2.3 Test state machine execution with single video
- [ ] 5.2.4 Test state machine execution with multiple videos
- [ ] 5.2.5 Test concurrent processing (max 3)
- [ ] 5.2.6 Test error handling and workflow continuation
- [ ] 5.2.7 Test end-to-end workflow from API to Mimir

### 5.3 Manual Testing
- [ ] 5.3.1 Test with short video (< 1 minute)
- [ ] 5.3.2 Test with medium video (5-10 minutes)
- [ ] 5.3.3 Test with long video (30+ minutes)
- [ ] 5.3.4 Test with press conference video
- [ ] 5.3.5 Test with action sequence video
- [ ] 5.3.6 Verify chapters appear in Mimir UI
- [ ] 5.3.7 Verify chapter timestamps are accurate
- [ ] 5.3.8 Verify chapter titles are descriptive
- [ ] 5.3.9 Test error handling with invalid video URL
- [ ] 5.3.10 Test error handling with corrupted video

## 6. Deployment

### 6.1 Pre-Deployment
- [ ] 6.1.1 Verify parameters.json contains Mimir API key
- [ ] 6.1.2 Verify AWS credentials are configured
- [ ] 6.1.3 Install root dependencies: `npm install`
- [ ] 6.1.4 Install chapterize-handler dependencies
- [ ] 6.1.5 Install mimir-logging-handler dependencies
- [ ] 6.1.6 Build CDK: `npm run build`
- [ ] 6.1.7 Review changes: `npx cdk diff`

### 6.2 Deployment
- [ ] 6.2.1 Deploy infrastructure: `npx cdk deploy --all --require-approval never`
- [ ] 6.2.2 Verify deployment success
- [ ] 6.2.3 Note ChapterizeEndpoint output URL
- [ ] 6.2.4 Note ChapterizeStateMachineArn output

### 6.3 Post-Deployment Verification
- [ ] 6.3.1 Verify Lambda functions exist in AWS Console
- [ ] 6.3.2 Verify State Machine exists in Step Functions Console
- [ ] 6.3.3 Verify API Gateway resource exists
- [ ] 6.3.4 Test API endpoint with curl
- [ ] 6.3.5 Check CloudWatch Logs are being created
- [ ] 6.3.6 Verify IAM permissions are correct
- [ ] 6.3.7 Test with sample video from Mimir

## 7. Documentation

### 7.1 Code Documentation
- [ ] 7.1.1 Add JSDoc comments to chapterize-handler functions
- [ ] 7.1.2 Add JSDoc comments to mimir-logging-handler functions
- [ ] 7.1.3 Add inline comments for complex logic
- [ ] 7.1.4 Document Bedrock prompt design decisions

### 7.2 User Documentation
- [ ] 7.2.1 Update CUSTOM_ACTIONS_GUIDE.md with chapterize action
- [ ] 7.2.2 Create user guide for configuring action in Mimir
- [ ] 7.2.3 Create user guide for using chapterize action
- [ ] 7.2.4 Document expected chapter output format

### 7.3 Developer Documentation
- [ ] 7.3.1 Document architecture in README
- [ ] 7.3.2 Document deployment process
- [ ] 7.3.3 Document debugging procedures
- [ ] 7.3.4 Document cost estimates

## 8. Monitoring and Observability

### 8.1 CloudWatch Configuration
- [ ] 8.1.1 Verify Lambda log groups are created
- [ ] 8.1.2 Verify State Machine log group is created
- [ ] 8.1.3 Set log retention to 7 days
- [ ] 8.1.4 Create CloudWatch dashboard for chapterize metrics

### 8.2 Alarms
- [ ] 8.2.1 Create alarm for chapterize-handler error rate > 10%
- [ ] 8.2.2 Create alarm for chapterize-handler duration > 14 minutes
- [ ] 8.2.3 Create alarm for mimir-logging-handler error rate > 5%
- [ ] 8.2.4 Create alarm for ChapterizeContent execution failures > 3/hour
- [ ] 8.2.5 Create alarm for API Gateway 5XX errors > 5/minute

### 8.3 Metrics
- [ ] 8.3.1 Monitor Lambda invocation counts
- [ ] 8.3.2 Monitor Lambda duration metrics
- [ ] 8.3.3 Monitor Lambda error rates
- [ ] 8.3.4 Monitor State Machine execution metrics
- [ ] 8.3.5 Monitor API Gateway request metrics

## 9. Optimization

### 9.1 Performance Optimization
- [ ] 9.1.1 Optimize video download (use streaming if possible)
- [ ] 9.1.2 Optimize base64 encoding (use buffers efficiently)
- [ ] 9.1.3 Optimize chapter parsing (improve regex/JSON parsing)
- [ ] 9.1.4 Review Lambda memory allocation
- [ ] 9.1.5 Review Lambda timeout settings

### 9.2 Cost Optimization
- [ ] 9.2.1 Use proxy URLs instead of high-res when possible
- [ ] 9.2.2 Implement CloudWatch Logs retention policies
- [ ] 9.2.3 Monitor Bedrock usage and costs
- [ ] 9.2.4 Review Lambda memory vs. duration tradeoffs
- [ ] 9.2.5 Consider batch processing for cost savings

## 10. Security Review

### 10.1 Security Audit
- [ ] 10.1.1 Review IAM permissions (least privilege)
- [ ] 10.1.2 Verify Secrets Manager encryption
- [ ] 10.1.3 Verify API key validation logic
- [ ] 10.1.4 Review input validation in all handlers
- [ ] 10.1.5 Verify no sensitive data in logs
- [ ] 10.1.6 Review error messages (no info leakage)

### 10.2 Compliance
- [ ] 10.2.1 Verify HTTPS for all API calls
- [ ] 10.2.2 Verify data encryption in transit
- [ ] 10.2.3 Verify no data persistence (ephemeral only)
- [ ] 10.2.4 Document data handling procedures

## 11. Rollback Plan

### 11.1 Rollback Preparation
- [ ] 11.1.1 Document current infrastructure state
- [ ] 11.1.2 Create rollback script
- [ ] 11.1.3 Test rollback procedure in dev environment
- [ ] 11.1.4 Document rollback steps

### 11.2 Rollback Execution (if needed)
- [ ] 11.2.1 Stop incoming requests to chapterize endpoint
- [ ] 11.2.2 Rollback CloudFormation stack
- [ ] 11.2.3 Verify previous version is working
- [ ] 11.2.4 Document rollback reason and lessons learned

## 12. Future Enhancements (Optional)

### 12.1 Chapter Quality Improvements
- [ ]* 12.1.1 Add confidence scores for each chapter
- [ ]* 12.1.2 Support manual chapter editing
- [ ]* 12.1.3 Add chapter thumbnail generation
- [ ]* 12.1.4 Support chapter descriptions

### 12.2 Performance Improvements
- [ ]* 12.2.1 Implement video preprocessing
- [ ]* 12.2.2 Cache Bedrock responses
- [ ]* 12.2.3 Implement streaming video analysis
- [ ]* 12.2.4 Add parallel processing optimization

### 12.3 Feature Additions
- [ ]* 12.3.1 Support audio-only content
- [ ]* 12.3.2 Multi-language chapter titles
- [ ]* 12.3.3 Chapter export to SRT/VTT
- [ ]* 12.3.4 Integration with video editing tools

## Task Summary

**Total Tasks**: 150+
**Required Tasks**: 120
**Optional Tasks**: 30+

**Estimated Timeline**:
- Infrastructure Setup: 2-3 hours
- Lambda Implementation: 4-6 hours
- CDK Updates: 2-3 hours
- Testing: 3-4 hours
- Deployment: 1-2 hours
- Documentation: 2-3 hours
- Monitoring Setup: 1-2 hours

**Total Estimated Time**: 15-23 hours

## Notes

- Tasks marked with `*` are optional enhancements
- Complete tasks in order for dependencies
- Test thoroughly before deploying to production
- Monitor CloudWatch logs during initial deployment
- Keep Mimir API key secure in Secrets Manager
- Follow existing code patterns from summarizer implementation
