import os
import requests
import boto3
from urllib.parse import urlparse

def upload_video_to_mimir_item(item_id, s3_video_url, api_key, mimir_base_url=None):
    """Upload video from S3 to existing Mimir item"""
    if mimir_base_url is None:
        mimir_base_url = os.environ.get("MIMIR_API_BASE", "https://us.mjoll.no")
    
    # Step 1: Get upload lock for the item
    upload_lock_url = f"{mimir_base_url}/api/v1/items/{item_id}/upload"
    headers = {
        'x-mimir-cognito-id-token': f'Bearer {api_key}',
        'Content-Type': 'application/json'
    }
    
    # Get file size from S3
    s3 = boto3.client('s3')
    parsed_url = urlparse(s3_video_url)
    bucket = parsed_url.netloc.split('.')[0]
    key = parsed_url.path.lstrip('/')
    
    response = s3.head_object(Bucket=bucket, Key=key)
    file_size = response['ContentLength']
    
    upload_lock_payload = {
        "fileSize": file_size,
        "originalFileName": key.split('/')[-1]
    }
    
    lock_response = requests.put(upload_lock_url, json=upload_lock_payload, headers=headers, timeout=30)
    lock_response.raise_for_status()
    
    upload_info = lock_response.json()
    upload_url = upload_info['uploadUrl']
    
    # Step 2: Download video from S3 and upload to Mimir
    video_obj = s3.get_object(Bucket=bucket, Key=key)
    video_data = video_obj['Body'].read()
    
    # Upload to Mimir using signed URL
    upload_response = requests.put(upload_url, data=video_data, timeout=300)
    upload_response.raise_for_status()
    
    return {"success": True, "item_id": item_id}

# Usage example:
# upload_video_to_mimir_item(
#     item_id="your-mimir-item-id",
#     s3_video_url="s3://your-bucket-name/your-video-key",
#     api_key="your-api-key"
# )
