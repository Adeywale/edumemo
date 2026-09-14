const nodemailer = require('nodemailer');

const {
  SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD,
  SMTP_FROM_EMAIL, SMTP_FROM_NAME, INSTITUTION_NAME,
} = process.env;

const isConfigured = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASSWORD && SMTP_FROM_EMAIL);

let transporter = null;
if (isConfigured) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: SMTP_SECURE === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
    // Some networks advertise (or half-route) IPv6 but drop the traffic; pin
    // the SMTP connection to IPv4 so a broken IPv6 path can never stall sends.
    family: 4,
  });
}

/**
 * Some ISPs/firewalls/antivirus products intermittently swallow SMTP traffic
 * after the TCP handshake (nodemailer then reports "Greeting never received"
 * or drops the socket mid-session). Retrying the same send a few seconds
 * later usually succeeds, because the blocking is transient rather than
 * absolute. Auth failures and mailbox-level rejections are permanent and are
 * NOT retried — retrying those just burns time and risks lockouts.
 */
const RETRY_DELAYS_MS = [3000, 8000, 15000];
function isTransientError(err) {
  const message = String(err && err.message || '');
  const code = String(err && err.code || '');
  if (code === 'EAUTH') return false; // bad/revoked credentials — retrying cannot help
  if (/^5\d\d/.test(message)) return false; // permanent SMTP rejection (bad mailbox, spam block)
  return (
    /Greeting never received|Connection closed|Connection timeout|timeout/i.test(message) ||
    ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNCLOSED', 'EDNS'].includes(code)
  );
}

function wrapTemplate(title, bodyHtml) {
  const institution = INSTITUTION_NAME || 'EduMemo';
  return `
  <div style="font-family: Arial, Helvetica, sans-serif; max-width: 560px; margin: 0 auto; color:#1a1a1a;">
    <div style="padding: 20px 0; border-bottom: 3px solid #1b8a3d;">
      <strong style="font-size: 18px; letter-spacing: 0.5px;">${institution}</strong>
    </div>
    <div style="padding: 24px 0;">
      <h2 style="margin: 0 0 12px; font-size: 18px;">${title}</h2>
      ${bodyHtml}
    </div>
    <div style="padding: 16px 0; border-top: 1px solid #e2e2e2; font-size: 12px; color: #888;">
      This is an automated message from ${institution}'s EduMemo system. Please do not reply to this email.
    </div>
  </div>`;
}

/**
 * Converts the HTML email into a plain-text alternative. Sending a
 * multipart/alternative (HTML + text) message is one of the strongest
 * legitimate-mail signals — HTML-only emails are a classic spam trait and
 * score heavily with Gmail/Outlook filters.
 */
function htmlToText(html) {
  return html
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => {
      const text = label.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      return /^\s*$/.test(text) ? href : `${text}: ${href}`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Spam filters distrust localhost/private-IP links (they look like phishing). */
function isPublicUrl(url) {
  return /^(https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+)/i.test(url) && !/\/\/(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url);
}

/**
 * Sends an email, or, if SMTP is not configured, logs it to the console so
 * development/testing can proceed without real credentials.
 * Every message is sent as multipart/alternative (HTML + auto-generated plain
 * text) with a Reply-To, which materially improves inbox placement.
 */
async function sendEmail({ to, subject, html }) {
  const text = htmlToText(html);
  if (!isConfigured) {
    console.log('\n--- [DEV EMAIL - SMTP NOT CONFIGURED] ---');
    console.log('To:', to);
    console.log('Subject:', subject);
    console.log('Body (text preview):', text);
    console.log('------------------------------------------\n');
    return { ok: true, dev: true };
  }

  const mailOptions = {
    from: `"${SMTP_FROM_NAME || INSTITUTION_NAME || 'EduMemo'}" <${SMTP_FROM_EMAIL}>`,
    replyTo: SMTP_FROM_EMAIL,
    to,
    subject,
    html,
    text,
    // Transactional (auto-generated) headers: legitimate automated mail marks
    // itself as such so filters can distinguish it from bulk marketing spam.
    headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'OOF, DR, RN, NRN, AutoReply' },
  };

  // Attempt the send, retrying transient network failures with a growing
  // delay. Every attempt gets a fresh SMTP connection, which is exactly what
  // defeats the "connection opens but the greeting is swallowed" pattern.
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length + 1; attempt++) {
    try {
      await transporter.sendMail(mailOptions);
      if (attempt > 1) console.log(`Email send succeeded on attempt ${attempt} for ${to}.`);
      return { ok: true };
    } catch (err) {
      lastErr = err;
      const isLast = attempt > RETRY_DELAYS_MS.length;
      console.error(`Email send attempt ${attempt} failed for ${to}: ${err.message}`);
      if (isLast || !isTransientError(err)) break;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
      console.log(`Retrying email send to ${to} (attempt ${attempt + 1})...`);
    }
  }
  return { ok: false, error: lastErr ? lastErr.message : 'Unknown SMTP error' };
}

function sendVerificationEmail(to, name, verifyUrl) {
  const html = wrapTemplate('Verify your email address', `
    <p>Hello ${name},</p>
    <p>Thanks for registering on EduMemo. Please confirm your email address to activate your account.</p>
    <p><a href="${verifyUrl}" style="background:#1b8a3d;color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none;display:inline-block;">Verify Email</a></p>
    <p>Or copy this link into your browser:<br>${verifyUrl}</p>
    <p>This link expires in 48 hours.</p>
  `);
  return sendEmail({ to, subject: 'Verify your EduMemo account', html });
}

function sendWelcomeEmail(to, name, loginUrl) {
  const html = wrapTemplate('Welcome to EduMemo', `
    <p>Hello ${name},</p>
    <p>Thank you for registering on the EduMemo memo distribution system. Your account is ready to use — no email verification is required.</p>
    <p><a href="${loginUrl}" style="background:#1b8a3d;color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none;display:inline-block;">Log in to EduMemo</a></p>
    <p>If you did not create this account, please contact your institution's administration.</p>
  `);
  return sendEmail({ to, subject: 'Welcome to EduMemo', html });
}

function sendPasswordResetEmail(to, name, resetUrl) {
  const html = wrapTemplate('Reset your password', `
    <p>Hello ${name},</p>
    <p>We received a request to reset your password. Click below to choose a new one:</p>
    <p><a href="${resetUrl}" style="background:#1b8a3d;color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none;display:inline-block;">Reset Password</a></p>
    <p>If you did not request this, you can safely ignore this email. This link expires in 1 hour.</p>
  `);
  return sendEmail({ to, subject: 'Reset your EduMemo password', html });
}

function sendStaffApprovalEmail(to, name, approved) {
  const html = approved
    ? wrapTemplate('Account Approved', `<p>Hello ${name},</p><p>Your staff account has been approved. You can now log in and publish official memos.</p>`)
    : wrapTemplate('Account Suspended', `<p>Hello ${name},</p><p>Your staff account has been suspended. Please contact the administration for details.</p>`);
  return sendEmail({ to, subject: approved ? 'Your EduMemo staff account has been approved' : 'Your EduMemo staff account has been suspended', html });
}

/** Shared subject so the email and its delivery-log row always match. */
function memoNotificationSubject(memoTitle) {
  const institution = INSTITUTION_NAME || 'EduMemo';
  return `${institution} — New Memo: ${memoTitle}`;
}

function sendMemoNotificationEmail(to, name, memo, memoUrl) {
  // A "click here" button pointing at a localhost/private URL is one of the
  // strongest phishing signals in the message — only include it when BASE_URL
  // is a real public domain. Otherwise tell the reader to log in instead.
  const linkHtml = isPublicUrl(memoUrl)
    ? `<p><a href="${memoUrl}" style="background:#1b8a3d;color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none;display:inline-block;">View Memo</a></p>
       <p style="font-size:12px;color:#666;">Or paste this link into your browser:<br>${memoUrl}</p>`
    : `<p>Log in to the ${INSTITUTION_NAME || 'EduMemo'} portal and open <strong>Received Memos</strong> to read it.</p>`;
  const html = wrapTemplate(memo.title, `
    <p>Hello ${name},</p>
    <p>A new memo titled <strong>${memo.title}</strong> has been published${memo.senderName ? ' by ' + memo.senderName : ''}.</p>
    ${linkHtml}
  `);
  return sendEmail({ to, subject: memoNotificationSubject(memo.title), html });
}

module.exports = {
  isConfigured,
  sendEmail,
  sendVerificationEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendStaffApprovalEmail,
  sendMemoNotificationEmail,
  memoNotificationSubject,
};
