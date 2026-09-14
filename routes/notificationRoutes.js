const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

router.get('/', notificationController.listNotifications);
router.get('/unread-count', notificationController.unreadCount);
router.post('/:id/read', notificationController.markAsRead);
router.post('/read-all', notificationController.markAllAsRead);

router.get('/push/public-key', notificationController.getPushPublicKey);
router.post('/push/subscribe', notificationController.subscribePush);
router.post('/push/unsubscribe', notificationController.unsubscribePush);

module.exports = router;
