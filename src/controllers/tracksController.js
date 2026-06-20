const multer = require('multer');
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

const upload = multerConfig.single('audioFile');
const uploadMany = multerConfig.array('audioFiles', 50); // up to 50 files

async function uploadTrack(req, res) {
  upload(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const { title, artist, genre, description } = req.body;
    if (!title || !artist) {
      return res.status(400).json({ error: 'Title and artist are required' });
    }

    // Extract duration from audio buffer (music-metadata v11 is ESM-only, use dynamic import)
    let duration = null;
    try {
      const mm = await import('music-metadata');
      const metadata = await mm.parseBuffer(req.file.buffer, { mimeType: req.file.mimetype });
      duration = metadata.format.duration ? Math.round(metadata.format.duration) : null;
    } catch {
      // Duration extraction failed — continue without it
    }

    // Upload to S3
    const ext = path.extname(req.file.originalname) || '.mp3';
    const s3Key = `uploads/${uuidv4()}${ext}`;

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: s3Key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));

    // Insert into DB
    const [result] = await pool.query(
      `INSERT INTO tracks (title, artist, genre, description, duration, s3_key, file_size, mime_type, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [title, artist, genre || '', description || null, duration, s3Key, req.file.size, req.file.mimetype, req.user.userId]
    );

    const [rows] = await pool.query('SELECT * FROM tracks WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  });
}

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

    const mm = await import('music-metadata');
    const results = [];

    // Process files one at a time to avoid memory spikes
    for (const file of req.files) {
      const filename = file.originalname;
      // Use filename (without extension) as title fallback
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
      } catch (fileErr) {
        results.push({ success: false, filename, error: fileErr.message });
      }
    }

    const uploadedCount = results.filter((r) => r.success).length;
    res.status(207).json({ results, uploaded: uploadedCount, failed: results.length - uploadedCount });
  });
}

module.exports = { uploadTrack, getAllTracks, searchTracks, downloadTrack, deleteTrack, bulkDeleteTracks, bulkUploadTracks };
