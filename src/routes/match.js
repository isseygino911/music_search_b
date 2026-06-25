const { Router } = require('express');
const { verifyToken } = require('../middleware/auth');
const { createMatchJob, streamMatchJob } = require('../controllers/matchController');

const router = Router();

router.post('/', verifyToken, createMatchJob);
router.get('/stream/:jobId', verifyToken, streamMatchJob);

module.exports = router;
