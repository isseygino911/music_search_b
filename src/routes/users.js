const { Router } = require('express');
const { verifyToken } = require('../middleware/auth');
const { getProfile, updateProfile, getDownloadHistory } = require('../controllers/usersController');

const router = Router();

router.get('/me', verifyToken, getProfile);
router.put('/me', verifyToken, updateProfile);
router.get('/me/downloads', verifyToken, getDownloadHistory);

module.exports = router;
