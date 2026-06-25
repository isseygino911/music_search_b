const { Router } = require('express');
const { verifyToken } = require('../middleware/auth');
const { adminOnly } = require('../middleware/adminOnly');
const {
  getAllTracks, searchTracks, downloadTrack, getDownloadUrl, streamTrack,
  deleteTrack, bulkDeleteTracks, bulkUploadTracks, updateTrack, syncQdrant,
} = require('../controllers/tracksController');

const router = Router();

// Public (authenticated) routes
router.get('/search', verifyToken, searchTracks);
router.get('/', verifyToken, getAllTracks);
router.get('/:id/stream', verifyToken, streamTrack);
router.get('/:id/download', verifyToken, downloadTrack);
router.get('/:id/download-url', verifyToken, getDownloadUrl);

// Admin-only routes
router.post('/sync-qdrant', verifyToken, adminOnly, syncQdrant);
router.post('/bulk', verifyToken, adminOnly, bulkUploadTracks);
router.put('/:id', verifyToken, adminOnly, updateTrack);
router.delete('/', verifyToken, adminOnly, bulkDeleteTracks);
router.delete('/:id', verifyToken, adminOnly, deleteTrack);

module.exports = router;
