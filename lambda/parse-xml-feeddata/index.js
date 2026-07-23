const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { parseString } = require('xml2js');

const s3Client = new S3Client();

exports.handler = async (event) => {
  console.log('Event received:', JSON.stringify(event, null, 2));
  
  // Get processed file location from the event
  const { processedFile } = event;
  
  if (!processedFile) {
    throw new Error('processedFile information not found in event');
  }
  
  const bucket = processedFile.destinationBucket;
  const key = processedFile.destinationKey;
  const provider = processedFile.provider;
  
  console.log(`Reading XML from processed location: ${bucket}/${key}`);
  
  // Get XML file from processed location
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
  const fileName = processedFile.fileName;
  
  return {
    feedData: {
      uri: storyNumber,
      provider: provider,
      headline: newsStory.Slug[0],
      body_text: newsStory.Synopsis[0],
      firstcreated: new Date().toISOString(),
      versioncreated: new Date().toISOString(),
      xmlKey: fileName,
      destinationBucket: bucket,
      processedXmlKey: key
    }
  };
};
