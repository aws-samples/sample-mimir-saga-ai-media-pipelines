/**
 * story-research-handler
 *
 * Generates research content for a Saga story by:
 *   1. Collecting all transcripts from the story's video assets
 *   2. Invoking Bedrock Nova to generate configurable research items
 *   3. Writing the results back to the story's Research instance in Saga
 *
 * Research items are extensible — add new prompts to RESEARCH_ITEMS without
 * changing any other code.
 *
 * Environment variables:
 *   MIMIR_API_KEY_SECRET_ARN  — Mimir API key secret ARN
 *   SAGA_API_KEY_SECRET_ARN   — Saga API key secret ARN
 *   SAGA_API_URL_SECRET_ARN   — Saga API base URL secret ARN
 *   TRANSCRIPT_STAGING_BUCKET — S3 bucket containing transcripts/{itemId}/transcript.json
 *   BEDROCK_MODEL_ID          — Bedrock model ID (default: us.amazon.nova-pro-v1:0)
 *   BEDROCK_REGION            — Bedrock region (default: us-east-1)
 */

const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const secretsClient = new SecretsManagerClient();
const s3Client = new S3Client();

const MIMIR_BASE_URL = process.env.MIMIR_API_BASE || 'https://us.mjoll.no';
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || 'us.amazon.nova-pro-v1:0';
const BEDROCK_REGION = process.env.BEDROCK_REGION || 'us-east-1';
const TRANSCRIPT_STAGING_BUCKET = process.env.TRANSCRIPT_STAGING_BUCKET;

const bedrockClient = new BedrockRuntimeClient({ region: BEDROCK_REGION });

// Secret cache
const secretCache = {};
async function getSecret(arn) {
  if (secretCache[arn]) return secretCache[arn];
  const r = await secretsClient.send(new GetSecretValueCommand({ SecretId: arn }));
  secretCache[arn] = r.SecretString;
  return secretCache[arn];
}

// ---------------------------------------------------------------------------
// Research item definitions — add new items here to extend the feature.
// Each item has:
//   id:     unique key used in the output object
//   label:  display name shown in the Saga research panel
//   prompt: instruction sent to Bedrock for this specific item
// ---------------------------------------------------------------------------
const RESEARCH_ITEMS = [
  {
    id: 'voScript',
    label: 'Voice-Over Script',
    prompt: `Write a broadcast news voice-over script for this story. 
The script should be suitable for a reporter to read over B-roll footage.
Use clear, conversational broadcast language. Aim for 60-90 seconds (150-225 words).
Format as a continuous narration without section headers.`,
  },
  {
    id: 'packageScript',
    label: 'Package Script',
    prompt: `Write a complete broadcast news package script for this story.
Include: anchor introduction, reporter voice-over sections (PKG VO), 
sound-on-tape cues (SOT) with speaker attributions from the transcripts,
and a live tag. Use standard broadcast script formatting with section labels.
Aim for a 1:30-2:00 package.`,
  },
  {
    id: 'keyFacts',
    label: 'Key Facts',
    prompt: `Extract the 5-8 most important facts from this story.
Format as a bulleted list. Each fact should be a single, clear sentence.
Focus on the who, what, when, where, and why.`,
  },
  {
    id: 'suggestedQuestions',
    label: 'Suggested Interview Questions',
    prompt: `Generate 5-7 strong interview questions a journalist could ask 
related to this story. Questions should be open-ended, newsworthy, and 
designed to elicit compelling soundbites. Include a mix of factual, 
analytical, and human-interest questions.`,
  },
  {
    id: 'storyAngle',
    label: 'Story Angle & Headline',
    prompt: `Suggest 3 different story angles for this content, each with:
- A broadcast-style headline (under 10 words)
- A one-sentence description of the angle
- The target audience for this angle
Format each angle clearly numbered.`,
  },
  {
    id: 'backgroundContext',
    label: 'Background & Context',
    prompt: `Provide background context for this story in 2-3 paragraphs.
Cover: what led to this story, relevant history, and why it matters to viewers.
Write in a neutral, journalistic tone suitable for a producer briefing document.`,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getTranscriptText(itemId, timedTranscriptUrl) {
  // First try the staging bucket (transcripts processed by rough cut pipeline)
  if (TRANSCRIPT_STAGING_BUCKET) {
    try {
      const obj = await s3Client.send(new GetObjectCommand({
        Bucket: TRANSCRIPT_STAGING_BUCKET,
        Key: `transcripts/${itemId}/transcript.json`,
      }));
      const chunks = [];
      for await (const chunk of obj.Body) chunks.push(chunk);
      const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      if (data.fullTranscript) return data.fullTranscript;
    } catch (err) {
      // Not in staging bucket — fall through to Mimir URL
    }
  }

  // Fall back to Mimir's timedTranscriptUrl (pre-signed S3 URL)
  if (timedTranscriptUrl) {
    try {
      const r = await fetch(timedTranscriptUrl);
      if (r.ok) {
        const data = await r.json();
        // Mimir timed transcript format: object with numeric keys, each { content, startTime, endTime }
        // e.g. { "0": { content: "What", startTime: 939, endTime: 1169 }, "1": { ... }, ... }
        if (data && typeof data === 'object' && data['0']?.content !== undefined) {
          return Object.values(data).map(w => w.content).join(' ');
        }
        // Fallback for other possible formats
        return data.fullTranscript
          || data.results?.transcripts?.[0]?.transcript
          || data.transcript
          || null;
      }
    } catch (err) {
      console.warn(`Failed to fetch timedTranscriptUrl for ${itemId}: ${err.message}`);
    }
  }

  return null;
}

async function getMimirItemTitle(itemId, mimirApiKey) {
  try {
    const r = await fetch(`${MIMIR_BASE_URL}/api/v1/items/${itemId}`, {
      headers: {
        'Accept': 'application/json',
        'x-mimir-cognito-id-token': `Bearer ${mimirApiKey}`,
      },
    });
    if (!r.ok) return itemId;
    const data = await r.json();
    return data.title || data.originalFileName || itemId;
  } catch {
    return itemId;
  }
}

/**
 * Build the combined transcript context string from all story assets.
 */
async function buildTranscriptContext(assets, mimirApiKey) {
  const blocks = [];
  for (const asset of assets) {
    const itemId = asset.mimirItemId || asset.externalId;
    if (!itemId || asset.itemType !== 'video') continue;
    if (!asset.hasTranscript && !asset.generatedTranscriptS3Uri && !asset.timedTranscriptUrl) continue;

    const [title, transcript] = await Promise.all([
      getMimirItemTitle(itemId, mimirApiKey),
      getTranscriptText(itemId, asset.timedTranscriptUrl),
    ]);

    if (transcript && transcript.trim()) {
      blocks.push(`### ${title}\n${transcript.trim()}`);
    }
  }
  return blocks.join('\n\n');
}

/**
 * Generate a single research item using Bedrock Converse.
 */
async function generateResearchItem(item, storyTitle, storyDescription, transcriptContext) {
  const systemPrompt = `You are a professional broadcast news researcher and producer.
You are analyzing a news story and its source material to help journalists prepare their coverage.
Be concise, accurate, and use broadcast journalism conventions.
Do not fabricate facts not present in the provided transcripts.`;

  const userMessage = [
    `## Story Title\n${storyTitle}`,
    storyDescription ? `## Story Description\n${storyDescription}` : null,
    transcriptContext ? `## Source Transcripts\n${transcriptContext.slice(0, 8000)}` : '## Source Transcripts\n(No transcripts available — use story title and description only)',
    `## Task\n${item.prompt}`,
  ].filter(Boolean).join('\n\n');

  const response = await bedrockClient.send(new ConverseCommand({
    modelId: BEDROCK_MODEL_ID,
    system: [{ text: systemPrompt }],
    messages: [{ role: 'user', content: [{ text: userMessage }] }],
    inferenceConfig: { maxTokens: 2000, temperature: 0.4 },
  }));

  return response.output?.message?.content?.[0]?.text?.trim() || '';
}

/**
 * Build a Slate document from plain text content.
 * Splits on newlines to preserve paragraph structure.
 */
function buildSlateDocument(text) {
  const blocks = text.split('\n').map(line => ({
    type: 'paragraph',
    children: [{ text: line }],
    placeholder: false,
  }));
  return { document: blocks, version: '0.1.0' };
}

/**
 * Write research content to Saga — one note per research item.
 * On re-runs, finds existing notes by title and updates them rather than creating duplicates.
 */
async function writeResearchToSaga(storyId, researchItems, sagaApiUrl, sagaApiKey) {
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'x-api-key': sagaApiKey,
  };

  // Fetch existing notes so we can match by title on re-runs
  const notesResp = await fetch(`${sagaApiUrl}/stories/${storyId}/notes`, { headers });
  if (!notesResp.ok) throw new Error(`Failed to get notes: ${notesResp.status}`);
  const notesData = await notesResp.json();
  const existingNotes = notesData.notes || notesData || [];

  // Build a lookup map: lowercase title → note id
  const notesByTitle = {};
  for (const note of existingNotes) {
    if (note.title) notesByTitle[note.title.toLowerCase()] = note.id;
  }

  const noteIds = [];

  for (const item of researchItems) {
    if (!item.content) continue;

    const titleKey = item.label.toLowerCase();
    const content = buildSlateDocument(item.content);

    if (notesByTitle[titleKey]) {
      // Update existing note — write generated text to both description (readable via
      // the list endpoint by the story-context-handler) and content (Slate rich text
      // for display in the Saga UI Research tab).
      const noteId = notesByTitle[titleKey];
      const patchResp = await fetch(`${sagaApiUrl}/stories/${storyId}/notes/${noteId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ title: item.label, description: item.content, content }),
      });
      if (!patchResp.ok) {
        const errText = await patchResp.text().catch(() => '');
        console.error(`Failed to update note "${item.label}": ${patchResp.status} ${errText}`);
        continue;
      }
      console.log(`Updated note "${item.label}": ${noteId}`);
      noteIds.push(noteId);
    } else {
      // Create new note then patch with content — POST only accepts title/description,
      // so we create first and then PATCH with the full payload.
      const createResp = await fetch(`${sagaApiUrl}/stories/${storyId}/notes`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: item.label }),
      });
      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        console.error(`Failed to create note "${item.label}": ${createResp.status} ${errText}`);
        continue;
      }
      const created = await createResp.json();
      const noteId = created.id;

      // Patch with generated text in description (for API reads) and content (for UI display)
      const patchResp = await fetch(`${sagaApiUrl}/stories/${storyId}/notes/${noteId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ title: item.label, description: item.content, content }),
      });
      if (!patchResp.ok) {
        const errText = await patchResp.text().catch(() => '');
        console.error(`Failed to patch content for note "${item.label}": ${patchResp.status} ${errText}`);
        continue;
      }
      console.log(`Created note "${item.label}": ${noteId}`);
      noteIds.push(noteId);
    }
  }

  console.log(`Wrote ${noteIds.length} research notes`);
  return { noteIds, itemCount: noteIds.length };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

exports.handler = async (event) => {
  console.log('story-research-handler event:', JSON.stringify({
    storyId: event.storyId,
    assetCount: event.storyContext?.assets?.length,
    customPrompts: event.customPrompts?.length,
  }));

  const {
    storyId,
    storyContext,
    customPrompts = [],  // optional additional research items from the journalist
  } = event;

  // Resolve secrets
  const [mimirApiKey, sagaApiKey, sagaApiUrl] = await Promise.all([
    getSecret(process.env.MIMIR_API_KEY_SECRET_ARN),
    getSecret(process.env.SAGA_API_KEY_SECRET_ARN),
    getSecret(process.env.SAGA_API_URL_SECRET_ARN),
  ]);

  const story = storyContext?.story || {};
  const assets = storyContext?.assets || [];
  const storyTitle = story.mTitle || story.title || 'Untitled Story';
  const storyDescription = story.mDescription || story.description || '';

  console.log(`Generating research for: "${storyTitle}" with ${assets.length} assets`);

  // Build transcript context from all available transcripts
  const transcriptContext = await buildTranscriptContext(assets, mimirApiKey);
  console.log(`Transcript context: ${transcriptContext.length} chars from ${assets.filter(a => a.hasTranscript).length} transcribed assets`);

  // Merge built-in research items with any custom prompts from the journalist
  const allItems = [
    ...RESEARCH_ITEMS,
    ...customPrompts.map((cp, i) => ({
      id: `custom_${i}`,
      label: cp.label || `Custom Research ${i + 1}`,
      prompt: cp.prompt,
    })),
  ];

  // Generate all research items in parallel (with concurrency limit)
  const CONCURRENCY = 3;
  const results = [];
  for (let i = 0; i < allItems.length; i += CONCURRENCY) {
    const batch = allItems.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (item) => {
        try {
          console.log(`Generating: ${item.label}`);
          const content = await generateResearchItem(item, storyTitle, storyDescription, transcriptContext);
          return { id: item.id, label: item.label, content };
        } catch (err) {
          console.error(`Failed to generate ${item.label}: ${err.message}`);
          return { id: item.id, label: item.label, content: `(Generation failed: ${err.message})` };
        }
      })
    );
    results.push(...batchResults);
  }

  console.log(`Generated ${results.length} research items`);

  // Write to Saga
  const writeResult = await writeResearchToSaga(storyId, results, sagaApiUrl, sagaApiKey);

  return {
    status: 'success',
    storyId,
    storyTitle,
    researchNoteIds: writeResult.noteIds,
    itemsGenerated: writeResult.itemCount,
    items: results.map(r => ({ id: r.id, label: r.label, length: r.content?.length || 0 })),
  };
};
