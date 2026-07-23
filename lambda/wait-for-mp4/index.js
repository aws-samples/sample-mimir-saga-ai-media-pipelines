const { S3Client, HeadObjectCommand, CopyObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const s3Client = new S3Client();

exports.handler = async (event) => {
  console.log('Waiting for MP4:', JSON.stringify(event, null, 2));
  
  try {
    const { feedData } = event;
    const { sourceBucket, mp4Key, xmlKey, destinationBucket } = feedData;
    
    // Extract story ID from XML key (e.g., "120325095.xml" -> "120325095")
    const storyId = xmlKey.replace('.xml', '');
    
    let actualMp4Key = mp4Key;
    let mp4Found = false;
    let mp4Location = 'source'; // Track where we found the MP4
    
    // First try exact match in source bucket
    try {
      await s3Client.send(new HeadObjectCommand({
        Bucket: sourceBucket,
        Key: mp4Key
      }));
      mp4Found = true;
      mp4Location = 'source';
      console.log(`Found exact MP4 match in source: ${mp4Key}`);
    } catch (error) {
      if (error.name === 'NotFound') {
        console.log(`Exact MP4 not found in source: ${mp4Key}, searching for files with story ID: ${storyId}`);
        
        // Search for MP4 files in source bucket that contain the story ID
        try {
          const listResponse = await s3Client.send(new ListObjectsV2Command({
            Bucket: sourceBucket,
            Prefix: storyId // Start with story ID
          }));
          
          // Find MP4 files that contain the story ID
          const mp4Files = listResponse.Contents?.filter(obj => 
            obj.Key.includes(storyId) && obj.Key.toLowerCase().endsWith('.mp4')
          ) || [];
          
          if (mp4Files.length > 0) {
            actualMp4Key = mp4Files[0].Key; // Use first match
            mp4Found = true;
            mp4Location = 'source';
            console.log(`Found MP4 with suffix in source: ${actualMp4Key}`);
          }
        } catch (listError) {
          console.log('Error listing objects in source:', listError);
        }
        
        // If not found in source, check destination bucket for existing processed files
        if (!mp4Found) {
          console.log(`MP4 not found in source, checking destination bucket for existing processed files across all dates`);
          try {
            // Search across entire destination bucket for story ID (not just today's date)
            const destListResponse = await s3Client.send(new ListObjectsV2Command({
              Bucket: destinationBucket
              // No prefix - search entire bucket
            }));
            
            // Find MP4 files that contain the story ID
            const destMp4Files = destListResponse.Contents?.filter(obj => 
              obj.Key.includes(storyId) && obj.Key.toLowerCase().endsWith('.mp4')
            ) || [];
            
            if (destMp4Files.length > 0) {
              actualMp4Key = destMp4Files[0].Key; // Use first match
              mp4Found = true;
              mp4Location = 'destination';
              console.log(`Found existing MP4 in destination: ${actualMp4Key}`);
            }
          } catch (destListError) {
            console.log('Error listing objects in destination:', destListError);
          }
        }
      } else {
        throw error;
      }
    }
    
    if (mp4Found) {
      // Create year/month/day prefix for destination
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      const datePrefix = `${year}/${month}/${day}`;
      
      // Create destination keys with date prefix
      const destXmlKey = `${datePrefix}/${xmlKey}`;
      const destMp4Key = mp4Location === 'destination' ? actualMp4Key : `${datePrefix}/${actualMp4Key}`;
      
      console.log(`Processing files - MP4 location: ${mp4Location}, destination prefix: ${datePrefix}`);
      
      // Always copy/update XML file
      await s3Client.send(new CopyObjectCommand({
        CopySource: `${sourceBucket}/${xmlKey}`,
        Bucket: destinationBucket,
        Key: destXmlKey
      }));
      
      // Only copy MP4 if it's in source bucket (not already in destination)
      if (mp4Location === 'source') {
        await s3Client.send(new CopyObjectCommand({
          CopySource: `${sourceBucket}/${actualMp4Key}`,
          Bucket: destinationBucket,
          Key: destMp4Key
        }));
        
        console.log('Files copied successfully, now deleting from source bucket');
        
        // Delete source files after successful copy
        await s3Client.send(new DeleteObjectCommand({
          Bucket: sourceBucket,
          Key: actualMp4Key
        }));
      } else {
        console.log('MP4 already in destination, only copying XML and deleting source XML');
      }
      
      // Always delete source XML
      await s3Client.send(new DeleteObjectCommand({
        Bucket: sourceBucket,
        Key: xmlKey
      }));
      
      console.log('Source files cleaned up successfully');
      
      return {
        ...event,
        feedData: {
          ...feedData,
          hasVideo: true,
          videoUrl: `s3://${destinationBucket}/${destMp4Key}`,
          actualMp4Key: destMp4Key, // Update to destination key
          processedXmlKey: destXmlKey, // Add processed XML key
          datePrefix: datePrefix, // Include date prefix for reference
          mp4Location: mp4Location // Track where MP4 was found
        },
        mp4Ready: true
      };
    } else {
      // MP4 not ready yet, return for retry
      console.log(`No MP4 file found for story ID: ${storyId}`);
      return {
        ...event,
        mp4Ready: false
      };
    }
    
  } catch (error) {
    console.error('Error waiting for MP4:', error);
    throw error;
  }
};
