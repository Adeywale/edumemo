const path = require('path');
const fs = require('fs');
const db = require('../database/db');
const { logAction } = require('../utils/audit');
const targetingService = require('../services/targetingService');
const notificationService = require('../services/notificationService');
const { UPLOAD_DIR } = require('../middleware/upload');

function parseTargetRule(body) {
  const recipientGroup = body.recipientGroup || 'students';
  let recipientUserIds = [];
  try { recipientUserIds = Array.isArray(body.recipientUserIds) ? body.recipientUserIds : JSON.parse(body.recipientUserIds || '[]'); } catch (_) { recipientUserIds = []; }
  return {
    faculty_id: body.facultyId ? Number(body.facultyId) : null,
    department_id: body.departmentId ? Number(body.departmentId) : null,
    programme_id: body.programmeId ? Number(body.programmeId) : null,
    level_id: body.levelId ? Number(body.levelId) : null,
    study_mode_id: body.studyModeId ? Number(body.studyModeId) : null,
    course_id: body.courseId ? Number(body.courseId) : null,
    recipient_group: recipientGroup,
    recipient_user_ids: JSON.stringify([...new Set(recipientUserIds.map(Number).filter(Number.isInteger))]),
  };
}

function isEmptyRule(rule) {
  return !rule.recipient_group || (rule.recipient_group === 'students' && !rule.faculty_id && !rule.department_id && !rule.programme_id && !rule.level_id && !rule.study_mode_id && !rule.course_id);
}

// ---------------- ESTIMATE RECIPIENTS (for the live preview counter) ----------------
function estimateRecipients(req, res) {
  const isInstitutionWide = req.query.institutionWide === 'true';
  if (isInstitutionWide && req.session.user.role !== 'administrator') {
    return res.status(403).json({ error: 'Only administrators can broadcast to the entire institution.' });
  }
  const rule = parseTargetRule(req.query);
  if (!isInstitutionWide && isEmptyRule(rule)) {
    return res.json({ count: 0 });
  }
  const count = targetingService.estimateRecipientCount(rule, isInstitutionWide);
  res.json({ count });
}

// ---------------- CREATE (as draft) ----------------
function createMemo(req, res) {
  const user = req.session.user;
  const { title, body, categoryId, institutionWide } = req.body;

  if (!title || !title.trim() || !body || !body.trim()) {
    return res.status(400).json({ error: 'Memo title and body are required.' });
  }
  if (user.role === 'staff' && user.staffType !== 'academic') {
    return res.status(403).json({ error: 'Non-teaching staff can receive and read memos but cannot create or send them.' });
  }

  const isInstitutionWide = institutionWide === 'true' || institutionWide === true;
  if (isInstitutionWide && user.role !== 'administrator') {
    return res.status(403).json({ error: 'Only administrators can broadcast to the entire institution.' });
  }

  const rule = parseTargetRule(req.body);
  if (user.role === 'staff' && rule.recipient_group !== 'students') return res.status(403).json({ error: 'Staff may send memos to students only.' });
  if (!isInstitutionWide && isEmptyRule(rule)) {
    return res.status(400).json({ error: 'Please select at least one target audience filter.' });
  }

  const senderRole = user.role === 'administrator' ? 'administrator' : 'staff';

  const tx = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO memos (sender_id, sender_role, title, category_id, body, status, is_institution_wide)
      VALUES (?, ?, ?, ?, ?, 'draft', ?)
    `).run(user.id, senderRole, title.trim(), categoryId || null, body.trim(), isInstitutionWide ? 1 : 0);

    const memoId = result.lastInsertRowid;

    db.prepare(`
      INSERT INTO memo_target_rules (memo_id, faculty_id, department_id, programme_id, level_id, study_mode_id, course_id, recipient_group, recipient_user_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(memoId, rule.faculty_id, rule.department_id, rule.programme_id, rule.level_id, rule.study_mode_id, rule.course_id, rule.recipient_group, rule.recipient_user_ids);

    for (const file of req.files || []) {
      db.prepare(`
        INSERT INTO memo_attachments (memo_id, original_filename, stored_filename, mime_type, size_bytes)
        VALUES (?, ?, ?, ?, ?)
      `).run(memoId, file.originalname, file.filename, file.mimetype, file.size);
    }

    const count = targetingService.estimateRecipientCount(rule, isInstitutionWide);
    db.prepare(`UPDATE memos SET estimated_recipient_count = ? WHERE id = ?`).run(count, memoId);

    return memoId;
  });

  const memoId = tx();
  logAction({ actor: user, action: 'memo.create_draft', targetType: 'memo', targetId: memoId, ip: req.ip });

  res.status(201).json({ message: 'Draft saved successfully.', memoId });
}

// ---------------- EDIT DRAFT ----------------
function updateMemo(req, res) {
  const user = req.session.user;
  const memoId = Number(req.params.id);
  const memo = db.prepare(`SELECT * FROM memos WHERE id = ?`).get(memoId);

  if (user.role === 'staff' && user.staffType !== 'academic') {
    return res.status(403).json({ error: 'Non-teaching staff can receive and read memos but cannot create, edit, or send them.' });
  }
  if (!memo) return res.status(404).json({ error: 'Memo not found.' });
  if (memo.sender_id !== user.id && user.role !== 'administrator') {
    return res.status(403).json({ error: 'You do not have permission to edit this memo.' });
  }
  if (memo.status !== 'draft') {
    return res.status(400).json({ error: 'Only draft memos can be edited.' });
  }

  const { title, body, categoryId, institutionWide } = req.body;
  const isInstitutionWide = institutionWide === 'true' || institutionWide === true;
  if (isInstitutionWide && user.role !== 'administrator') {
    return res.status(403).json({ error: 'Only administrators can broadcast to the entire institution.' });
  }

  const rule = parseTargetRule(req.body);
  if (user.role === 'staff' && rule.recipient_group !== 'students') return res.status(403).json({ error: 'Staff may send memos to students only.' });
  if (!isInstitutionWide && isEmptyRule(rule)) {
    return res.status(400).json({ error: 'Please select at least one target audience filter.' });
  }

  const count = targetingService.estimateRecipientCount(rule, isInstitutionWide);

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE memos SET title = ?, body = ?, category_id = ?, is_institution_wide = ?, estimated_recipient_count = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(title.trim(), body.trim(), categoryId || null, isInstitutionWide ? 1 : 0, count, memoId);

    db.prepare(`
      UPDATE memo_target_rules SET faculty_id=?, department_id=?, programme_id=?, level_id=?, study_mode_id=?, course_id=?, recipient_group=?, recipient_user_ids=?
      WHERE memo_id = ?
    `).run(rule.faculty_id, rule.department_id, rule.programme_id, rule.level_id, rule.study_mode_id, rule.course_id, rule.recipient_group, rule.recipient_user_ids, memoId);

    for (const file of req.files || []) {
      db.prepare(`
        INSERT INTO memo_attachments (memo_id, original_filename, stored_filename, mime_type, size_bytes)
        VALUES (?, ?, ?, ?, ?)
      `).run(memoId, file.originalname, file.filename, file.mimetype, file.size);
    }
  });
  tx();

  logAction({ actor: user, action: 'memo.update_draft', targetType: 'memo', targetId: memoId, ip: req.ip });
  res.json({ message: 'Draft updated successfully.' });
}

// ---------------- PUBLISH ----------------
async function publishMemo(req, res) {
  const user = req.session.user;
  const memoId = Number(req.params.id);
  const memo = db.prepare(`SELECT * FROM memos WHERE id = ?`).get(memoId);

  if (!memo) return res.status(404).json({ error: 'Memo not found.' });
  if (memo.sender_id !== user.id && user.role !== 'administrator') {
    return res.status(403).json({ error: 'You do not have permission to publish this memo.' });
  }
  if (memo.status !== 'draft') {
    return res.status(400).json({ error: 'This memo has already been published or archived.' });
  }
  if (memo.is_institution_wide && user.role !== 'administrator') {
    return res.status(403).json({ error: 'Only administrators can broadcast to the entire institution.' });
  }
  if (user.role === 'staff' && (user.status !== 'active' || user.staffType !== 'academic')) {
    return res.status(403).json({ error: 'Your staff account must be approved before you can publish memos.' });
  }
  if (memo.is_institution_wide && req.body.confirmBroadcast !== true && req.body.confirmBroadcast !== 'true') {
    return res.status(400).json({ error: 'Institution-wide broadcasts require explicit confirmation.' });
  }

  const rule = db.prepare(`SELECT * FROM memo_target_rules WHERE memo_id = ?`).get(memoId);
  const recipientIds = targetingService.resolveRecipientIds(rule, !!memo.is_institution_wide);

  if (recipientIds.length === 0) {
    return res.status(400).json({ error: 'No recipients were found for the selected target audience. Adjust your filters before publishing.' });
  }

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE memos SET status = 'published', published_at = datetime('now'), estimated_recipient_count = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(recipientIds.length, memoId);

    const insertRecipient = db.prepare(`INSERT OR IGNORE INTO memo_recipients (memo_id, user_id) VALUES (?, ?)`);
    for (const uid of recipientIds) insertRecipient.run(memoId, uid);
  });
  tx();

  logAction({
    actor: user,
    action: memo.is_institution_wide ? 'memo.publish_institution_wide' : 'memo.publish',
    targetType: 'memo', targetId: memoId,
    details: { recipientCount: recipientIds.length },
    ip: req.ip,
  });

  // Respond to the admin as soon as the memo itself is published and
  // recipients are recorded -- this is what makes the Publish button
  // return in one click instead of hanging until every email is sent.
  // Emails/push notifications go out immediately afterward, in the
  // background, in parallel batches (see notificationService), so
  // delivery is still fast; the admin just doesn't have to sit and wait
  // for it before getting confirmation that the memo was sent.
  res.json({ message: 'Memo published successfully.', recipientCount: recipientIds.length });

  const sender = db.prepare(`SELECT first_name, last_name FROM users WHERE id = ?`).get(memo.sender_id);
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  notificationService.notifyMemoRecipients(
    { ...memo, senderName: `${sender.first_name} ${sender.last_name}` }, baseUrl
  ).then((stats) => {
    const parts = [
      `${stats.emailSentCount}/${stats.recipientCount} emails sent`,
      `${stats.pushSentCount} push sent`,
    ];
    if (stats.emailSkippedCount) parts.push(`${stats.emailSkippedCount} email(s) SKIPPED (SMTP not configured)`);
    if (stats.emailFailedCount) parts.push(`${stats.emailFailedCount} email(s) FAILED`);
    console.log(`Memo #${memoId} notifications complete: ${parts.join(', ')}.`);
    if (stats.deliveryErrors.length) {
      console.error(`Memo #${memoId} delivery problems:\n  - ${stats.deliveryErrors.slice(0, 10).join('\n  - ')}`);
    }
  }).catch((err) => {
    console.error(`Memo #${memoId} notification delivery failed:`, err);
  });
}

// ---------------- ARCHIVE (never hard-delete published memos) ----------------
function archiveMemo(req, res) {
  const user = req.session.user;
  const memoId = Number(req.params.id);
  const memo = db.prepare(`SELECT * FROM memos WHERE id = ?`).get(memoId);

  if (user.role === 'staff' && user.staffType !== 'academic') {
    return res.status(403).json({ error: 'Non-teaching staff can view received memos only.' });
  }
  if (!memo) return res.status(404).json({ error: 'Memo not found.' });
  if (memo.sender_id !== user.id && user.role !== 'administrator') {
    return res.status(403).json({ error: 'You do not have permission to archive this memo.' });
  }
  if (memo.status === 'archived') return res.status(400).json({ error: 'This memo is already archived.' });

  db.prepare(`UPDATE memos SET status = 'archived', archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(memoId);
  logAction({ actor: user, action: 'memo.archive', targetType: 'memo', targetId: memoId, ip: req.ip });
  res.json({ message: 'Memo archived.' });
}

// ---------------- DELETE (drafts, published and archived memos) ----------------
// Drafts follow the original delete rules. Published/archived memos are
// permanently removed: administrators may delete any memo, academic staff
// only their own. Child rows (memo_recipients, memo_target_rules,
// memo_attachments, notifications, email_notifications) are deleted
// explicitly inside a transaction, so the memo disappears from every
// recipient's inbox and notification history as well.
function deleteMemo(req, res) {
  const user = req.session.user;
  const memoId = Number(req.params.id);
  const memo = db.prepare(`SELECT * FROM memos WHERE id = ?`).get(memoId);

  if (user.role === 'staff' && user.staffType !== 'academic') {
    return res.status(403).json({ error: 'Non-teaching staff can view received memos only.' });
  }
  if (!memo) return res.status(404).json({ error: 'Memo not found.' });
  const isOwner = memo.sender_id === user.id;
  if (!isOwner && user.role !== 'administrator') {
    return res.status(403).json({ error: 'You do not have permission to delete this memo.' });
  }

  if (memo.status === 'draft') {
    const attachments = db.prepare(`SELECT stored_filename FROM memo_attachments WHERE memo_id = ?`).all(memoId);
    db.transaction(() => {
      db.prepare(`DELETE FROM memo_attachments WHERE memo_id = ?`).run(memoId);
      db.prepare(`DELETE FROM memo_target_rules WHERE memo_id = ?`).run(memoId);
      db.prepare(`DELETE FROM memos WHERE id = ?`).run(memoId);
    })();
    for (const attachment of attachments) {
      const p = path.join(UPLOAD_DIR, attachment.stored_filename);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    logAction({ actor: user, action: 'memo.delete_draft', targetType: 'memo', targetId: memoId, ip: req.ip });
    return res.json({ message: 'Draft deleted.' });
  }

  // Published / archived: permanent deletion from the sender side.
  // NOTE: child rows are deleted explicitly (in a transaction) rather than
  // relying on ON DELETE CASCADE -- the sql.js runtime does not reliably
  // enforce foreign-key cascades, and orphaned rows would keep the memo
  // visible in recipients' inboxes, reports and notification counts.
  const attachments = db.prepare(`SELECT stored_filename FROM memo_attachments WHERE memo_id = ?`).all(memoId);
  db.transaction(() => {
    db.prepare(`DELETE FROM notifications WHERE memo_id = ?`).run(memoId);
    db.prepare(`DELETE FROM email_notifications WHERE memo_id = ?`).run(memoId);
    db.prepare(`DELETE FROM memo_recipients WHERE memo_id = ?`).run(memoId);
    db.prepare(`DELETE FROM memo_target_rules WHERE memo_id = ?`).run(memoId);
    db.prepare(`DELETE FROM memo_attachments WHERE memo_id = ?`).run(memoId);
    db.prepare(`DELETE FROM memos WHERE id = ?`).run(memoId);
  })();
  for (const attachment of attachments) {
    const p = path.join(UPLOAD_DIR, attachment.stored_filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  logAction({
    actor: user,
    action: 'memo.delete_published',
    targetType: 'memo', targetId: memoId,
    details: { title: memo.title, recipientCount: memo.estimated_recipient_count },
    ip: req.ip,
  });
  res.json({ message: 'Memo permanently deleted.' });
}

// ---------------- RESEND (re-send notifications for a sent memo) ----------------
// Re-runs notification delivery (email + web push) to every recorded
// recipient of a published/archived memo. In-app notifications are NOT
// duplicated -- recipients already have the memo in their inbox. Like
// publish, the response returns immediately while delivery runs in the
// background in parallel batches.
function resendMemo(req, res) {
  const user = req.session.user;
  const memoId = Number(req.params.id);
  const memo = db.prepare(`SELECT * FROM memos WHERE id = ?`).get(memoId);

  if (user.role === 'staff' && user.staffType !== 'academic') {
    return res.status(403).json({ error: 'Non-teaching staff can view received memos only.' });
  }
  if (!memo) return res.status(404).json({ error: 'Memo not found.' });
  const isOwner = memo.sender_id === user.id;
  if (!isOwner && user.role !== 'administrator') {
    return res.status(403).json({ error: 'You do not have permission to resend this memo.' });
  }
  if (memo.status === 'draft') {
    return res.status(400).json({ error: 'Draft memos have not been sent yet. Publish the memo first.' });
  }

  const recipientCount = db.prepare(`SELECT COUNT(*) AS n FROM memo_recipients WHERE memo_id = ?`).get(memoId).n;
  if (recipientCount === 0) {
    return res.status(400).json({ error: 'This memo has no recipients to resend to.' });
  }

  logAction({
    actor: user,
    action: 'memo.resend',
    targetType: 'memo', targetId: memoId,
    details: { title: memo.title, recipientCount },
    ip: req.ip,
  });

  // Respond immediately; emails/push go out in the background (see publish).
  res.json({ message: `Resending to ${recipientCount} recipient(s).`, recipientCount });

  const sender = db.prepare(`SELECT first_name, last_name FROM users WHERE id = ?`).get(memo.sender_id);
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  notificationService.notifyMemoRecipients(
    { ...memo, senderName: `${sender.first_name} ${sender.last_name}` },
    baseUrl,
    { skipInApp: true }
  ).then((stats) => {
    const parts = [
      `${stats.emailSentCount}/${stats.recipientCount} emails sent`,
      `${stats.pushSentCount} push sent`,
    ];
    if (stats.emailSkippedCount) parts.push(`${stats.emailSkippedCount} email(s) SKIPPED (SMTP not configured)`);
    if (stats.emailFailedCount) parts.push(`${stats.emailFailedCount} email(s) FAILED`);
    console.log(`Memo #${memoId} resend complete: ${parts.join(', ')}.`);
    if (stats.deliveryErrors.length) {
      console.error(`Memo #${memoId} resend delivery problems:\n  - ${stats.deliveryErrors.slice(0, 10).join('\n  - ')}`);
    }
  }).catch((err) => {
    console.error(`Memo #${memoId} resend delivery failed:`, err);
  });
}

// ---------------- LIST (role-aware) ----------------
function listMemos(req, res) {
  const user = req.session.user;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = 20;
  const offset = (page - 1) * pageSize;
  const search = (req.query.search || '').trim();

  let where = [];
  let params = {};

  if (user.role === 'student') {
    where.push(`mr.user_id = @userId`);
    params.userId = user.id;
    if (req.query.filter === 'unread') where.push(`mr.is_read = 0`);
    if (req.query.filter === 'read') where.push(`mr.is_read = 1`);
    if (req.query.category) { where.push(`m.category_id = @categoryId`); params.categoryId = req.query.category; }

    if (search) { where.push(`(m.title LIKE @search OR m.body LIKE @search)`); params.search = `%${search}%`; }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT m.id, m.title, m.category_id, mc.name as category_name, m.published_at,
             u.first_name || ' ' || u.last_name as sender_name,
             mr.is_read, (SELECT COUNT(*) FROM memo_attachments a WHERE a.memo_id = m.id) as has_attachment
      FROM memo_recipients mr
      JOIN memos m ON m.id = mr.memo_id
      JOIN users u ON u.id = m.sender_id
      LEFT JOIN memo_categories mc ON mc.id = m.category_id
      ${whereClause}
      ORDER BY m.published_at DESC
      LIMIT @pageSize OFFSET @offset
    `).all({ ...params, pageSize, offset });

    const totalRow = db.prepare(`
      SELECT COUNT(*) as count FROM memo_recipients mr JOIN memos m ON m.id = mr.memo_id ${whereClause}
    `).get(params);

    return res.json({ memos: rows, total: totalRow.count, page, pageSize });
  }

  if (user.role === 'staff') {
    if (user.staffType === 'non_academic' && req.query.filter !== 'received') {
      return res.status(403).json({ error: 'Non-teaching staff can view received memos only.' });
    }
    if (req.query.filter === 'received') {
      const rows = db.prepare(`
        SELECT m.id, m.title, m.published_at, mc.name as category_name,
               u.first_name || ' ' || u.last_name as sender_name, mr.is_read,
               (SELECT COUNT(*) FROM memo_attachments a WHERE a.memo_id = m.id) as has_attachment
        FROM memo_recipients mr JOIN memos m ON m.id = mr.memo_id
        JOIN users u ON u.id = m.sender_id LEFT JOIN memo_categories mc ON mc.id = m.category_id
        WHERE mr.user_id = ? ORDER BY m.published_at DESC LIMIT ? OFFSET ?
      `).all(user.id, pageSize, offset);
      const total = db.prepare(`SELECT COUNT(*) as count FROM memo_recipients WHERE user_id = ?`).get(user.id).count;
      return res.json({ memos: rows, total, page, pageSize });
    }
    where.push(`m.sender_id = @userId`);
    params.userId = user.id;
    if (req.query.filter === 'drafts') where.push(`m.status = 'draft'`);
    else if (req.query.filter === 'archived') where.push(`m.status = 'archived'`);
    else where.push(`m.status != 'draft'`); // "sent" default view
    if (search) { where.push(`(m.title LIKE @search OR m.body LIKE @search)`); params.search = `%${search}%`; }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT m.*, mc.name as category_name,
             (SELECT COUNT(*) FROM memo_attachments a WHERE a.memo_id = m.id) as has_attachment,
             (SELECT COUNT(*) FROM memo_recipients r WHERE r.memo_id = m.id AND r.is_read = 1) as read_count
      FROM memos m
      LEFT JOIN memo_categories mc ON mc.id = m.category_id
      ${whereClause}
      ORDER BY m.created_at DESC
      LIMIT @pageSize OFFSET @offset
    `).all({ ...params, pageSize, offset });

    const totalRow = db.prepare(`SELECT COUNT(*) as count FROM memos m ${whereClause}`).get(params);
    return res.json({ memos: rows, total: totalRow.count, page, pageSize });
  }

  // administrator: full record view
  if (req.query.sender) { where.push(`(u.first_name || ' ' || u.last_name) LIKE @sender`); params.sender = `%${req.query.sender}%`; }
  if (req.query.senderType) { where.push(`m.sender_role = @senderType`); params.senderType = req.query.senderType; }
  if (req.query.category) { where.push(`m.category_id = @categoryId`); params.categoryId = req.query.category; }
  if (req.query.status) { where.push(`m.status = @status`); params.status = req.query.status; }
  if (search) { where.push(`(m.title LIKE @search OR m.body LIKE @search)`); params.search = `%${search}%`; }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT m.*, mc.name as category_name,
           u.first_name || ' ' || u.last_name as sender_name,
           CASE WHEN m.sender_role = 'staff' THEN sp.staff_number ELSE NULL END as staff_id,
           (SELECT COUNT(*) FROM memo_attachments a WHERE a.memo_id = m.id) as has_attachment,
           (SELECT COUNT(*) FROM memo_recipients r WHERE r.memo_id = m.id AND r.is_read = 1) as read_count
    FROM memos m
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN memo_categories mc ON mc.id = m.category_id
    LEFT JOIN staff_profiles sp ON sp.user_id = u.id
    ${whereClause}
    ORDER BY m.created_at DESC
    LIMIT @pageSize OFFSET @offset
  `).all({ ...params, pageSize, offset });

  const totalRow = db.prepare(`SELECT COUNT(*) as count FROM memos m JOIN users u ON u.id = m.sender_id ${whereClause}`).get(params);
  res.json({ memos: rows, total: totalRow.count, page, pageSize });
}

// ---------------- DETAIL ----------------
function getMemo(req, res) {
  const user = req.session.user;
  const memoId = Number(req.params.id);
  const memo = db.prepare(`
    SELECT m.*, mc.name as category_name, u.first_name || ' ' || u.last_name as sender_name
    FROM memos m
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN memo_categories mc ON mc.id = m.category_id
    WHERE m.id = ?
  `).get(memoId);

  if (!memo) return res.status(404).json({ error: 'Memo not found.' });

  let isRead = null;
  if (user.role === 'student') {
    const recipient = db.prepare(`SELECT * FROM memo_recipients WHERE memo_id = ? AND user_id = ?`).get(memoId, user.id);
    if (!recipient) return res.status(403).json({ error: 'You do not have access to this memo.' });
    isRead = !!recipient.is_read;
    if (!recipient.is_read) {
      db.prepare(`UPDATE memo_recipients SET is_read = 1, read_at = datetime('now') WHERE id = ?`).run(recipient.id);
      isRead = true;
    }
  } else if (user.role === 'staff' && memo.sender_id !== user.id) {
    const recipient = db.prepare(`SELECT * FROM memo_recipients WHERE memo_id = ? AND user_id = ?`).get(memoId, user.id);
    if (!recipient) return res.status(403).json({ error: 'You do not have access to this memo.' });
    if (!recipient.is_read) db.prepare(`UPDATE memo_recipients SET is_read = 1, read_at = datetime('now') WHERE id = ?`).run(recipient.id);
  } else if (memo.sender_id !== user.id && user.role !== 'administrator') {
    return res.status(403).json({ error: 'You do not have access to this memo.' });
  }

  const attachments = db.prepare(`SELECT id, original_filename, mime_type, size_bytes FROM memo_attachments WHERE memo_id = ?`).all(memoId);
  const rule = db.prepare(`
    SELECT tr.*, f.name as faculty_name, d.name as department_name, p.name as programme_name,
           l.name as level_name, sm.name as study_mode_name, c.code as course_code, c.title as course_title
    FROM memo_target_rules tr
    LEFT JOIN faculties f ON f.id = tr.faculty_id
    LEFT JOIN departments d ON d.id = tr.department_id
    LEFT JOIN programmes p ON p.id = tr.programme_id
    LEFT JOIN levels l ON l.id = tr.level_id
    LEFT JOIN study_modes sm ON sm.id = tr.study_mode_id
    LEFT JOIN courses c ON c.id = tr.course_id
    WHERE tr.memo_id = ?
  `).get(memoId);

  res.json({ memo, attachment: attachments[0] || null, attachments, targetRule: rule || null, isRead });
}

// ---------------- DOWNLOAD ATTACHMENT ----------------
function downloadAttachment(req, res) {
  const user = req.session.user;
  const memoId = Number(req.params.id);
  const memo = db.prepare(`SELECT * FROM memos WHERE id = ?`).get(memoId);
  if (!memo) return res.status(404).json({ error: 'Memo not found.' });

  if (user.role === 'student') {
    const recipient = db.prepare(`SELECT id FROM memo_recipients WHERE memo_id = ? AND user_id = ?`).get(memoId, user.id);
    if (!recipient) return res.status(403).json({ error: 'You do not have access to this attachment.' });
  } else if (user.role === 'staff' && memo.sender_id !== user.id) {
    const recipient = db.prepare(`SELECT id FROM memo_recipients WHERE memo_id = ? AND user_id = ?`).get(memoId, user.id);
    if (!recipient) return res.status(403).json({ error: 'You do not have access to this attachment.' });
  } else if (memo.sender_id !== user.id && user.role !== 'administrator') {
    return res.status(403).json({ error: 'You do not have access to this attachment.' });
  }

  const attachment = req.params.attachmentId
    ? db.prepare(`SELECT * FROM memo_attachments WHERE memo_id = ? AND id = ?`).get(memoId, Number(req.params.attachmentId))
    : db.prepare(`SELECT * FROM memo_attachments WHERE memo_id = ? ORDER BY id LIMIT 1`).get(memoId);
  if (!attachment) return res.status(404).json({ error: 'No attachment found for this memo.' });

  const filePath = path.join(UPLOAD_DIR, attachment.stored_filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Attachment file is no longer available.' });

  res.download(filePath, attachment.original_filename);
}

module.exports = {
  estimateRecipients, createMemo, updateMemo, publishMemo, archiveMemo,
  deleteMemo, resendMemo, listMemos, getMemo, downloadAttachment,
};
