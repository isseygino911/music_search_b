const multer = require('multer');
const logger = require('../services/logger');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { s3, BUCKET } = require('../config/s3');
const { pool } = require('../config/db');

const ALLOWED_MIME = ['audio/mpeg', 'audio/wav', 'audio/flac', 'audio/aac', 'audio/ogg', 'audio/mp4'];

const multerConfig = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB per file
  fileFilter(_req, file, cb) {
    if (ALLOWED_MIME.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
});

const uploadMany = multerConfig.array('audioFiles', 50); // up to 50 files

async function getAllTracks(_req, res) {
  const [rows] = await pool.query(
    'SELECT id, title, artist, genre, description, duration, file_size, mime_type, uploaded_at FROM tracks ORDER BY uploaded_at DESC'
  );
  res.json(rows);
}

async function searchTracks(req, res) {
  const { q, genre, artist } = req.query;

  if (!q) {
    return getAllTracks(null, res);
  }

  let rows;

  if (q.length >= 3) {
    // Full-text search for longer queries
    const searchTerm = q.split(' ').map(word => `+${word}*`).join(' ');
    const conditions = [];
    const params = [searchTerm];

    if (genre) { conditions.push('AND genre LIKE ?'); params.push(`%${genre}%`); }
    if (artist) { conditions.push('AND artist LIKE ?'); params.push(`%${artist}%`); }

    [rows] = await pool.query(
      `SELECT id, title, artist, genre, description, duration, file_size, mime_type, uploaded_at,
              MATCH(title, artist, genre, description) AGAINST (? IN BOOLEAN MODE) AS relevance
       FROM tracks
       WHERE MATCH(title, artist, genre, description) AGAINST (? IN BOOLEAN MODE)
       ${conditions.join(' ')}
       ORDER BY relevance DESC
       LIMIT 50`,
      [searchTerm, ...params]
    );
  } else {
    // LIKE fallback for short queries
    const like = `%${q}%`;
    const conditions = [];
    const params = [like, like, like, like];

    if (genre) { conditions.push('AND genre LIKE ?'); params.push(`%${genre}%`); }
    if (artist) { conditions.push('AND artist LIKE ?'); params.push(`%${artist}%`); }

    [rows] = await pool.query(
      `SELECT id, title, artist, genre, description, duration, file_size, mime_type, uploaded_at
       FROM tracks
       WHERE (title LIKE ? OR artist LIKE ? OR genre LIKE ? OR description LIKE ?)
       ${conditions.join(' ')}
       ORDER BY uploaded_at DESC
       LIMIT 50`,
      params
    );
  }

  res.json(rows);
}

async function downloadTrack(req, res) {
  const trackId = Number(req.params.id);

  const [rows] = await pool.query('SELECT id, title, mime_type, s3_key FROM tracks WHERE id = ?', [trackId]);
  if (!rows.length) {
    return res.status(404).json({ error: 'Track not found' });
  }

  const track = rows[0];

  // Log the download
  await pool.query(
    'INSERT INTO downloads (user_id, track_id) VALUES (?, ?)',
    [req.user.userId, trackId]
  );

  // Determine file extension for download filename
  const ext = track.mime_type === 'audio/mpeg' ? '.mp3'
    : track.mime_type === 'audio/wav' ? '.wav'
    : track.mime_type === 'audio/flac' ? '.flac'
    : '.mp3';

  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: track.s3_key,
    ResponseContentDisposition: `attachment; filename="${track.title}${ext}"`,
  });

  const signedUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
  res.redirect(302, signedUrl);
}

async function deleteTrack(req, res) {
  const trackId = Number(req.params.id);

  const [rows] = await pool.query('SELECT s3_key FROM tracks WHERE id = ?', [trackId]);
  if (!rows.length) {
    return res.status(404).json({ error: 'Track not found' });
  }

  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: rows[0].s3_key }));
  await pool.query('DELETE FROM tracks WHERE id = ?', [trackId]);

  res.json({ message: 'Track deleted' });
}

async function bulkDeleteTracks(req, res) {
  const { ids } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  if (ids.length > 100) {
    return res.status(400).json({ error: 'Cannot delete more than 100 tracks at once' });
  }

  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await pool.query(`SELECT id, s3_key FROM tracks WHERE id IN (${placeholders})`, ids);

  if (rows.length === 0) {
    return res.status(404).json({ error: 'No matching tracks found' });
  }

  // Delete all S3 objects in one request
  await s3.send(new DeleteObjectsCommand({
    Bucket: BUCKET,
    Delete: { Objects: rows.map((r) => ({ Key: r.s3_key })) },
  }));

  const foundIds = rows.map((r) => r.id);
  const deletePlaceholders = foundIds.map(() => '?').join(',');
  await pool.query(`DELETE FROM tracks WHERE id IN (${deletePlaceholders})`, foundIds);

  res.json({ deleted: foundIds.length });
}

async function bulkUploadTracks(req, res) {
  uploadMany(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No audio files provided' });
    }

    const { artist, genre, description } = req.body;
    if (!artist) {
      return res.status(400).json({ error: 'Artist is required' });
    }

    // Stream progress back to client via SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const mm = await import('music-metadata');
    const results = [];
    const total = req.files.length;

    for (let i = 0; i < total; i++) {
      const file = req.files[i];
      const filename = file.originalname;
      const title = path.basename(filename, path.extname(filename));

      try {
        let duration = null;
        try {
          const metadata = await mm.parseBuffer(file.buffer, { mimeType: file.mimetype });
          duration = metadata.format.duration ? Math.round(metadata.format.duration) : null;
        } catch {
          // Duration extraction failed — continue without it
        }

        const ext = path.extname(filename) || '.mp3';
        const s3Key = `uploads/${uuidv4()}${ext}`;

        await s3.send(new PutObjectCommand({
          Bucket: BUCKET,
          Key: s3Key,
          Body: file.buffer,
          ContentType: file.mimetype,
        }));

        const [result] = await pool.query(
          `INSERT INTO tracks (title, artist, genre, description, duration, s3_key, file_size, mime_type, uploaded_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [title, artist, genre || '', description || null, duration, s3Key, file.size, file.mimetype, req.user.userId]
        );

        const [trackRows] = await pool.query('SELECT * FROM tracks WHERE id = ?', [result.insertId]);
        results.push({ success: true, filename, track: trackRows[0] });
        send('progress', { index: i + 1, total, filename, success: true });

        // Fire-and-forget: Gemini listens to audio → save description → embed → Qdrant
        const { analyzeAudio, embedText } = require('../services/gemini');
        const { upsertVector } = require('../services/qdrant');
        const trackId = result.insertId;
        analyzeAudio(file.buffer, file.mimetype)
          .then(async (desc) => {
            await pool.query('UPDATE tracks SET description = ? WHERE id = ?', [desc, trackId]);
            const vector = await embedText(desc);
            await upsertVector(trackId, vector);
          })
          .catch((err) => logger.warn('tracks/embed', `Qdrant embed failed for track ${trackId}`, err));
      } catch (fileErr) {
        results.push({ success: false, filename, error: fileErr.message });
        send('progress', { index: i + 1, total, filename, success: false, error: fileErr.message });
      }
    }

    const uploadedCount = results.filter((r) => r.success).length;
    send('done', { results, uploaded: uploadedCount, failed: total - uploadedCount });
    res.end();
  });
}

async function getDownloadUrl(req, res) {
  const trackId = Number(req.params.id);
  const [rows] = await pool.query('SELECT id, title, mime_type, s3_key FROM tracks WHERE id = ?', [trackId]);
  if (!rows.length) return res.status(404).json({ error: 'Track not found' });

  const track = rows[0];

  await pool.query('INSERT INTO downloads (user_id, track_id) VALUES (?, ?)', [req.user.userId, trackId]);

  const ext = track.mime_type === 'audio/mpeg' ? '.mp3'
    : track.mime_type === 'audio/wav' ? '.wav'
    : track.mime_type === 'audio/flac' ? '.flac'
    : '.mp3';

  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: track.s3_key,
    ResponseContentDisposition: `attachment; filename="${track.title}${ext}"`,
  });

  const url = await getSignedUrl(s3, command, { expiresIn: 300 });
  res.json({ url });
}

async function streamTrack(req, res) {
  const trackId = Number(req.params.id);
  const [rows] = await pool.query('SELECT s3_key FROM tracks WHERE id = ?', [trackId]);
  if (!rows.length) return res.status(404).json({ error: 'Track not found' });

  const command = new GetObjectCommand({ Bucket: BUCKET, Key: rows[0].s3_key });
  const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
  res.json({ url });
}

async function updateTrack(req, res) {
  const trackId = Number(req.params.id);
  const { title, artist, genre, description } = req.body;

  if (!title || !artist) {
    return res.status(400).json({ error: 'Title and artist are required' });
  }

  const [result] = await pool.query(
    'UPDATE tracks SET title=?, artist=?, genre=?, description=? WHERE id=?',
    [title, artist, genre || '', description || null, trackId]
  );

  if (result.affectedRows === 0) {
    return res.status(404).json({ error: 'Track not found' });
  }

  const [rows] = await pool.query(
    'SELECT id, title, artist, genre, description, duration, file_size, mime_type, uploaded_at FROM tracks WHERE id = ?',
    [trackId]
  );

  // Fire-and-forget: re-embed if description was updated
  if (description) {
    const { embedText } = require('../services/gemini');
    const { upsertVector } = require('../services/qdrant');
    embedText(description)
      .then((vector) => upsertVector(trackId, vector))
      .catch((err) => logger.warn('tracks/re-embed', `Qdrant re-embed failed for track ${trackId}`, err));
  }

  res.json(rows[0]);
}

async function syncQdrant(_req, res) {
  const { analyzeAudio, embedText } = require('../services/gemini');
  const { upsertVector } = require('../services/qdrant');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const [tracks] = await pool.query('SELECT id, s3_key, mime_type, description FROM tracks');

  const total = tracks.length;
  let synced = 0;
  let failed = 0;

  for (const track of tracks) {
    try {
      let desc = track.description;
      if (!desc) {
        // No saved description yet — fetch audio from S3 and let Gemini analyze it
        const { Body } = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: track.s3_key }));
        const chunks = [];
        for await (const chunk of Body) chunks.push(chunk);
        const audioBuffer = Buffer.concat(chunks);
        desc = await analyzeAudio(audioBuffer, track.mime_type);
        await pool.query('UPDATE tracks SET description = ? WHERE id = ?', [desc, track.id]);
      }
      const vector = await embedText(desc);
      await upsertVector(track.id, vector);
      synced++;
      send('progress', { index: synced + failed, total, trackId: track.id, success: true });
    } catch (err) {
      failed++;
      logger.error('tracks/sync', `failed for track ${track.id}`, err);
      send('progress', { index: synced + failed, total, trackId: track.id, success: false, error: err.message });
    }
  }

  send('done', { synced, failed, total });
  res.end();
}

module.exports = { getAllTracks, searchTracks, downloadTrack, getDownloadUrl, streamTrack, deleteTrack, bulkDeleteTracks, bulkUploadTracks, updateTrack, syncQdrant };
