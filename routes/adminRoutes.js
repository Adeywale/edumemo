const express = require('express');
const router = express.Router();
const admin = require('../controllers/adminController');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth, requireRole('administrator'));

router.get('/overview', admin.overview);
router.get('/reports', admin.reports);
router.get('/users', admin.listUsers);
router.get('/users/:id', admin.getUserDetails);
router.post('/staff/:id/approve', admin.approveStaff);

router.get('/users', admin.listUsers);
router.post('/staff/:id/approve', admin.approveStaff);
router.post('/staff/:id/suspend', admin.suspendStaff);
router.post('/staff/:id/reactivate', admin.reactivateStaff);
router.post('/staff/:id/broadcast-permission', admin.toggleStaffBroadcastPermission);
router.put('/staff/:id/type', admin.updateStaffType);
router.post('/students/:id/suspend', admin.suspendStudent);
router.post('/students/:id/reactivate', admin.reactivateStudent);

router.get('/memo-records', admin.memoRecords);
router.get('/audit-logs', admin.listAuditLogs);

router.get('/settings', admin.getSettings);
router.put('/settings', admin.updateSettings);

module.exports = router;
