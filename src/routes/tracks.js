const { Router } = require('express');
const { verifyToken } = require('../middleware/auth');
const { adminOnly } = require('../middleware/adminOnly');
const {
  uploadTrack, getAllTracks, searchTracks, downloadTrack,
  deleteTrack, bulkDeleteTracks, bulkUploadTracks,
} = require('../controllers/tracksController');

const router = Router();

// Public (authenticated) routes
router.get('/search', verifyToken, searchTracks);
router.get('/', verifyToken, getAllTracks);
router.get('/:id/download', verifyToken, downloadTrack);

// Admin-only routes
router.post('/bulk', verifyToken, adminOnly, bulkUploadTracks);
router.post('/', verifyToken, adminOnly, uploadTrack);
router.delete('/', verifyToken, adminOnly, bulkDeleteTracks);
router.delete('/:id', verifyToken, adminOnly, deleteTrack);

module.exports = router;
