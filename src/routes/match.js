const { Router } = require('express');
const { verifyToken } = require('../middleware/auth');
const { createMatchJob, streamMatchJob, listMatchSessions, getMatchSession, deleteMatchSession } = require('../controllers/matchController');

const router = Router();

router.post('/', verifyToken, createMatchJob);
router.get('/stream/:jobId', verifyToken, streamMatchJob);
router.get('/sessions', verifyToken, listMatchSessions);
router.get('/sessions/:id', verifyToken, getMatchSession);
router.delete('/sessions/:id', verifyToken, deleteMatchSession);

module.exports = router;
