const express = require('express');
const router = express.Router();
const profile = require('../controllers/profileController');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

router.get('/', profile.getProfile);
router.put('/', profile.updateProfile);
router.post('/change-password', profile.changePassword);
router.put('/notification-preferences', profile.updateNotificationPreferences);

module.exports = router;
