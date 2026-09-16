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
    // A small pool of reused connections keeps a bulk memo (one message per
    // recipient) inside what Gmail accepts from a single client. Opening a
    // fresh SMTP session per recipient -- and several of them at a time --
    // is what provokes Gmail's "421/454, try again later" throttling, after
    // which mail stops being accepted for the whole account and recipients
    // simply stop hearing about new memos. Reuse also skips a TLS handshake
    // per message, so a large class is notified much faster.
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
  });
}

/**
 * Some ISPs/firewalls/antivirus products intermittently swallow SMTP traffic
 * after the TCP handshake (nodemailer then reports "Greeting never received"
 * or drops the socket mid-session). Mail hosts also throttle bursty senders:
 * Gmail answers with 4xx replies such as "421 4.7.0 Try again later" or
 * "454 4.7.0 Too many login attempts". All of these are temporary, so the send
 * is retried after a delay with a fresh attempt. Auth failures and mailbox-level
 * rejections are permanent and are NOT retried — retrying those just burns time
 * and risks lockouts.
 */
const RETRY_DELAYS_MS = [3000, 8000, 15000];
// Throttle replies need a much longer cool-down than a dropped connection:
// retrying a 421/454 too soon is itself what keeps the throttle in place.
const THROTTLE_DELAYS_MS = [15000, 45000, 90000];

/** The SMTP server answered with a temporary (4xx) reply, e.g. a throttle. */
function isThrottleError(err) {
  const message = String((err && err.response) || (err && err.message) || '');
  return /^(421|450|451|452|454)\b/.test(message.trim()) || /try again later|too many|rate limit|throttl|temporar/i.test(message);
}

function isTransientError(err) {
  const message = String(err && err.message || '');
  const response = String(err && err.response || '');
  const code = String(err && err.code || '');
  if (code === 'EAUTH') return false; // bad/revoked credentials — retrying cannot help
  if (/^5\d\d/.test(message) || /^5\d\d/.test(response.trim())) return false; // permanent SMTP rejection (bad mailbox, spam block, daily limit)
  if (isThrottleError(err)) return true; // 4xx throttle — wait, then retry
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
      This is an automated email from ${institution}. Do not reply to this email.
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

/**
 * Sends an email. If SMTP is not configured, the message is logged to the
 * console for development/testing -- but the result says so explicitly
 * (`skipped: true`) so the caller never records a message that was never
 * handed to a mail server as a successful delivery. Every message is sent as
 * multipart/alternative (HTML + auto-generated plain text) with a Reply-To,
 * which materially improves inbox placement.
 */
async function sendEmail({ to, subject, html }) {
  const text = htmlToText(html);
  if (!isConfigured) {
    console.log('\n--- [DEV EMAIL - SMTP NOT CONFIGURED, NOT ACTUALLY SENT] ---');
    console.log('To:', to);
    console.log('Subject:', subject);
    console.log('Body (text preview):', text);
    console.log('-----------------------------------------------------------\n');
    if (process.env.NODE_ENV === 'production') {
      console.error(
        'ERROR: SMTP is not configured on this deployment, so NO memo email can be delivered. ' +
        'Set SMTP_HOST/SMTP_USER/SMTP_PASSWORD/SMTP_FROM_EMAIL in the environment.'
      );
    }
    return { ok: false, skipped: true, error: 'SMTP is not configured on the server — nothing was sent.' };
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

  // Attempt the send, retrying temporary failures (dropped connections and
  // server-side throttling) with a growing delay. The delay used depends on
  // what went wrong: a lost connection is retried quickly, while a 4xx
  // throttle is given a long cool-down before the message is offered again.
  let lastErr = null;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      await transporter.sendMail(mailOptions);
      if (attempt > 1) console.log(`Email send succeeded on attempt ${attempt} for ${to}.`);
      return { ok: true };
    } catch (err) {
      lastErr = err;
      console.error(`Email send attempt ${attempt} failed for ${to}: ${err.message}`);

      if (!isTransientError(err)) break; // permanent: bad credentials, unknown mailbox, spam block
      const throttled = isThrottleError(err);
      const delays = throttled ? THROTTLE_DELAYS_MS : RETRY_DELAYS_MS;
      if (attempt > delays.length) break;
      const waitMs = delays[attempt - 1];
      console.log(
        `Retrying email to ${to} in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1})` +
        (throttled ? ' — the mail server is throttling, backing off.' : '...')
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
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

// `awaitingApproval` is set for staff registrations: their account cannot be
// used until an administrator approves it, so the email asks them to wait for
// the approval notice instead of inviting them to log in straight away.
function sendWelcomeEmail(to, name, loginUrl, awaitingApproval = false) {
  const html = wrapTemplate('Welcome to EduMemo', awaitingApproval
    ? `
    <p>Hello ${name},</p>
    <p>Thank you for registering on the EduMemo memo distribution system. Your staff account has been created, but an administrator must approve it before you can log in.</p>
    <p>You will receive a confirmation email as soon as your account has been approved.</p>
    <p>If you did not create this account, please contact your institution's administration.</p>
  `
    : `
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
  // The green "View Memo" button is rendered for every recipient in every
  // environment -- including localhost development, where BASE_URL is not a
  // public domain. It links to the same memo permalink used by the web push
  // notification (/memo/:id), so one click opens the published memo straight
  // away (a visitor who is not signed in is sent through the login page first).
  //
  // The button is built with a <table>, not a bare <a>: Gmail, Outlook and
  // mobile clients strip background/padding styles from inline anchors, which
  // turns them into plain underlined text. A table cell with bgcolor survives
  // those rewrites, so the button always looks and behaves like a real button.
  const html = wrapTemplate(memo.title, `
    <p>Hello ${name},</p>
    <p>A new memo titled <strong>${memo.title}</strong> has been published${memo.senderName ? ' by ' + memo.senderName : ''}.</p>
    <p style="margin-top:20px;">Login to view memo</p>
    <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:16px 0;">
      <tr>
        <td align="center" bgcolor="#1b8a3d" style="border-radius:6px;background-color:#1b8a3d;padding:14px 36px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:#ffffff;">
          <a href="${memoUrl}" target="_blank" style="display:inline-block;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;">VIEW MEMO</a>
        </td>
      </tr>
    </table>
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
