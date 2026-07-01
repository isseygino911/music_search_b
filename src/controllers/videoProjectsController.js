const { v4: uuidv4 } = require('uuid');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const { pipeline } = require('stream');
const pipelineAsync = promisify(pipeline);
const ffmpeg = require('fluent-ffmpeg');
const {
  GetObjectCommand,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { s3, BUCKET } = require('../config/s3');
const { pool } = require('../config/db');
const logger = require('../services/logger');

async function createProject(req, res) {
  const { trackId, videoS3Key } = req.body;

  if (!trackId || !videoS3Key) {
    return res.status(400).json({ error: 'trackId and videoS3Key are required' });
  }

  const [trackRows] = await pool.query('SELECT id, duration FROM tracks WHERE id = ?', [trackId]);
  if (!trackRows.length) {
    return res.status(404).json({ error: 'Track not found' });
  }

  const id = uuidv4();
  await pool.query(
    `INSERT INTO video_projects (id, user_id, track_id, video_s3_key, video_start, audio_start)
     VALUES (?, ?, ?, ?, 0, 0)`,
    [id, req.user.userId, trackId, videoS3Key]
  );

  res.status(201).json({ projectId: id });
}

async function getProject(req, res) {
  const [rows] = await pool.query(
    `SELECT vp.id, vp.user_id, vp.track_id, vp.video_s3_key, vp.output_s3_key,
            vp.video_start, vp.video_end, vp.audio_start, vp.audio_end,
            vp.status, vp.created_at,
            t.title, t.artist, t.genre, t.duration AS track_duration, t.s3_key AS audio_s3_key
     FROM video_projects vp
     JOIN tracks t ON t.id = vp.track_id
     WHERE vp.id = ?`,
    [req.params.id]
  );

  if (!rows.length) return res.status(404).json({ error: 'Project not found' });

  const project = rows[0];
  if (project.user_id !== req.user.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Generate presigned URLs for the browser
  const videoUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: project.video_s3_key }),
    { expiresIn: 3600 }
  );
  const audioUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: project.audio_s3_key }),
    { expiresIn: 3600 }
  );

  let outputUrl = null;
  if (project.output_s3_key) {
    outputUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: project.output_s3_key }),
      { expiresIn: 86400 }
    );
  }

  res.json({ ...project, videoUrl, audioUrl, outputUrl });
}

async function updateProject(req, res) {
  const { videoStart, videoEnd, audioStart, audioEnd } = req.body;

  const [rows] = await pool.query(
    'SELECT id, user_id FROM video_projects WHERE id = ?',
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Project not found' });
  if (rows[0].user_id !== req.user.userId) return res.status(403).json({ error: 'Forbidden' });

  await pool.query(
    `UPDATE video_projects
     SET video_start = COALESCE(?, video_start),
         video_end   = COALESCE(?, video_end),
         audio_start = COALESCE(?, audio_start),
         audio_end   = COALESCE(?, audio_end)
     WHERE id = ?`,
    [videoStart ?? null, videoEnd ?? null, audioStart ?? null, audioEnd ?? null, req.params.id]
  );

  res.json({ ok: true });
}

async function renderProject(req, res) {
  const [rows] = await pool.query(
    `SELECT vp.*, t.s3_key AS audio_s3_key, t.mime_type AS audio_mime
     FROM video_projects vp
     JOIN tracks t ON t.id = vp.track_id
     WHERE vp.id = ?`,
    [req.params.id]
  );

  if (!rows.length) return res.status(404).json({ error: 'Project not found' });
  const project = rows[0];
  if (project.user_id !== req.user.userId) return res.status(403).json({ error: 'Forbidden' });
  if (project.status === 'rendering') return res.status(409).json({ error: 'Already rendering' });

  await pool.query('UPDATE video_projects SET status = ? WHERE id = ?', ['rendering', project.id]);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vproj-'));
  const videoPath = path.join(tmpDir, 'source.mp4');
  const audioPath = path.join(tmpDir, 'audio');
  const outputPath = path.join(tmpDir, 'output.mp4');

  try {
    send('progress', { step: 'download', label: 'Downloading video...', pct: 0 });

    // Download source video from S3
    const videoObj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: project.video_s3_key }));
    await pipelineAsync(videoObj.Body, fs.createWriteStream(videoPath));

    send('progress', { step: 'download', label: 'Downloading audio...', pct: 25 });

    // Download audio track from S3
    const audioExt = project.audio_mime === 'audio/mpeg' ? '.mp3'
      : project.audio_mime === 'audio/wav' ? '.wav'
      : project.audio_mime === 'audio/flac' ? '.flac'
      : '.mp3';
    const audioPathFull = audioPath + audioExt;
    const audioObj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: project.audio_s3_key }));
    await pipelineAsync(audioObj.Body, fs.createWriteStream(audioPathFull));

    send('progress', { step: 'render', label: 'Rendering video...', pct: 50 });

    // Build ffmpeg command
    const videoStart = project.video_start ?? 0;
    const audioStart = project.audio_start ?? 0;

    await new Promise((resolve, reject) => {
      const cmd = ffmpeg();

      // Input 0: trimmed video
      cmd.input(videoPath);
      if (videoStart > 0) cmd.inputOption(`-ss ${videoStart}`);
      if (project.video_end != null) cmd.inputOption(`-to ${project.video_end}`);

      // Input 1: trimmed audio
      cmd.input(audioPathFull);
      if (audioStart > 0) cmd.inputOption(`-ss ${audioStart}`);
      if (project.audio_end != null) cmd.inputOption(`-to ${project.audio_end}`);

      cmd
        .outputOptions([
          '-map 0:v:0',    // video from input 0
          '-map 1:a:0',    // audio from input 1
          '-c:v libx264',
          '-preset fast',
          '-crf 23',
          '-c:a aac',
          '-b:a 192k',
          '-shortest',     // end when shorter stream ends
          '-movflags +faststart',
        ])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    send('progress', { step: 'upload', label: 'Uploading result...', pct: 80 });

    // Upload rendered output to S3
    const outputKey = `video-projects/output/${project.id}.mp4`;
    const outputBuffer = fs.readFileSync(outputPath);
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: outputKey,
      Body: outputBuffer,
      ContentType: 'video/mp4',
    }));

    // Generate 24-hour download link
    const downloadUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: outputKey,
        ResponseContentDisposition: `attachment; filename="edited-video-${project.id}.mp4"`,
      }),
      { expiresIn: 86400 }
    );

    await pool.query(
      'UPDATE video_projects SET status = ?, output_s3_key = ? WHERE id = ?',
      ['done', outputKey, project.id]
    );

    send('done', { downloadUrl });
  } catch (err) {
    logger.error('videoProjects/render', 'render failed', err);
    await pool.query('UPDATE video_projects SET status = ? WHERE id = ?', ['error', project.id]);
    send('error', { error: err.message });
  } finally {
    // Clean up temp files
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    res.end();
  }
}

async function listProjects(req, res) {
  const [rows] = await pool.query(
    `SELECT vp.id, vp.status, vp.video_start, vp.video_end,
            vp.audio_start, vp.audio_end, vp.created_at, vp.updated_at,
            t.title, t.artist, t.genre
     FROM video_projects vp
     JOIN tracks t ON t.id = vp.track_id
     WHERE vp.user_id = ?
     ORDER BY vp.updated_at DESC`,
    [req.user.userId]
  );
  res.json(rows);
}

module.exports = { createProject, getProject, updateProject, renderProject, listProjects };
