const bcrypt = require('bcryptjs');
const db = require('../database/db');
const { logAction } = require('../utils/audit');
const { publicUser } = require('./authController');
const pushService = require('../services/pushService');

function getProfile(req, res) {
  const user = req.session.user;
  const dbUser = db.prepare(`SELECT * FROM users WHERE id = ?`).get(user.id);
  let profile = null;
  if (user.role === 'student') {
    profile = db.prepare(`
      SELECT sp.*, f.name as faculty_name, d.name as department_name, p.name as programme_name,
             l.name as level_name, sm.name as study_mode_name
      FROM student_profiles sp
      LEFT JOIN faculties f ON f.id = sp.faculty_id
      LEFT JOIN departments d ON d.id = sp.department_id
      LEFT JOIN programmes p ON p.id = sp.programme_id
      LEFT JOIN levels l ON l.id = sp.level_id
      LEFT JOIN study_modes sm ON sm.id = sp.study_mode_id
      WHERE sp.user_id = ?
    `).get(user.id);
  } else if (user.role === 'staff') {
    profile = db.prepare(`
      SELECT stp.*, f.name as faculty_name, d.name as department_name
      FROM staff_profiles stp
      LEFT JOIN faculties f ON f.id = stp.faculty_id
      LEFT JOIN departments d ON d.id = stp.department_id
      WHERE stp.user_id = ?
    `).get(user.id);
  }

  res.json({
    account: {
      id: dbUser.id, email: dbUser.email, firstName: dbUser.first_name, lastName: dbUser.last_name,
      otherName: dbUser.other_name, phone: dbUser.phone, role: dbUser.role, status: dbUser.status,
      pushEnabled: !!dbUser.push_enabled, emailNotificationsEnabled: !!dbUser.email_notifications_enabled,
      // Real device state on this server: whether at least one browser has
      // completed a PushManager subscription for this account, and whether
      // the administrator has configured VAPID keys server-side.
      pushSubscribed: pushService.countSubscriptionsForUser(dbUser.id) > 0,
      pushConfigured: pushService.isConfigured,
    },
    profile,
  });
}

function updateProfile(req, res) {
  const user = req.session.user;
  const { firstName, lastName, otherName, phone } = req.body;
  if (!firstName || !lastName) return res.status(400).json({ error: 'First and last name are required.' });

  db.prepare(`
    UPDATE users SET first_name = ?, last_name = ?, other_name = ?, phone = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(firstName.trim(), lastName.trim(), otherName ? otherName.trim() : null, phone || null, user.id);

  req.session.user.firstName = firstName.trim();
  req.session.user.lastName = lastName.trim();

  logAction({ actor: user, action: 'user.update_profile', targetType: 'user', targetId: user.id, ip: req.ip });
  res.json({ message: 'Profile updated successfully.', user: req.session.user });
}

function changePassword(req, res) {
  const user = req.session.user;
  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ error: 'Please fill in all fields.' });
  }
  if (newPassword !== confirmPassword) return res.status(400).json({ error: 'New passwords do not match.' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters long.' });

  const dbUser = db.prepare(`SELECT * FROM users WHERE id = ?`).get(user.id);
  if (!bcrypt.compareSync(currentPassword, dbUser.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }

  const passwordHash = bcrypt.hashSync(newPassword, 12);
  db.prepare(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`).run(passwordHash, user.id);
  logAction({ actor: user, action: 'user.change_password', targetType: 'user', targetId: user.id, ip: req.ip });
  res.json({ message: 'Password changed successfully.' });
}

function updateNotificationPreferences(req, res) {
  const user = req.session.user;
  const { pushEnabled } = req.body;
  // Memo emails are always delivered to registered users immediately, so the
  // preference only controls web push notifications.
  db.prepare(`UPDATE users SET push_enabled = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(pushEnabled ? 1 : 0, user.id);
  logAction({ actor: user, action: 'user.update_notification_prefs', targetType: 'user', targetId: user.id, ip: req.ip });
  res.json({ message: 'Notification preferences updated.' });
}

module.exports = { getProfile, updateProfile, changePassword, updateNotificationPreferences };
