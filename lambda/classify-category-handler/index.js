/**
 * Classify Category Handler
 *
 * Uses Amazon Bedrock (Nova Pro) to:
 *   1. Classify the story into one of the defined broadcast categories
 *   2. Generate up to 3 headline lines suitable for the graphics overlay
 *   3. Extract a location / source credit if available
 *
 * Input:
 *   title              (string) Story / video title
 *   description        (string) Optional description
 *   transcript         (string) Optional transcript text (caller-provided, takes priority)
 *   timedTranscriptUrl (string) Optional Mimir timedTranscriptUrl — fetched if transcript empty
 *   itemId             (string) Optional — fallback to S3 staging bucket transcript
 *
 * Output:
 *   category    (string) One of the CATEGORIES values
 *   line1       (string) Headline line 1 (≤ 40 chars)
 *   line2       (string) Headline line 2 (≤ 40 chars, may be empty)
 *   line3       (string) Headline line 3 (≤ 40 chars, may be empty)
 *   location    (string) Location / source credit (≤ 30 chars, may be empty)
 */

const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });
const s3Client = new S3Client();

const MODEL_ID = process.env.CLASSIFY_MODEL_ID || 'us.amazon.nova-pro-v1:0';
const TRANSCRIPT_BUCKET = process.env.TRANSCRIPT_STAGING_BUCKET || '';

const CATEGORIES = [
  'BREAKING NEWS',
  'ENTERTAINMENT / LIFESTYLE',
  'NEWS & POLITICS',
  'SPORTS',
  'BUSINESS & FINANCE',
  'EDUCATION',
  'WEATHER',
  'NATIONAL NEWS',
  'LOCAL NEWS',
  'LOCAL LIVING',
  'OFFBEAT',
  'SCIENCE & TECHNOLOGY',
  'UNREAL & UNEXPECTED',
];

const SYSTEM_PROMPT = `You are a broadcast news graphics producer. 
Given a story title, description, and optional transcript, you must:
1. Classify the story into exactly one category from the provided list
2. Generate short graphic text for a broadcast lower-third overlay
3. Extract a location or source credit if present

The lower-third graphic has these text fields:
- line1, line2, line3: Very short ALL CAPS words/phrases displayed at large size (100px bold).
  These are meant for 1-3 punchy words each — like a kicker or topic label.
  Examples: "BREAKING", "STORM WARNING", "TIGERS WIN", "VOTE RESULTS"
  MAXIMUM 12 characters each. Use empty string if not needed.
- headline: A full sentence headline displayed at smaller size in a text box.
  This is where the actual story headline goes — up to 80 characters.
  Examples: "Marion County Council votes on Project Liberty economic plan"

Rules for line1/line2/line3:
- Maximum 12 characters each (hard limit — text will overflow if exceeded)
- ALL CAPS
- 1-3 words maximum
- Think of these as a topic label or kicker, not a full sentence
- line1 is required; line2 and line3 are optional (use empty string if not needed)

Rules for headline:
- Up to 80 characters
- Sentence case or ALL CAPS
- The main story headline

Rules for location:
- 30 characters or fewer
- City, State format preferred (e.g. "BALTIMORE, MD")
- Empty string if no location is evident

Always respond with valid JSON only. No markdown, no explanation.`;

/**
 * Fetch transcript text from a Mimir timedTranscriptUrl.
 * Returns the fullTranscript string (first 3000 chars), or empty string on failure.
 */
async function fetchTranscriptFromUrl(timedTranscriptUrl, mimirApiKey) {
  if (!timedTranscriptUrl) return '';
  try {
    const response = await fetch(timedTranscriptUrl, {
      headers: {
        'Accept': 'application/json',
        'x-mimir-cognito-id-token': `Bearer ${mimirApiKey}`,
      },
    });
    if (!response.ok) {
      console.log(`Transcript URL returned ${response.status}, skipping`);
      return '';
    }
    const data = await response.json();
    // Mimir timed transcript format can be either:
    // 1. { fullTranscript: "...", sentences: [...] }
    // 2. Array-like object { "0": {content, startTime, endTime}, "1": ... }
    let text = '';
    if (data.fullTranscript) {
      text = data.fullTranscript.substring(0, 3000);
    } else if (typeof data === 'object') {
      // Join word content fields from array-like object
      const words = Array.isArray(data) ? data : Object.values(data);
      text = words
        .filter(w => w && typeof w.content === 'string')
        .map(w => w.content)
        .join(' ')
        .substring(0, 3000);
    }
    console.log(`Fetched transcript from Mimir URL: ${text.length} chars, keys: ${Object.keys(data).slice(0,5).join(',')}`);
    return text;
  } catch (err) {
    console.log(`Failed to fetch transcript from URL: ${err.message}`);
    return '';
  }
}

/**
 * Fallback: fetch transcript from S3 staging bucket.
 */
async function fetchTranscriptFromS3(itemId) {
  if (!TRANSCRIPT_BUCKET || !itemId) return '';
  try {
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: TRANSCRIPT_BUCKET,
      Key: `transcripts/${itemId}/transcript.json`,
    }));
    const body = await response.Body.transformToString();
    const data = JSON.parse(body);
    const text = (data.fullTranscript || '').substring(0, 3000);
    console.log(`Fetched transcript from S3 for ${itemId}: ${text.length} chars`);
    return text;
  } catch (err) {
    console.log(`No S3 transcript for ${itemId} (${err.name})`);
    return '';
  }
}

exports.handler = async (event) => {
  console.log('Classify category handler received:', JSON.stringify({
    title: event.title,
    itemId: event.itemId,
    hasTimedTranscriptUrl: !!(event.mimirDetails?.timedTranscriptUrl),
    hasTranscript: !!event.transcript,
  }));

  const title = event.title || '';
  const description = event.description || '';
  const itemId = event.itemId || '';
  const mimirApiKey = event.mimirApiKey || '';

  // Priority: caller-provided text → Mimir timedTranscriptUrl → S3 staging bucket
  let transcript = (event.transcript || '').substring(0, 3000);
  if (!transcript && event.mimirDetails?.timedTranscriptUrl) {
    transcript = await fetchTranscriptFromUrl(event.mimirDetails.timedTranscriptUrl, mimirApiKey);
  }
  if (!transcript && itemId) {
    transcript = await fetchTranscriptFromS3(itemId);
  }

  const userMessage = [
    `## Story Title\n${title}`,
    description ? `## Description\n${description}` : '',
    transcript ? `## Transcript Excerpt\n${transcript}` : '',
    `## Available Categories\n${CATEGORIES.map(c => `- ${c}`).join('\n')}`,
    `\nRespond with JSON in this exact format:
{
  "category": "<one of the categories above>",
  "line1": "<SHORT KICKER 1-3 WORDS MAX 12 CHARS>",
  "line2": "<SHORT KICKER OR EMPTY>",
  "line3": "<SHORT KICKER OR EMPTY>",
  "headline": "<FULL HEADLINE SENTENCE UP TO 80 CHARS>",
  "location": "<LOCATION OR EMPTY>"
}`,
  ].filter(Boolean).join('\n\n');

  const response = await bedrockClient.send(new ConverseCommand({
    modelId: MODEL_ID,
    system: [{ text: SYSTEM_PROMPT }],
    messages: [{ role: 'user', content: [{ text: userMessage }] }],
    inferenceConfig: {
      maxTokens: 256,
      temperature: 0.1,
    },
  }));

  const rawText = response.output?.message?.content?.[0]?.text || '';
  console.log('Bedrock response:', rawText);

  const jsonText = rawText.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();

  let result;
  try {
    result = JSON.parse(jsonText);
  } catch (err) {
    console.error('Failed to parse Bedrock response as JSON:', rawText);
    result = {
      category: 'BREAKING NEWS',
      line1: title.toUpperCase().substring(0, 40),
      line2: '',
      line3: '',
      location: '',
    };
  }

  if (!CATEGORIES.includes(result.category)) {
    console.warn(`Unknown category ${result.category}, defaulting to BREAKING NEWS`);
    result.category = 'BREAKING NEWS';
  }

  // Enforce length limits — hard limits based on Lottie text box sizes
  result.line1 = (result.line1 || '').substring(0, 12).toUpperCase();
  result.line2 = (result.line2 || '').substring(0, 12).toUpperCase();
  result.line3 = (result.line3 || '').substring(0, 12).toUpperCase();
  result.headline = (result.headline || result.line1 || '').substring(0, 80);
  result.location = (result.location || '').substring(0, 30).toUpperCase();

  console.log('Classification result:', JSON.stringify(result));
  return result;
};
