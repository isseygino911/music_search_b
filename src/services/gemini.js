const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');

async function withRetry(fn, retries = 5, baseDelayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const is503 = err.message && err.message.includes('503');
      if (!is503 || attempt === retries) throw err;
      const jitter = Math.random() * 1000;
      const delay = baseDelayMs * Math.pow(2, attempt - 1) + jitter;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

const GENERATION_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash'];

async function generateWithFallback(parts) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  let lastErr;
  for (const modelName of GENERATION_MODELS) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      return await withRetry(() => model.generateContent(parts));
    } catch (err) {
      lastErr = err;
      if (!err.message || !err.message.includes('503')) throw err;
    }
  }
  throw lastErr;
}

const ANALYZE_PROMPT =
  'Watch this video carefully. Describe the mood, energy, emotional tone, pace, theme, atmosphere, and setting. ' +
  'What kind of music would complement this video perfectly? ' +
  'Be specific about tempo, genre, instruments, and emotional qualities.';

const AUDIO_PROMPT =
  'Listen to this audio track carefully. Describe the mood, energy, emotional tone, tempo, genre, ' +
  'instruments, atmosphere, and setting. What kind of video or scene would this music complement perfectly? ' +
  'Be specific about the emotional qualities and use cases.';

async function analyzeVideo(videoBuffer, mimeType) {
  const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);

  const uploadResult = await withRetry(() =>
    fileManager.uploadFile(videoBuffer, { mimeType, displayName: 'video' })
  );

  let file = uploadResult.file;

  let polls = 0;
  while (file.state === 'PROCESSING') {
    if (polls >= 30) throw new Error('Video processing timed out after 60 seconds');
    await new Promise((r) => setTimeout(r, 2000));
    file = await fileManager.getFile(file.name);
    polls++;
  }

  if (file.state !== 'ACTIVE') {
    throw new Error(`Video processing failed with state: ${file.state}`);
  }

  const result = await generateWithFallback([
    { fileData: { mimeType, fileUri: file.uri } },
    { text: ANALYZE_PROMPT },
  ]);

  return result.response.text();
}

async function embedText(text) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-embedding-2' });

  const result = await withRetry(() =>
    model.embedContent({
      content: { parts: [{ text }], role: 'user' },
      outputDimensionality: 768,
    })
  );
  return result.embedding.values;
}

async function analyzeAudio(audioBuffer, mimeType) {
  const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);

  const uploadResult = await withRetry(() =>
    fileManager.uploadFile(audioBuffer, { mimeType, displayName: 'audio' })
  );

  let file = uploadResult.file;

  let polls = 0;
  while (file.state === 'PROCESSING') {
    if (polls >= 30) throw new Error('Audio processing timed out after 60 seconds');
    await new Promise((r) => setTimeout(r, 2000));
    file = await fileManager.getFile(file.name);
    polls++;
  }

  if (file.state !== 'ACTIVE') {
    throw new Error(`Audio processing failed with state: ${file.state}`);
  }

  const result = await generateWithFallback([
    { fileData: { mimeType, fileUri: file.uri } },
    { text: AUDIO_PROMPT },
  ]);

  return result.response.text();
}

module.exports = { analyzeVideo, analyzeAudio, embedText };
