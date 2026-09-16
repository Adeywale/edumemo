/*
 * Verifies that a memo notification email is REALLY accepted by the SMTP server
 * right now (not just "logged as sent"). Sends one message to the address given
 * as the first argument (defaults to the configured SMTP_FROM_EMAIL inbox).
 *
 * Run with:   node test-smtp-send.js [recipient@example.com]
 */
require('dotenv').config();
const nodemailer = require('nodemailer');
const emailService = require('./services/emailService');

const to = process.argv[2] || process.env.SMTP_FROM_EMAIL;

(async () => {
  console.log('SMTP configured:', emailService.isConfigured);
  console.log('SMTP host      :', process.env.SMTP_HOST, 'port', process.env.SMTP_PORT, 'secure', process.env.SMTP_SECURE);
  console.log('Sending to     :', to);

  // 1. Plain SMTP conversation, so the server's real answer is visible.
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    family: 4,
    logger: true,
    debug: false,
  });

  try {
    const info = await transporter.sendMail({
      from: `"${process.env.SMTP_FROM_NAME || 'EduMemo'}" <${process.env.SMTP_FROM_EMAIL}>`,
      to,
      subject: 'EduMemo SMTP delivery check',
      text: 'If you can read this, the SMTP pipeline works end to end.',
      html: '<p>If you can read this, the <strong>SMTP pipeline works end to end</strong>.</p>',
    });
    console.log('\nRAW SMTP SEND: accepted');
    console.log('  response:', info.response);
    console.log('  messageId:', info.messageId);
    if (info.accepted) console.log('  accepted:', info.accepted.join(', '));
    if (info.rejected && info.rejected.length) console.log('  rejected:', info.rejected.join(', '));
  } catch (err) {
    console.log('\nRAW SMTP SEND: FAILED');
    console.log('  code   :', err.code);
    console.log('  message:', err.message);
    if (err.response) console.log('  server :', err.response);
  } finally {
    transporter.close();
  }

  // 2. The same code path the app uses for a published memo.
  const result = await emailService.sendMemoNotificationEmail(
    to,
    'Delivery check',
    { title: 'EduMemo memo-notification delivery check', senderName: 'EduMemo diagnostics' },
    `${process.env.BASE_URL || 'http://localhost:3000'}/memo/0`
  );
  console.log('\nemailService.sendMemoNotificationEmail ->', JSON.stringify(result));
})().catch((err) => { console.error('crashed:', err); process.exit(1); });