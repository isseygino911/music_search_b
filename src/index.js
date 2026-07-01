require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const logger = require('./services/logger');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { testConnection, pool } = require('./config/db');
const { ensureCollection } = require('./config/qdrant');

async function runMigrations() {
  const migrationsDir = path.join(__dirname, 'db');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    // Split on semicolons to handle multi-statement files
    const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      await pool.query(stmt);
    }
    console.log(`Migration applied: ${file}`);
  }
}

const authRoutes = require('./routes/auth');
const tracksRoutes = require('./routes/tracks');
const usersRoutes = require('./routes/users');
const matchRoutes = require('./routes/match');
const videoProjectsRoutes = require('./routes/videoProjects');

const app = express();

app.set('trust proxy', 1);
const allowedOrigins = ['http://localhost:5173', 'https://isseylab.com', 'https://api.isseylab.com'];
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)),
  credentials: true,
}));
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.json());

// Rate limit auth endpoints to prevent brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { error: 'Too many requests, please try again later' },
});

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/tracks', tracksRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/match', matchRoutes);
app.use('/api/video-projects', videoProjectsRoutes);

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Global error handler
app.use((err, _req, res, _next) => {
  logger.error('express', 'unhandled error', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = Number(process.env.PORT) || 4000;

testConnection()
  .then(async () => {
    try {
      await runMigrations();
    } catch (err) {
      console.warn('Migration warning:', err.message);
    }
    try {
      await ensureCollection();
    } catch (err) {
      console.warn('Qdrant not available, video matching disabled:', err.message);
    }
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to connect to database:', err.message);
    process.exit(1);
  });
