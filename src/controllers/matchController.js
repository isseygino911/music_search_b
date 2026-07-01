const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { analyzeVideo, embedText } = require('../services/gemini');
const { searchVectors } = require('../services/qdrant');
const { pool } = require('../config/db');
const logger = require('../services/logger');

const ALLOWED_VIDEO_MIME = ['video/mp4', 'video/webm', 'video/quicktime', 'video/avi'];

const uploadVideo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (ALLOWED_VIDEO_MIME.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported video type: ${file.mimetype}. Use MP4, WebM, MOV, or AVI.`));
    }
  },
}).single('videoFile');

// In-memory job store — jobs auto-expire after 10 minutes
const jobs = new Map();

async function createMatchJob(req, res) {
  uploadVideo(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No video file provided' });

    const jobId = uuidv4();
    jobs.set(jobId, { videoBuffer: req.file.buffer, mimeType: req.file.mimetype });
    setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000);

    res.json({ jobId });
  });
}

async function streamMatchJob(req, res) {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found or expired' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Clean up job once stream starts so the buffer doesn't linger
  jobs.delete(jobId);

  try {
    // Step 1: Upload video to Gemini + wait for it to be ready
    send('step', { step: 1, label: 'Uploading video to AI...', status: 'active' });
    const description = await analyzeVideo(job.videoBuffer, job.mimeType);
    send('step', { step: 1, label: 'Uploading video to AI...', status: 'done' });

    // Step 2: AI analysis is already done inside analyzeVideo
    send('step', { step: 2, label: 'AI is watching your video...', status: 'done' });

    // Step 3: Embed the description text → float[768]
    send('step', { step: 3, label: 'Generating music description...', status: 'active' });
    const vector = await embedText(description);
    send('step', { step: 3, label: 'Generating music description...', status: 'done' });

    // Step 4: Vector search in Qdrant → hydrate from MySQL
    send('step', { step: 4, label: 'Finding matching tracks...', status: 'active' });
    const matches = await searchVectors(vector, 10);

    let tracks = [];
    if (matches.length > 0) {
      const ids = matches.map((m) => m.trackId);
      const placeholders = ids.map(() => '?').join(',');
      // ORDER BY FIELD preserves Qdrant score ranking
      const [rows] = await pool.query(
        `SELECT id, title, artist, genre, description, duration, file_size, mime_type, uploaded_at
         FROM tracks WHERE id IN (${placeholders})
         ORDER BY FIELD(id, ${placeholders})`,
        [...ids, ...ids]
      );

      const scoreMap = Object.fromEntries(matches.map((m) => [m.trackId, m.score]));
      tracks = rows.map((row) => ({ ...row, score: scoreMap[row.id] ?? 0 }));
    }

    send('step', { step: 4, label: 'Finding matching tracks...', status: 'done' });
    send('done', { tracks });
  } catch (err) {
    logger.error('match', 'pipeline failed', err);
    send('error', { error: err.message });
  }

  res.end();
}

module.exports = { createMatchJob, streamMatchJob };
