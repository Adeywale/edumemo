const path = require('path');
const fs = require('fs');
const db = require('../database/db');
const { logAction } = require('../utils/audit');
const emailService = require('../services/emailService');
const { UPLOAD_DIR } = require('../middleware/upload');

// ---------------- DASHBOARD OVERVIEW ----------------
function overview(req, res) {
  const studentCount = db.prepare(`SELECT COUNT(*) as c FROM users WHERE role = 'student'`).get().c;
  const staffCount = db.prepare(`SELECT COUNT(*) as c FROM users WHERE role = 'staff' AND status != 'pending_approval'`).get().c;
  const pendingApprovals = db.prepare(`SELECT COUNT(*) as c FROM users WHERE role = 'staff' AND status = 'pending_approval'`).get().c;
  const publishedMemos = db.prepare(`SELECT COUNT(*) as c FROM memos WHERE status = 'published'`).get().c;
  const draftMemos = db.prepare(`SELECT COUNT(*) as c FROM memos WHERE status = 'draft'`).get().c;
  const recentMemos = db.prepare(`
    SELECT m.id, m.title, m.status, m.published_at, m.created_at, u.first_name || ' ' || u.last_name as sender_name
    FROM memos m JOIN users u ON u.id = m.sender_id
    ORDER BY m.created_at DESC LIMIT 8
  `).all();

  res.json({ studentCount, staffCount, pendingApprovals, publishedMemos, draftMemos, recentMemos });
}

// ---------------- REPORTS (aggregated analytics for the admin Reports page) ----------------
function reports(req, res) {
  const memoCounts = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END), 0) as published,
      COALESCE(SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END), 0) as drafts,
      COALESCE(SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END), 0) as archived,
      COUNT(*) as total
    FROM memos
  `).get();

  const readStats = db.prepare(`
    SELECT COUNT(*) as delivered, COALESCE(SUM(is_read), 0) as read_count
    FROM memo_recipients
  `).get();

  const byCategory = db.prepare(`
    SELECT COALESCE(mc.name, 'Uncategorised') as name,
           COUNT(m.id) as count,
           COALESCE(SUM(m.estimated_recipient_count), 0) as recipients
    FROM memos m
    LEFT JOIN memo_categories mc ON mc.id = m.category_id
    WHERE m.status = 'published'
    GROUP BY m.category_id
    ORDER BY count DESC, name ASC
  `).all();

  const monthly = db.prepare(`
    SELECT strftime('%Y-%m', m.published_at) as month,
           COUNT(*) as count,
           COALESCE(SUM(m.estimated_recipient_count), 0) as recipients
    FROM memos m
    WHERE m.published_at IS NOT NULL AND m.published_at >= date('now', '-6 months')
    GROUP BY month
    ORDER BY month ASC
  `).all();

  const topSenders = db.prepare(`
    SELECT u.id, u.first_name, u.last_name, u.role,
           COUNT(*) as count,
           COALESCE(SUM(m.estimated_recipient_count), 0) as recipients
    FROM memos m
    JOIN users u ON u.id = m.sender_id
    WHERE m.status = 'published'
    GROUP BY m.sender_id
    ORDER BY count DESC, recipients DESC
    LIMIT 5
  `).all();

  const userStats = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN role = 'student' THEN 1 ELSE 0 END), 0) as students,
      COALESCE(SUM(CASE WHEN role = 'staff' AND staff_type = 'academic' THEN 1 ELSE 0 END), 0) as academicStaff,
      COALESCE(SUM(CASE WHEN role = 'staff' AND staff_type = 'non_academic' THEN 1 ELSE 0 END), 0) as nonAcademicStaff,
      COALESCE(SUM(CASE WHEN role = 'staff' AND status = 'pending_approval' THEN 1 ELSE 0 END), 0) as pendingStaff,
      COALESCE(SUM(CASE WHEN role = 'administrator' THEN 1 ELSE 0 END), 0) as administrators
    FROM users
  `).get();

  // Email delivery visibility: aggregate + recent failures so silent SMTP
  // problems (e.g. invalid app passwords) are never invisible to admins.
  // `skipped` counts attempts that were never actually handed to an SMTP
  // server (SMTP not configured on this deployment). Those must be visible:
  // they used to be recorded as "sent", which made a completely undeliverable
  // configuration look healthy in this report.
  const emailStats = {
    total: db.prepare(`SELECT COUNT(*) as c FROM email_notifications`).get().c,
    sent: db.prepare(`SELECT COUNT(*) as c FROM email_notifications WHERE status = 'sent'`).get().c,
    failed: db.prepare(`SELECT COUNT(*) as c FROM email_notifications WHERE status = 'failed'`).get().c,
    skipped: db.prepare(`SELECT COUNT(*) as c FROM email_notifications WHERE status = 'skipped'`).get().c,
  };
  const recentEmailFailures = db.prepare(`
    SELECT en.id, en.memo_id, en.to_email, en.subject, en.error, en.created_at
    FROM email_notifications en
    WHERE en.status = 'failed'
    ORDER BY en.id DESC
    LIMIT 10
  `).all();

  res.json({ memoCounts, readStats, byCategory, monthly, topSenders, userStats, emailStats, recentEmailFailures, emailConfigured: emailService.isConfigured });
}

// ---------------- USER MANAGEMENT ----------------
function listUsers(req, res) {
  const { role, status, staffType, search } = req.query;
  let where = [];
  let params = {};
  if (role) { where.push(`u.role = @role`); params.role = role; }
  if (status) { where.push(`u.status = @status`); params.status = status; }
  if (staffType) { where.push(`u.staff_type = @staffType`); params.staffType = staffType; }
  if (search) {
    where.push(`(u.first_name LIKE @s OR u.last_name LIKE @s OR u.email LIKE @s OR sp.matric_number LIKE @s OR stp.staff_number LIKE @s)`);
    params.s = `%${search}%`;
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT u.id, u.role, u.email, u.first_name, u.last_name, u.status, u.staff_type, u.email_verified, u.created_at,
           sp.matric_number, stp.staff_number,
           (SELECT COUNT(*) FROM memos m WHERE m.sender_id = u.id) AS memo_count
    FROM users u
    LEFT JOIN student_profiles sp ON sp.user_id = u.id
    LEFT JOIN staff_profiles stp ON stp.user_id = u.id
    ${whereClause}
    ORDER BY u.created_at DESC
    LIMIT 200
  `).all(params);
  res.json(rows);
}

// Full registration details for one student/staff account (admin "Details" view).
function getUserDetails(req, res) {
  const userId = Number(req.params.id);
  const row = db.prepare(`
    SELECT u.id, u.role, u.email, u.first_name, u.last_name, u.other_name, u.phone,
           u.status, u.staff_type, u.email_verified, u.created_at,
           (SELECT COUNT(*) FROM memos m WHERE m.sender_id = u.id) AS memo_count,
           sp.matric_number,
           f.name AS faculty_name, d.name AS department_name,
           p.name AS programme_name, l.name AS level_name, sm.name AS study_mode_name,
           stp.staff_number,
           f2.name AS staff_faculty_name, d2.name AS staff_department_name
    FROM users u
    LEFT JOIN student_profiles sp ON sp.user_id = u.id
    LEFT JOIN staff_profiles stp ON stp.user_id = u.id
    LEFT JOIN faculties f ON f.id = sp.faculty_id
    LEFT JOIN departments d ON d.id = sp.department_id
    LEFT JOIN programmes p ON p.id = sp.programme_id
    LEFT JOIN levels l ON l.id = sp.level_id
    LEFT JOIN study_modes sm ON sm.id = sp.study_mode_id
    LEFT JOIN faculties f2 ON f2.id = stp.faculty_id
    LEFT JOIN departments d2 ON d2.id = stp.department_id
    WHERE u.id = ? AND u.role IN ('student', 'staff')
  `).get(userId);

  if (!row) return res.status(404).json({ error: 'User account not found.' });
  res.json(row);
}

function approveStaff(req, res) {
  const staffId = Number(req.params.id);
  const staff = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'staff'`).get(staffId);
  if (!staff) return res.status(404).json({ error: 'Staff account not found.' });

  db.prepare(`UPDATE users SET status = 'active', updated_at = datetime('now') WHERE id = ?`).run(staffId);
  logAction({ actor: req.session.user, action: 'staff.approve', targetType: 'user', targetId: staffId, ip: req.ip });
  emailService.sendStaffApprovalEmail(staff.email, staff.first_name, true);
  res.json({ message: 'Staff account approved.' });
}

function suspendStaff(req, res) {
  const staffId = Number(req.params.id);
  const staff = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'staff'`).get(staffId);
  if (!staff) return res.status(404).json({ error: 'Staff account not found.' });

  db.prepare(`UPDATE users SET status = 'suspended', updated_at = datetime('now') WHERE id = ?`).run(staffId);
  logAction({ actor: req.session.user, action: 'staff.suspend', targetType: 'user', targetId: staffId, ip: req.ip });
  emailService.sendStaffApprovalEmail(staff.email, staff.first_name, false);
  res.json({ message: 'Staff account suspended.' });
}

function reactivateStaff(req, res) {
  const staffId = Number(req.params.id);
  const staff = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'staff'`).get(staffId);
  if (!staff) return res.status(404).json({ error: 'Staff account not found.' });
  db.prepare(`UPDATE users SET status = 'active', updated_at = datetime('now') WHERE id = ?`).run(staffId);
  logAction({ actor: req.session.user, action: 'staff.reactivate', targetType: 'user', targetId: staffId, ip: req.ip });
  res.json({ message: 'Staff account reactivated.' });
}

function toggleStaffBroadcastPermission(req, res) {
  const staffId = Number(req.params.id);
  const { canBroadcast } = req.body;
  const staff = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'staff'`).get(staffId);
  if (!staff) return res.status(404).json({ error: 'Staff account not found.' });
  db.prepare(`UPDATE users SET can_broadcast_institution = ?, updated_at = datetime('now') WHERE id = ?`).run(canBroadcast ? 1 : 0, staffId);
  logAction({ actor: req.session.user, action: 'staff.toggle_broadcast_permission', targetType: 'user', targetId: staffId, details: { canBroadcast: !!canBroadcast }, ip: req.ip });
  res.json({ message: 'Permission updated.' });
}

function updateStaffType(req, res) {
  const staffId = Number(req.params.id);
  const { staffType } = req.body;
  if (!['academic', 'non_academic'].includes(staffType)) return res.status(400).json({ error: 'Choose academic or non-academic staff.' });
  const staff = db.prepare(`SELECT id FROM users WHERE id = ? AND role = 'staff'`).get(staffId);
  if (!staff) return res.status(404).json({ error: 'Staff account not found.' });
  db.prepare(`UPDATE users SET staff_type = ?, updated_at = datetime('now') WHERE id = ?`).run(staffType, staffId);
  logAction({ actor: req.session.user, action: 'staff.update_type', targetType: 'user', targetId: staffId, details: { staffType }, ip: req.ip });
  res.json({ message: 'Staff type updated.' });
}

function suspendStudent(req, res) {
  const id = Number(req.params.id);
  const student = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'student'`).get(id);
  if (!student) return res.status(404).json({ error: 'Student account not found.' });
  db.prepare(`UPDATE users SET status = 'suspended', updated_at = datetime('now') WHERE id = ?`).run(id);
  logAction({ actor: req.session.user, action: 'student.suspend', targetType: 'user', targetId: id, ip: req.ip });
  res.json({ message: 'Student account suspended.' });
}

function reactivateStudent(req, res) {
  const id = Number(req.params.id);
  const student = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'student'`).get(id);
  if (!student) return res.status(404).json({ error: 'Student account not found.' });
  db.prepare(`UPDATE users SET status = 'active', updated_at = datetime('now') WHERE id = ?`).run(id);
  logAction({ actor: req.session.user, action: 'student.reactivate', targetType: 'user', targetId: id, ip: req.ip });
  res.json({ message: 'Student account reactivated.' });
}

// ---------------- DELETE ACCOUNT (student or staff, permanent) ----------------
// Removes the account and every row that belongs to it. Administrators are
// never deletable through this endpoint, so a Super Admin cannot wipe a peer
// account (or its own) either by mistake or through a crafted request.
//
// Child rows are deleted explicitly inside one transaction rather than relying
// on ON DELETE CASCADE -- the sql.js runtime does not reliably enforce foreign
// keys, and orphaned rows would leave the account visible in other users'
// inboxes, reports and notification counts (the same reasoning memoController
// documents for permanent memo deletion).
function deleteUser(req, res) {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'Invalid account reference.' });
  }

  const user = db.prepare(`SELECT id, role, email, first_name, last_name, status FROM users WHERE id = ?`).get(userId);
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  if (!['student', 'staff'].includes(user.role)) {
    return res.status(403).json({ error: 'Only student and staff accounts can be deleted.' });
  }

  // Attachments are files on disk, so record their names before the rows that
  // reference them are gone and unlink them once the transaction has committed.
  const attachments = db.prepare(`
    SELECT ma.stored_filename FROM memo_attachments ma
    JOIN memos m ON m.id = ma.memo_id
    WHERE m.sender_id = ?
  `).all(userId);
  const memoCount = db.prepare(`SELECT COUNT(*) as c FROM memos WHERE sender_id = ?`).get(userId).c;

  // The sessions table stores each session as a JSON blob with no user_id
  // column, so rows are matched by reading the stored user id. This signs the
  // deleted account out on every device immediately instead of leaving a live
  // session pointing at a user that no longer exists.
  const sessionIds = db.prepare(`SELECT sid, data FROM sessions`).all().reduce((ids, row) => {
    try {
      const parsed = JSON.parse(row.data);
      if (parsed && parsed.user && Number(parsed.user.id) === userId) ids.push(row.sid);
    } catch (_) { /* malformed session payload -- nothing to match */ }
    return ids;
  }, []);

  db.transaction(() => {
    // 1. Everything hanging off memos this account sent (staff accounts only).
    db.prepare(`DELETE FROM notifications WHERE memo_id IN (SELECT id FROM memos WHERE sender_id = ?)`).run(userId);
    db.prepare(`DELETE FROM email_notifications WHERE memo_id IN (SELECT id FROM memos WHERE sender_id = ?)`).run(userId);
    db.prepare(`DELETE FROM memo_recipients WHERE memo_id IN (SELECT id FROM memos WHERE sender_id = ?)`).run(userId);
    db.prepare(`DELETE FROM memo_target_rules WHERE memo_id IN (SELECT id FROM memos WHERE sender_id = ?)`).run(userId);
    db.prepare(`DELETE FROM memo_attachments WHERE memo_id IN (SELECT id FROM memos WHERE sender_id = ?)`).run(userId);
    db.prepare(`DELETE FROM memos WHERE sender_id = ?`).run(userId);

    // 2. Rows addressed to the account itself: inbox, notifications, devices, tokens.
    db.prepare(`DELETE FROM memo_recipients WHERE user_id = ?`).run(userId);
    db.prepare(`DELETE FROM notifications WHERE user_id = ?`).run(userId);
    db.prepare(`DELETE FROM email_notifications WHERE user_id = ?`).run(userId);
    db.prepare(`DELETE FROM push_subscriptions WHERE user_id = ?`).run(userId);
    db.prepare(`DELETE FROM verification_tokens WHERE user_id = ?`).run(userId);
    db.prepare(`DELETE FROM password_reset_tokens WHERE user_id = ?`).run(userId);

    // 3. Registration profile and course registrations.
    db.prepare(`DELETE FROM student_courses WHERE student_id = ?`).run(userId);
    db.prepare(`DELETE FROM staff_courses WHERE staff_id = ?`).run(userId);
    db.prepare(`DELETE FROM student_profiles WHERE user_id = ?`).run(userId);
    db.prepare(`DELETE FROM staff_profiles WHERE user_id = ?`).run(userId);

    // 4. The audit trail is history, not account data: keep the rows, drop the
    //    reference to the account that no longer exists.
    db.prepare(`UPDATE audit_logs SET actor_id = NULL WHERE actor_id = ?`).run(userId);

    // 5. End every live session, then the account row itself.
    for (const sid of sessionIds) db.prepare(`DELETE FROM sessions WHERE sid = ?`).run(sid);
    db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
  })();

  for (const attachment of attachments) {
    const p = path.join(UPLOAD_DIR, attachment.stored_filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  logAction({
    actor: req.session.user,
    action: `${user.role}.delete`,
    targetType: 'user',
    targetId: userId,
    details: {
      email: user.email,
      name: `${user.first_name} ${user.last_name}`.trim(),
      status: user.status,
      memosDeleted: memoCount,
    },
    ip: req.ip,
  });

  res.json({
    message: user.role === 'student' ? 'Student account deleted permanently.' : 'Staff account deleted permanently.',
    memosDeleted: memoCount,
  });
}

// ---------------- MEMO RECORDS (full history, staff cannot delete) ----------------
function memoRecords(req, res) {
  // Delegates to the same rich query used by memoController.listMemos for the
  // 'administrator' role -- kept accessible here too under /admin/memo-records.
  req.query = req.query || {};
  require('./memoController').listMemos(req, res);
}

// ---------------- AUDIT LOG ----------------
function listAuditLogs(req, res) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = 40;
  const offset = (page - 1) * pageSize;
  let where = [];
  let params = {};
  if (req.query.action) { where.push(`a.action LIKE @action`); params.action = `%${req.query.action}%`; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT a.*, u.first_name || ' ' || u.last_name as actor_name
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.actor_id
    ${whereClause}
    ORDER BY a.created_at DESC
    LIMIT @pageSize OFFSET @offset
  `).all({ ...params, pageSize, offset });

  const total = db.prepare(`SELECT COUNT(*) as c FROM audit_logs a ${whereClause}`).get(params).c;
  res.json({ logs: rows, total, page, pageSize });
}

// ---------------- SYSTEM SETTINGS ----------------
function getSettings(req, res) {
  const rows = db.prepare(`SELECT key, value FROM system_settings`).all();
  const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
  res.json({
    settings,
    emailConfigured: emailService.isConfigured,
    institutionName: process.env.INSTITUTION_NAME || 'EduMemo',
  });
}

function updateSettings(req, res) {
  const updates = req.body || {};
  const upsert = db.prepare(`
    INSERT INTO system_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(updates)) {
      upsert.run(key, String(value));
    }
  });
  tx();
  logAction({ actor: req.session.user, action: 'system_settings.update', details: updates, ip: req.ip });
  res.json({ message: 'Settings updated.' });
}

module.exports = {
  overview, reports, listUsers, getUserDetails, approveStaff, suspendStaff, reactivateStaff, toggleStaffBroadcastPermission, updateStaffType,
  suspendStudent, reactivateStudent, deleteUser,
  memoRecords, listAuditLogs, getSettings, updateSettings,
};
