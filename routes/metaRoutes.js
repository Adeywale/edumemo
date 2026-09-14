const express = require('express');
const router = express.Router();
const meta = require('../controllers/metaController');
const { requireAuth, requireRole } = require('../middleware/auth');

// Public-ish read endpoints (still require login, used by registration forms
// pre-login too -- so these specific GETs are open for registration UX).
router.get('/faculties', meta.listFaculties);
router.get('/departments', meta.listDepartments);
router.get('/programmes', meta.listProgrammes);
router.get('/levels', meta.listLevels);
router.get('/study-modes', meta.listStudyModes);
router.get('/courses', meta.listCourses);
router.get('/categories', meta.listCategories);

// Admin-only management
const adminOnly = [requireAuth, requireRole('administrator')];
router.post('/faculties', ...adminOnly, meta.facultyCrud.create);
router.put('/faculties/:id', ...adminOnly, meta.facultyCrud.update);
router.delete('/faculties/:id', ...adminOnly, meta.facultyCrud.remove);

router.post('/departments', ...adminOnly, meta.departmentCrud.create);
router.put('/departments/:id', ...adminOnly, meta.departmentCrud.update);
router.delete('/departments/:id', ...adminOnly, meta.departmentCrud.remove);

router.post('/programmes', ...adminOnly, meta.programmeCrud.create);
router.put('/programmes/:id', ...adminOnly, meta.programmeCrud.update);
router.delete('/programmes/:id', ...adminOnly, meta.programmeCrud.remove);

router.post('/levels', ...adminOnly, meta.levelCrud.create);
router.put('/levels/:id', ...adminOnly, meta.levelCrud.update);
router.delete('/levels/:id', ...adminOnly, meta.levelCrud.remove);

router.post('/study-modes', ...adminOnly, meta.studyModeCrud.create);
router.put('/study-modes/:id', ...adminOnly, meta.studyModeCrud.update);
router.delete('/study-modes/:id', ...adminOnly, meta.studyModeCrud.remove);

router.post('/courses', ...adminOnly, meta.courseCrud.create);
router.put('/courses/:id', ...adminOnly, meta.courseCrud.update);
router.delete('/courses/:id', ...adminOnly, meta.courseCrud.remove);

router.post('/categories', ...adminOnly, meta.categoryCrud.create);
router.put('/categories/:id', ...adminOnly, meta.categoryCrud.update);
router.delete('/categories/:id', ...adminOnly, meta.categoryCrud.remove);

module.exports = router;
