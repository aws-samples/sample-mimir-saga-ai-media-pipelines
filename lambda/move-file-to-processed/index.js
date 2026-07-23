const { S3Client, CopyObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const s3Client = new S3Client({});

exports.handler = async (event) => {
    console.log('Event received:', JSON.stringify(event, null, 2));
    
    try {
        const { detail } = event;
        const sourceBucket = detail.bucket.name;
        const sourceKey = detail.object.key;
        const destinationBucket = process.env.DESTINATION_BUCKET;
        
        // Extract provider from bucket name (e.g., saga-feeds-abc-source-... -> ABC)
        const bucketParts = sourceBucket.split('-');
        const provider = bucketParts[2].toUpperCase(); // abc -> ABC
        
        // Extract date components from event time (ISO format: 2025-12-29T20:52:16Z)
        const eventTime = new Date(event.time);
        const year = eventTime.getUTCFullYear();
        const month = String(eventTime.getUTCMonth() + 1).padStart(2, '0'); // getUTCMonth() returns 0-11
        const day = String(eventTime.getUTCDate()).padStart(2, '0');
        
        // Create destination key with folder structure: year/month/day/provider/filename
        const destinationKey = `${year}/${month}/${day}/${provider}/${sourceKey}`;
        
        console.log(`Moving file from ${sourceBucket}/${sourceKey} to ${destinationBucket}/${destinationKey}`);
        
        // Copy the file to the destination with proper folder structure
        const copyCommand = new CopyObjectCommand({
            CopySource: `${sourceBucket}/${sourceKey}`,
            Bucket: destinationBucket,
            Key: destinationKey
        });
        
        const copyResult = await s3Client.send(copyCommand);
        console.log('File copied successfully:', copyResult);
        
        // Delete the source file
        const deleteCommand = new DeleteObjectCommand({
            Bucket: sourceBucket,
            Key: sourceKey
        });
        
        const deleteResult = await s3Client.send(deleteCommand);
        console.log('Source file deleted successfully:', deleteResult);
        
        // Return the original event with additional metadata
        return {
            ...event,
            processedFile: {
                destinationBucket,
                destinationKey,
                provider,
                year,
                month,
                day
            }
        };
        
    } catch (error) {
        console.error('Error processing file:', error);
        throw error;
    }
};
