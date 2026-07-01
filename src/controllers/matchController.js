const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { analyzeVideo, embedText } = require('../services/gemini');
const { searchVectors } = require('../services/qdrant');
const { pool } = require('../config/db');
const { s3, BUCKET } = require('../config/s3');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
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

  // Capture buffer before deleting from job store
  const { videoBuffer, mimeType } = job;

  // Clean up job once stream starts so the buffer doesn't linger
  jobs.delete(jobId);

  try {
    // Step 1: Upload video to Gemini + wait for it to be ready
    send('step', { step: 1, label: 'Uploading video to AI...', status: 'active' });
    const description = await analyzeVideo(videoBuffer, mimeType);
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

    // Send done immediately so the UI unblocks — S3/DB persist in the background
    const ext = mimeType === 'video/quicktime' ? '.mov'
      : mimeType === 'video/webm' ? '.webm'
      : mimeType === 'video/avi' ? '.avi'
      : '.mp4';
    const videoS3Key = `video-uploads/${jobId}${ext}`;

    send('done', { tracks, videoS3Key, sessionId: jobId });
    res.end();

    // Background: upload video to S3 then persist match session to DB
    setImmediate(async () => {
      let s3Ok = false;
      try {
        await s3.send(new PutObjectCommand({
          Bucket: BUCKET,
          Key: videoS3Key,
          Body: videoBuffer,
          ContentType: mimeType,
        }));
        s3Ok = true;
      } catch (s3Err) {
        logger.error('match', 'video S3 upload failed', s3Err);
      }

      try {
        await pool.query(
          'INSERT INTO match_sessions (id, user_id, video_s3_key, matched_tracks) VALUES (?, ?, ?, ?)',
          [jobId, req.user.userId, s3Ok ? videoS3Key : null, JSON.stringify(tracks)]
        );
      } catch (dbErr) {
        logger.error('match', 'session save failed', dbErr);
      }
    });

    return; // res already ended
  } catch (err) {
    logger.error('match', 'pipeline failed', err);
    send('error', { error: err.message });
  }

  res.end();
}

async function listMatchSessions(req, res) {
  const [rows] = await pool.query(
    `SELECT id, video_s3_key, created_at,
            JSON_LENGTH(matched_tracks) AS track_count
     FROM match_sessions
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT 20`,
    [req.user.userId]
  );
  res.json(rows);
}

async function getMatchSession(req, res) {
  const [rows] = await pool.query(
    'SELECT id, video_s3_key, matched_tracks, created_at FROM match_sessions WHERE id = ? AND user_id = ?',
    [req.params.id, req.user.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Session not found' });

  const session = rows[0];
  // matched_tracks may come back as a string or already parsed depending on MySQL driver
  const tracks = typeof session.matched_tracks === 'string'
    ? JSON.parse(session.matched_tracks)
    : session.matched_tracks;

  // Generate a fresh presigned URL for the video if it exists
  let videoUrl = null;
  if (session.video_s3_key) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    videoUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: session.video_s3_key }),
      { expiresIn: 3600 }
    );
  }

  res.json({ ...session, tracks, videoUrl });
}

async function deleteMatchSession(req, res) {
  const [rows] = await pool.query(
    'SELECT id, user_id, video_s3_key FROM match_sessions WHERE id = ? AND user_id = ?',
    [req.params.id, req.user.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Session not found' });

  const session = rows[0];

  // Delete source video from S3
  if (session.video_s3_key) {
    try {
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: session.video_s3_key }));
    } catch (s3Err) {
      logger.error('match', 'S3 delete failed for session', s3Err);
    }
  }

  // Delete any video_projects that used this video (also clean their output S3 objects)
  const [vpRows] = await pool.query(
    'SELECT output_s3_key FROM video_projects WHERE video_s3_key = ? AND user_id = ?',
    [session.video_s3_key, req.user.userId]
  );
  for (const vp of vpRows) {
    if (vp.output_s3_key) {
      try {
        const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: vp.output_s3_key }));
      } catch { /* ignore */ }
    }
  }
  await pool.query(
    'DELETE FROM video_projects WHERE video_s3_key = ? AND user_id = ?',
    [session.video_s3_key, req.user.userId]
  );

  await pool.query('DELETE FROM match_sessions WHERE id = ?', [session.id]);

  res.json({ ok: true });
}

module.exports = { createMatchJob, streamMatchJob, listMatchSessions, getMatchSession, deleteMatchSession };
