const { Router } = require('express');
const { verifyToken } = require('../middleware/auth');
const { adminOnly } = require('../middleware/adminOnly');
const {
  uploadTrack, getAllTracks, searchTracks, downloadTrack, streamTrack,
  deleteTrack, bulkDeleteTracks, bulkUploadTracks, updateTrack,
} = require('../controllers/tracksController');

const router = Router();

// Public (authenticated) routes
router.get('/search', verifyToken, searchTracks);
router.get('/', verifyToken, getAllTracks);
router.get('/:id/stream', verifyToken, streamTrack);
router.get('/:id/download', verifyToken, downloadTrack);

// Admin-only routes
router.post('/bulk', verifyToken, adminOnly, bulkUploadTracks);
router.post('/', verifyToken, adminOnly, uploadTrack);
router.put('/:id', verifyToken, adminOnly, updateTrack);
router.delete('/', verifyToken, adminOnly, bulkDeleteTracks);
router.delete('/:id', verifyToken, adminOnly, deleteTrack);

module.exports = router;
