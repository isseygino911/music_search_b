require('dotenv').config();

const express = require('express');
const logger = require('./services/logger');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { testConnection } = require('./config/db');
const { ensureCollection } = require('./config/qdrant');

const authRoutes = require('./routes/auth');
const tracksRoutes = require('./routes/tracks');
const usersRoutes = require('./routes/users');
const matchRoutes = require('./routes/match');

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
