const express = require('express');
const router = express.Router();
const memoController = require('../controllers/memoController');
const { requireAuth, requireMemoPublisher } = require('../middleware/auth');
const { upload } = require('../middleware/upload');

router.use(requireAuth);

// Every memo-writing endpoint is behind requireMemoPublisher: administrators
// and approved teaching staff only. Non-teaching staff account types are
// receive-only and always get a 403 here. Declared before '/:id' so the path
// is never swallowed by the memo-detail route.
router.get('/estimate', requireMemoPublisher, memoController.estimateRecipients);

// Reading memos: any authenticated user (recipients only ever see their own).
router.get('/', memoController.listMemos);
router.get('/:id', memoController.getMemo);
router.get('/:id/attachment', memoController.downloadAttachment);
router.get('/:id/attachments/:attachmentId', memoController.downloadAttachment);

router.post('/', requireMemoPublisher, upload.array('attachments', 5), memoController.createMemo);
router.put('/:id', requireMemoPublisher, upload.array('attachments', 5), memoController.updateMemo);
router.post('/:id/publish', requireMemoPublisher, memoController.publishMemo);
router.post('/:id/resend', requireMemoPublisher, memoController.resendMemo);
router.post('/:id/archive', requireMemoPublisher, memoController.archiveMemo);
router.delete('/:id', requireMemoPublisher, memoController.deleteMemo);

module.exports = router;
