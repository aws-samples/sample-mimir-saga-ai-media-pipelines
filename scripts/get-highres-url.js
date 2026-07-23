const fs = require('fs');
const apiKey = fs.readFileSync('/tmp/mimir_key.txt', 'utf8').trim();
const itemId = '2698a2a0-dc99-4672-aecd-aa34a21f091d';

fetch('https://us.mjoll.no/api/v1/items/' + itemId, {
  headers: { 'Accept': 'application/json', 'x-mimir-cognito-id-token': 'Bearer ' + apiKey }
}).then(r => r.json()).then(d => {
  console.log('width:', d.technicalMetadata?.formData?.technical_video_width);
  console.log('height:', d.technicalMetadata?.formData?.technical_video_height);
  console.log('highRes (first 120 chars):', (d.highRes || 'null').substring(0, 120));
  fs.writeFileSync('/tmp/highres_url.txt', d.highRes || '');
  console.log('Full URL written to /tmp/highres_url.txt');
}).catch(e => console.error(e.message));
