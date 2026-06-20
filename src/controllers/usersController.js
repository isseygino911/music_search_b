const { pool } = require('../config/db');

async function getProfile(req, res) {
  const [rows] = await pool.query(
    'SELECT id, email, display_name, role, created_at FROM users WHERE id = ?',
    [req.user.userId]
  );
  if (!rows.length) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json(rows[0]);
}

async function updateProfile(req, res) {
  const { display_name } = req.body;

  if (!display_name || !display_name.trim()) {
    return res.status(400).json({ error: 'display_name is required' });
  }

  await pool.query(
    'UPDATE users SET display_name = ? WHERE id = ?',
    [display_name.trim(), req.user.userId]
  );

  const [rows] = await pool.query(
    'SELECT id, email, display_name, role, created_at FROM users WHERE id = ?',
    [req.user.userId]
  );
  res.json(rows[0]);
}

async function getDownloadHistory(req, res) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = 20;
  const offset = (page - 1) * limit;

  const [rows] = await pool.query(
    `SELECT d.id AS download_id, d.downloaded_at,
            t.id AS track_id, t.title, t.artist, t.genre, t.duration, t.mime_type
     FROM downloads d
     JOIN tracks t ON d.track_id = t.id
     WHERE d.user_id = ?
     ORDER BY d.downloaded_at DESC
     LIMIT ? OFFSET ?`,
    [req.user.userId, limit, offset]
  );

  const [[{ total }]] = await pool.query(
    'SELECT COUNT(*) AS total FROM downloads WHERE user_id = ?',
    [req.user.userId]
  );

  res.json({
    downloads: rows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}

module.exports = { getProfile, updateProfile, getDownloadHistory };
