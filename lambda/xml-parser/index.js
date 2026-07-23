const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');
const { parseString } = require('xml2js');

const s3Client = new S3Client();
const sfnClient = new SFNClient();

exports.handler = async (event) => {
  console.log('XML Parser triggered:', JSON.stringify(event, null, 2));
  
  try {
    const bucket = event.Records[0].s3.bucket.name;
    const key = event.Records[0].s3.object.key;
    
    // Extract provider from S3 prefix (e.g., "ABC/120325095.xml" -> "ABC")
    const provider = key.includes('/') ? key.split('/')[0].toUpperCase() : 'ABC';
    console.log(`Extracted provider from S3 key "${key}": ${provider}`);
    
    // Get XML file
    const xmlResponse = await s3Client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key
    }));
    
    const xmlContent = await xmlResponse.Body.transformToString();
    
    // Parse XML
    const parsedXml = await new Promise((resolve, reject) => {
      parseString(xmlContent, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
    
    const newsStory = parsedXml.NewsStory;
    const storyNumber = newsStory.StoryNumber[0];
    const mp4Key = key.replace('.xml', '.mp4');
    
    // Extract metadata for Saga feed
    const feedData = {
      uri: storyNumber,
      infosource: "Pool Feed",
      provider: provider, // Use extracted provider from S3 prefix
      headline: newsStory.Slug[0],
      body_text: newsStory.Synopsis[0],
      firstcreated: new Date().toISOString(),
      versioncreated: new Date().toISOString(),
      language: "en",
      sourceBucket: bucket,
      xmlKey: key,
      mp4Key: mp4Key,
      destinationBucket: process.env.DESTINATION_BUCKET
    };
    
    // Start Step Functions execution
    const executionName = `saga-feed-${storyNumber}-${Date.now()}`;
    const input = { feedData };
    
    const command = new StartExecutionCommand({
      stateMachineArn: process.env.STATE_MACHINE_ARN,
      name: executionName,
      input: JSON.stringify(input)
    });
    
    const result = await sfnClient.send(command);
    console.log(`Started Step Functions execution: ${result.executionArn}`);
    
    return {
      statusCode: 200,
      executionArn: result.executionArn
    };
    
  } catch (error) {
    console.error('Error processing XML:', error);
    throw error;
  }
};
