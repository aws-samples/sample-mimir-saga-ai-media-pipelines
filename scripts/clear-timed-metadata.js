#!/usr/bin/env node
/**
 * Clear timed metadata (chapters/markers) from a Mimir item.
 * 
 * Usage:
 *   node scripts/clear-timed-metadata.js <itemId>
 *   node scripts/clear-timed-metadata.js <itemId> --dry-run
 * 
 * Reads mimirApiKey from parameters.json
 */

const fs = require('fs');

const MIMIR_BASE_URL = process.env.MIMIR_API_BASE || 'https://us.mjoll.no';

async function main() {
  const itemId = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');

  if (!itemId) {
    console.log('Usage: node scripts/clear-timed-metadata.js <itemId> [--dry-run]');
    process.exit(1);
  }

  const params = JSON.parse(fs.readFileSync('./parameters.json', 'utf8'));
  const apiKey = params.mimirApiKey;

  if (!apiKey) {
    console.error('Error: mimirApiKey not found in parameters.json');
    process.exit(1);
  }

  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'x-mimir-cognito-id-token': `Bearer ${apiKey}`
  };

  // Step 1: GET current timed metadata
  console.log(`Fetching timed metadata for item: ${itemId}`);
  const getResponse = await fetch(`${MIMIR_BASE_URL}/api/v1/items/${itemId}/timedMetadata`, {
    method: 'GET',
    headers
  });

  if (!getResponse.ok) {
    console.error(`Error fetching timed metadata: ${getResponse.status} ${getResponse.statusText}`);
    process.exit(1);
  }

  const timedMetadata = await getResponse.json();
  const items = timedMetadata.items || [];
  
  if (!Array.isArray(items) || items.length === 0) {
    console.log('No timed metadata found on this item. Nothing to clear.');
    return;
  }

  console.log(`Found ${items.length} timed metadata entries:`);
  for (const entry of items) {
    const id = entry.id || 'unknown';
    const title = entry.data?.formData ? Object.values(entry.data.formData)[0] : entry.generated_summary || 'Untitled';
    const startMs = entry.startMs || 0;
    const endMs = entry.endMs || 0;
    console.log(`  ${id}: "${title}" (${(startMs/1000).toFixed(1)}s - ${(endMs/1000).toFixed(1)}s)`);
  }

  if (dryRun) {
    console.log('\n--dry-run: Would delete all entries above. Run without --dry-run to execute.');
    return;
  }

  // Step 2: PUT with all items set to null (keyed by their ID) to delete them
  console.log(`\nClearing all ${items.length} timed metadata entries...`);
  
  const deletePayload = { items: {} };
  for (const entry of items) {
    if (entry.id) {
      deletePayload.items[entry.id] = null;
    }
  }

  const putResponse = await fetch(`${MIMIR_BASE_URL}/api/v1/items/${itemId}/timedMetadata`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(deletePayload)
  });

  if (putResponse.ok) {
    console.log(`✅ Cleared ${items.length} timed metadata entries from item ${itemId}`);
  } else {
    const errorBody = await putResponse.text();
    console.error(`❌ Error clearing timed metadata: ${putResponse.status} ${putResponse.statusText}`);
    console.error(errorBody);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
