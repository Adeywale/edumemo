const bcrypt = require('bcryptjs');
const db = require('../database/db');
const { logAction } = require('../utils/audit');
const {
  createVerificationToken, consumeVerificationToken,
  createPasswordResetToken, consumePasswordResetToken,
} = require('../utils/tokens');
const emailService = require('../services/emailService');

const SALT_ROUNDS = 12;
const NAME_PATTERN = /^[\p{L}][\p{L}\s'-]*$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function baseUrl(req) {
  return process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
}

function publicUser(user) {
  return {
    id: user.id,
    role: user.role,
    email: user.email,
    firstName: user.first_name,
    lastName: user.last_name,
    status: user.status,
    staffType: user.staff_type || null,
    emailVerified: !!user.email_verified,
  };
}

// ---------------- STUDENT REGISTRATION ----------------
function registerStudent(req, res) {
  const {
    firstName, lastName, otherName, phone,
    matricNumber, facultyId, departmentId, departmentName, programmeId, levelId, studyModeId,
    email, password, confirmPassword, enablePush,
  } = req.body;

  if (!firstName || !lastName || !matricNumber || !facultyId || !(departmentName || departmentId) || !email || !password) {
    return res.status(400).json({ error: 'Please fill in all required fields.' });
  }
  if (!NAME_PATTERN.test(firstName.trim()) || !NAME_PATTERN.test(lastName.trim()) || (otherName && !NAME_PATTERN.test(otherName.trim()))) {
    return res.status(400).json({ error: 'Names may contain letters, spaces, apostrophes, and hyphens only.' });
  }
  if (phone && !/^\d{7,15}$/.test(phone)) {
    return res.status(400).json({ error: 'Phone number must contain 7 to 15 digits only.' });
  }
  if (!EMAIL_PATTERN.test(email.trim())) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
  }

  const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email.toLowerCase().trim());
  if (existing) {
    return res.status(400).json({ error: 'An account with this email already exists.' });
  }
  const existingMatric = db.prepare(`SELECT user_id FROM student_profiles WHERE matric_number = ?`).get(matricNumber.trim());
  if (existingMatric) {
    return res.status(400).json({ error: 'This Student ID / Matriculation Number is already registered.' });
  }

  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);

  const insertUser = db.prepare(`
    INSERT INTO users (role, email, password_hash, first_name, last_name, other_name, phone, push_enabled, status, email_verified)
    VALUES ('student', ?, ?, ?, ?, ?, ?, ?, 'active', 1)
  `);
  const insertProfile = db.prepare(`
    INSERT INTO student_profiles (user_id, matric_number, faculty_id, department_id, programme_id, level_id, study_mode_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    let resolvedDepartmentId = departmentId ? Number(departmentId) : null;
    if (departmentName) {
      const name = departmentName.trim();
      const existingDepartment = db.prepare(`SELECT id FROM departments WHERE faculty_id = ? AND name = ?`)
        .get(Number(facultyId), name);
      resolvedDepartmentId = existingDepartment
        ? existingDepartment.id
        : db.prepare(`INSERT INTO departments (faculty_id, name) VALUES (?, ?)`)
          .run(Number(facultyId), name).lastInsertRowid;
    }
    const result = insertUser.run(
      email.toLowerCase().trim(), passwordHash, firstName.trim(), lastName.trim(),
      otherName ? otherName.trim() : null, phone || null, enablePush ? 1 : 0
    );
    insertProfile.run(
      result.lastInsertRowid, matricNumber.trim(),
      facultyId || null, resolvedDepartmentId, programmeId || null, levelId || null, studyModeId || null
    );
    return result.lastInsertRowid;
  });

  const userId = tx();

  // Email verification is disabled: new accounts are created already
  // email_verified = 1 and can log in immediately. A welcome email is still
  // sent as a courtesy, but delivery failures never block access.
  emailService.sendWelcomeEmail(email.toLowerCase().trim(), firstName.trim(), `${baseUrl(req)}/login.html`);
  logAction({ actor: null, action: 'student.register', targetType: 'user', targetId: userId, ip: req.ip });

  res.status(201).json({
    message: 'Registration successful. You can now log in.',
  });
}

// ---------------- STAFF REGISTRATION ----------------
function registerStaff(req, res) {
  const {
    firstName, lastName, otherName, staffNumber, staffType, email, phone,
    facultyId, departmentId, departmentName, password, confirmPassword, enablePush,
  } = req.body;

  const isAcademicStaff = staffType !== 'non_academic';
  if (!firstName || !lastName || (isAcademicStaff && (!facultyId || !(departmentName || departmentId))) || !email || !password) {
    return res.status(400).json({ error: 'Please fill in all required fields.' });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
  }

  const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email.toLowerCase().trim());
  if (existing) {
    return res.status(400).json({ error: 'An account with this email already exists.' });
  }

  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);

  const insertUser = db.prepare(`
    INSERT INTO users (role, email, password_hash, first_name, last_name, other_name, phone, push_enabled, status, staff_type, email_verified)
    VALUES ('staff', ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?)
  `);
  const insertProfile = db.prepare(`
    INSERT INTO staff_profiles (user_id, staff_number, faculty_id, department_id)
    VALUES (?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    let resolvedDepartmentId = isAcademicStaff && departmentId ? Number(departmentId) : null;
    if (isAcademicStaff && departmentName) {
      const name = departmentName.trim();
      const existingDepartment = db.prepare(`SELECT id FROM departments WHERE faculty_id = ? AND name = ?`)
        .get(Number(facultyId), name);
      resolvedDepartmentId = existingDepartment
        ? existingDepartment.id
        : db.prepare(`INSERT INTO departments (faculty_id, name) VALUES (?, ?)`)
          .run(Number(facultyId), name).lastInsertRowid;
    }
    const result = insertUser.run(
      email.toLowerCase().trim(), passwordHash, firstName.trim(), lastName.trim(),
      otherName ? otherName.trim() : null, phone || null, enablePush ? 1 : 0,
      staffType === 'non_academic' ? 'non_academic' : 'academic',
      1
    );
    const generatedStaffNumber = staffNumber ? staffNumber.trim() : `STF-${String(result.lastInsertRowid).padStart(6, '0')}`;
    insertProfile.run(result.lastInsertRowid, generatedStaffNumber, isAcademicStaff ? facultyId || null : null, resolvedDepartmentId);
    return result.lastInsertRowid;
  });

  const userId = tx();

  // Email verification is disabled (see registerStudent above): the account
  // is created email_verified = 1 and can log in right away. The welcome
  // email is a courtesy only. Administrator approval for publishing memos
  // remains a separate, unrelated workflow.
  emailService.sendWelcomeEmail(email.toLowerCase().trim(), firstName.trim(), `${baseUrl(req)}/login.html`);
  logAction({ actor: null, action: 'staff.register', targetType: 'user', targetId: userId, ip: req.ip });

  res.status(201).json({
    message: 'Registration successful. You can now log in. Your account will need administrator approval before you can publish memos.',
  });
}

// ---------------- EMAIL VERIFICATION ----------------
function verifyEmail(req, res) {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Missing verification token.' });

  const row = consumeVerificationToken(token);
  if (!row) return res.status(400).json({ error: 'This verification link is invalid or has expired.' });

  db.prepare(`UPDATE users SET email_verified = 1, updated_at = datetime('now') WHERE id = ?`).run(row.user_id);
  logAction({ actor: null, action: 'user.verify_email', targetType: 'user', targetId: row.user_id, ip: req.ip });

  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(row.user_id);
  if (user) {
    emailService.sendWelcomeEmail(user.email, user.first_name, `${baseUrl(req)}/login.html`);
  }

  res.json({ message: 'Email verified successfully. You can now log in.' });
}

// ---------------- RESEND VERIFICATION EMAIL ----------------
function resendVerification(req, res) {
  const { email } = req.body;
  if (!email || !EMAIL_PATTERN.test(email.trim())) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email.toLowerCase().trim());
  // Always return the same generic message whether or not the account
  // exists / is already verified — this avoids leaking which emails are
  // registered on the system.
  const genericMessage = 'If an account with that email exists and is not yet verified, a new verification link has been sent.';

  if (!user || user.email_verified) {
    return res.json({ message: genericMessage });
  }

  const verifyToken = createVerificationToken(user.id);
  const verifyUrl = `${baseUrl(req)}/verify-email.html?token=${verifyToken}`;
  emailService.sendVerificationEmail(user.email, user.first_name, verifyUrl);
  logAction({ actor: null, action: 'user.resend_verification', targetType: 'user', targetId: user.id, ip: req.ip });

  res.json({ message: genericMessage });
}

// ---------------- LOGIN (regular users: students & staff only) ----------------
function login(req, res) {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Please enter your email and password.' });
  }

  const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email.toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }

  // Super Admins have their own separate portal; they can never sign in here.
  if (user.role === 'administrator') {
    return res.status(403).json({ error: 'Super Admin accounts must sign in through the Admin Portal.', adminPortal: true });
  }
  // Email verification is disabled system-wide: accounts can sign in whether
  // or not their email address was ever verified. Suspended/disabled checks
  // below remain the only access controls.
  if (user.status === 'suspended') {
    return res.status(403).json({ error: 'Your account has been suspended. Please contact administration.' });
  }
  if (user.status === 'disabled') {
    return res.status(403).json({ error: 'This account is no longer active.' });
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Could not start a session. Please try again.' });
    req.session.user = publicUser(user);
    logAction({ actor: req.session.user, action: 'user.login', targetType: 'user', targetId: user.id, ip: req.ip });

    const redirectMap = { student: '/dashboard', staff: '/dashboard' };
    res.json({
      message: user.status === 'pending_approval'
        ? 'Login successful. Your staff account is awaiting administrator approval.'
        : 'Login successful.',
      user: req.session.user,
      redirect: redirectMap[user.role],
    });
  });
}

// ---------------- SUPER ADMIN LOGIN (separate portal) ----------------
function adminLogin(req, res) {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Please enter your email and password.' });
  }

  const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email.toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }

  // Only Super Admins may authenticate through this portal.
  if (user.role !== 'administrator') {
    return res.status(403).json({ error: 'This login is for Super Admin accounts only. Please use the regular login.', userPortal: true });
  }
  if (user.status === 'pending_approval') {
    return res.status(403).json({ error: 'Your Super Admin account is awaiting approval.' });
  }
  if (user.status === 'suspended') {
    return res.status(403).json({ error: 'This Super Admin account has been suspended.' });
  }
  if (user.status === 'disabled') {
    return res.status(403).json({ error: 'This Super Admin account is no longer active.' });
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Could not start a session. Please try again.' });
    req.session.user = publicUser(user);
    logAction({ actor: req.session.user, action: 'super_admin.login', targetType: 'user', targetId: user.id, ip: req.ip });
    res.json({ message: 'Super Admin login successful.', user: req.session.user, redirect: '/admin/dashboard' });
  });
}

// ---------------- LOGOUT ----------------
function logout(req, res) {
  const actor = req.session.user;
  req.session.destroy((err) => {
    if (actor) logAction({ actor, action: 'user.logout', targetType: 'user', targetId: actor.id, ip: req.ip });
    res.clearCookie('connect.sid');
    // Send each portal back to its own login page.
    const redirect = actor && actor.role === 'administrator' ? '/admin/login' : '/login';
    res.json({ message: 'You have been logged out.', redirect });
  });
}

// ---------------- FORGOT / RESET PASSWORD ----------------
function forgotPassword(req, res) {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Please enter your email address.' });

  const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email.toLowerCase().trim());
  // Always respond the same way whether or not the account exists (prevents user enumeration).
  const genericResponse = { message: 'If an account exists with that email, a password reset link has been sent.' };

  if (!user) return res.json(genericResponse);

  // A password reset request invalidates any earlier unused reset links for
  // the same account. This keeps a stolen/out-of-sync older link from being
  // usable after the user requested a fresh one.
  db.prepare(`UPDATE password_reset_tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL`).run(user.id);
  const newToken = createPasswordResetToken(user.id);
  const resetUrl = `${baseUrl(req)}/reset-password.html?token=${newToken}`;
  emailService.sendPasswordResetEmail(user.email, user.first_name, resetUrl);
  logAction({ actor: null, action: 'user.forgot_password', targetType: 'user', targetId: user.id, ip: req.ip });

  res.json({ ...genericResponse, devResetUrl: emailService.isConfigured ? undefined : resetUrl });
}

function resetPassword(req, res) {
  const { token, password, confirmPassword } = req.body;
  if (!token || !password || !confirmPassword) {
    return res.status(400).json({ error: 'Please fill in all fields.' });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
  }

  const row = consumePasswordResetToken(token);
  if (!row) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });

  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);
  db.prepare(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`).run(passwordHash, row.user_id);
  logAction({ actor: null, action: 'user.reset_password', targetType: 'user', targetId: row.user_id, ip: req.ip });

  res.json({ message: 'Your password has been reset. You can now log in.' });
}

function me(req, res) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in.' });
  res.json({ user: req.session.user });
}

module.exports = {
  registerStudent, registerStaff, verifyEmail, resendVerification, login, adminLogin, logout,
  forgotPassword, resetPassword, me, publicUser,
};
