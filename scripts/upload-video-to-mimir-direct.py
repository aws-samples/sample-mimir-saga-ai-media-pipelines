import os
import requests
import boto3

def upload_video_to_mimir_direct(item_id, s3_bucket, s3_key, api_key, mimir_base_url=None):
    """Upload video from S3 to Mimir item without downloading to Lambda"""
    if mimir_base_url is None:
        mimir_base_url = os.environ.get("MIMIR_API_BASE", "https://us.mjoll.no")
    
    # Get file size
    s3 = boto3.client('s3')
    response = s3.head_object(Bucket=s3_bucket, Key=s3_key)
    file_size = response['ContentLength']
    
    # Get upload lock
    headers = {'x-mimir-cognito-id-token': f'Bearer {api_key}', 'Content-Type': 'application/json'}
    upload_lock_payload = {"fileSize": file_size, "originalFileName": s3_key.split('/')[-1]}
    
    lock_response = requests.put(f"{mimir_base_url}/api/v1/items/{item_id}/upload", 
                                json=upload_lock_payload, headers=headers, timeout=30)
    upload_url = lock_response.json()['uploadUrl']
    
    # Generate presigned URL for S3 object
    presigned_url = s3.generate_presigned_url('get_object', 
                                             Params={'Bucket': s3_bucket, 'Key': s3_key}, 
                                             ExpiresIn=3600)
    
    # Stream from S3 to Mimir
    s3_response = requests.get(presigned_url, stream=True, timeout=30)
    upload_response = requests.put(upload_url, data=s3_response.iter_content(chunk_size=8192), timeout=300)
    
    return {"success": True, "item_id": item_id}
