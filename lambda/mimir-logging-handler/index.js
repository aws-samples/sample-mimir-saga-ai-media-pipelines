const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { randomUUID } = require('crypto');

const secretsClient = new SecretsManagerClient();

let cachedMimirApiKey = null;
let cachedChapterFormId = null;

const CHAPTER_FIELD_KEY = 'chapterTitle';

// Builds the per-view layout config Mimir needs to render a timed-metadata model.
// Without a `views` config the logging UI flags each event as "Model appears to be
// missing for this event", even though the model exists. We mirror the layout used
// by Mimir's own timed-metadata models (e.g. wire-provider) across all view types.
function buildChapterMdfBody(fieldUuid) {
  const layout = {
    visible: true,
    mdfSource: 'ChapterMarker',
    flex: 12,
    multiline: false,
    fieldHeight: 2,
    id: fieldUuid,
    showAlways: true,
    fieldId: CHAPTER_FIELD_KEY,
  };
  const viewTypes = [
    'scheduler', 'createPlaceholder', 'search', 'item', 'folder',
    'upload', 'share', 'copyItem', 'editing', 'newVersion',
  ];
  const views = {};
  for (const v of viewTypes) views[v] = [{ ...layout }];

  return {
    label: 'ChapterMarker',
    displayName: 'Chapter Marker',
    active: true,
    rule: '{chapterTitle}', // Show the chapter title as the event description
    color: '#4A90D9FF',
    icon: 'bookmark',
    fields: [
      { id: fieldUuid, fieldId: CHAPTER_FIELD_KEY, type: 'text', required: false },
    ],
    views,
    viewSections: { item: [] },
  };
}

async function getMimirApiKey() {
  if (cachedMimirApiKey) return cachedMimirApiKey;
  
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: process.env.MIMIR_API_KEY_SECRET_ARN })
  );
  cachedMimirApiKey = response.SecretString;
  return cachedMimirApiKey;
}

async function getChapterFormId(apiKey, mimirInstance = 'us') {
  // Return cached value if available
  if (cachedChapterFormId) return cachedChapterFormId;

  // Check if formId is provided via environment variable
  if (process.env.CHAPTER_FORM_ID) {
    cachedChapterFormId = process.env.CHAPTER_FORM_ID;
    console.log(`Using CHAPTER_FORM_ID from environment: ${cachedChapterFormId}`);
    return cachedChapterFormId;
  }

  const base = `https://${mimirInstance}.mjoll.no/api/v1/mdfs`;
  const headers = {
    'Content-Type': 'application/json',
    'x-mimir-cognito-id-token': `Bearer ${apiKey}`,
  };

  try {
    // Fetch available MDFs from Mimir
    const response = await fetch(base, { method: 'GET', headers });
    if (!response.ok) {
      throw new Error(`Failed to fetch MDFs: ${response.status}`);
    }

    const data = await response.json();
    const mdfs = data._embedded?.collection || [];

    // Look for an existing ChapterMarker MDF (case-insensitive, timed-metadata)
    const chapterMdf = mdfs.find(mdf =>
      mdf.flavor === 'timed-metadata' &&
      (mdf.label?.toLowerCase() === 'chaptermarker' || mdf.displayName?.toLowerCase() === 'chapter marker')
    );

    let mdfId;
    let fieldUuid;

    if (chapterMdf) {
      mdfId = chapterMdf.id;
      // Fetch the full MDF to inspect fields/views. Reuse the existing field id so
      // we don't orphan anything, and skip the repair PUT if it's already complete.
      try {
        const full = await (await fetch(`${base}/${mdfId}`, { headers })).json();
        const existingField = (full.fields || []).find(f => f.fieldId === CHAPTER_FIELD_KEY);
        fieldUuid = existingField?.id;
        const viewsConfigured = full.views && Array.isArray(full.views.item) && full.views.item.length > 0;
        if (fieldUuid && viewsConfigured) {
          cachedChapterFormId = mdfId;
          console.log(`Found fully-configured ChapterMarker MDF: ${mdfId}`);
          return cachedChapterFormId;
        }
        console.log(`ChapterMarker MDF ${mdfId} needs view configuration - repairing`);
      } catch (err) {
        console.warn(`Could not fetch full ChapterMarker MDF (${err.message}), will attempt repair`);
      }
    } else {
      // Create the ChapterMarker MDF (fields/views are added by the PUT below)
      console.log('ChapterMarker MDF not found, creating it...');
      const createResponse = await fetch(base, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          label: 'ChapterMarker',
          displayName: 'Chapter Marker',
          flavor: 'timed-metadata',
          active: true,
          fields: [],
        }),
      });

      if (createResponse.ok) {
        mdfId = (await createResponse.json()).id;
        console.log(`Created ChapterMarker MDF: ${mdfId}`);
      } else {
        // Creation failed (e.g. permissions) - fall back to another timed-metadata MDF
        console.log(`Failed to create ChapterMarker MDF (${createResponse.status}), falling back`);
        const shotMdf = mdfs.find(mdf =>
          mdf.flavor === 'timed-metadata' &&
          (mdf.label?.toLowerCase() === 'shot' || mdf.displayName?.toLowerCase() === 'shot')
        );
        const fallback = shotMdf || mdfs.find(mdf => mdf.flavor === 'timed-metadata');
        if (fallback) {
          cachedChapterFormId = fallback.id;
          console.log(`Using fallback timed-metadata MDF: ${fallback.id} (${fallback.label})`);
          return cachedChapterFormId;
        }
        throw new Error('No suitable timed-metadata MDF found in Mimir');
      }
    }

    // Configure (or repair) the MDF with fields + rule + full view layout so the
    // logging UI recognizes the model. Reuse the existing field id when present.
    fieldUuid = fieldUuid || randomUUID();
    const updateResponse = await fetch(`${base}/${mdfId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(buildChapterMdfBody(fieldUuid)),
    });

    if (updateResponse.ok) {
      console.log(`Configured ChapterMarker MDF ${mdfId} with fields + views`);
    } else {
      const body = await updateResponse.text().catch(() => '');
      console.warn(`Failed to configure ChapterMarker MDF (${updateResponse.status}): ${body.slice(0, 200)}`);
    }

    cachedChapterFormId = mdfId;
    return cachedChapterFormId;

  } catch (error) {
    console.error('Error fetching/creating Chapter form ID:', error);
    throw error;
  }
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
    
    // Get the appropriate Chapter/Shot form ID dynamically
    const chapterFormId = await getChapterFormId(apiKey);
    
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
          formId: chapterFormId, // Dynamically determined MDF ID
          formData: {
            chapterTitle: chapter.title
          }
        }
      };
    });
    
    const requestBody = {
      items: timedMetadataItems
    };
    
    console.log('Updating Mimir with chapters:', JSON.stringify(requestBody, null, 2));
    
    // Call Mimir API to update timed metadata
    const mimirBaseUrl = process.env.MIMIR_API_BASE || 'https://us.mjoll.no';
    const mimirUrl = `${mimirBaseUrl}/api/v1/items/${itemId}/timedMetadata`;
    
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
