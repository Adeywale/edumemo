const express = require('express');
const router = express.Router();
const memoController = require('../controllers/memoController');
const { requireAuth, requireRole } = require('../middleware/auth');
const { upload } = require('../middleware/upload');

router.use(requireAuth);

router.get('/estimate', requireRole('staff', 'administrator'), memoController.estimateRecipients);
router.get('/', memoController.listMemos);
router.get('/:id', memoController.getMemo);
router.get('/:id/attachment', memoController.downloadAttachment);
router.get('/:id/attachments/:attachmentId', memoController.downloadAttachment);

router.post('/', requireRole('staff', 'administrator'), upload.array('attachments', 5), memoController.createMemo);
router.put('/:id', requireRole('staff', 'administrator'), upload.array('attachments', 5), memoController.updateMemo);
router.post('/:id/publish', requireRole('staff', 'administrator'), memoController.publishMemo);
router.post('/:id/resend', requireRole('staff', 'administrator'), memoController.resendMemo);
router.post('/:id/archive', requireRole('staff', 'administrator'), memoController.archiveMemo);
router.delete('/:id', requireRole('staff', 'administrator'), memoController.deleteMemo);

module.exports = router;
