const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const {
  createProject,
  getProject,
  updateProject,
  renderProject,
  listProjects,
} = require('../controllers/videoProjectsController');

router.use(verifyToken);

router.get('/', listProjects);
router.post('/', createProject);
router.get('/:id', getProject);
router.patch('/:id', updateProject);
router.post('/:id/render', renderProject);

module.exports = router;
