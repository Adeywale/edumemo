const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authLimiter, passwordResetLimiter } = require('../middleware/rateLimiters');

router.post('/register/student', authController.registerStudent);
router.post('/register/staff', authController.registerStaff);
router.post('/verify-email', authController.verifyEmail);
router.post('/resend-verification', authLimiter, authController.resendVerification);
router.post('/login', authLimiter, authController.login);
router.post('/admin-login', authLimiter, authController.adminLogin);
router.post('/logout', authController.logout);
router.post('/forgot-password', passwordResetLimiter, authController.forgotPassword);
router.post('/reset-password', passwordResetLimiter, authController.resetPassword);
router.get('/me', authController.me);

module.exports = router;
