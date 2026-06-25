const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');

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

  // Upload video buffer to Gemini File API
  const uploadResult = await fileManager.uploadFile(videoBuffer, {
    mimeType,
    displayName: 'video',
  });

  let file = uploadResult.file;

  // Poll until Gemini finishes processing the video (state: ACTIVE)
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

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

  const result = await model.generateContent([
    { fileData: { mimeType, fileUri: file.uri } },
    { text: ANALYZE_PROMPT },
  ]);

  return result.response.text();
}

async function embedText(text) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-embedding-2' });

  const result = await model.embedContent({
    content: { parts: [{ text }], role: 'user' },
    outputDimensionality: 768,
  });
  return result.embedding.values;
}

async function analyzeAudio(audioBuffer, mimeType) {
  const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);

  const uploadResult = await fileManager.uploadFile(audioBuffer, {
    mimeType,
    displayName: 'audio',
  });

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

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

  const result = await model.generateContent([
    { fileData: { mimeType, fileUri: file.uri } },
    { text: AUDIO_PROMPT },
  ]);

  return result.response.text();
}

module.exports = { analyzeVideo, analyzeAudio, embedText };
