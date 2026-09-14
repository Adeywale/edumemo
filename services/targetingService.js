const db = require('../database/db');

/**
 * Resolves a targeting rule (faculty/department/programme/level/study_mode/course,
 * any of which may be null meaning "any") plus an "entire institution" flag into a
 * concrete, de-duplicated list of recipient user IDs (students).
 *
 * Combinable filters are ANDed together, matching the spec example:
 *   Course = GST 102 AND Level = 100 Level
 *
 * @param {object} rule
 * @param {boolean} isInstitutionWide
 * @returns {number[]} user ids
 */
function resolveRecipientIds(rule, isInstitutionWide) {
  if (isInstitutionWide) {
    return db.prepare(`SELECT id FROM users WHERE status = 'active' AND role IN ('student', 'staff')`).all().map(row => row.id);
  }
  const group = rule.recipient_group || 'students';
  if (group === 'selected_users') {
    let ids = [];
    try { ids = [...new Set(JSON.parse(rule.recipient_user_ids || '[]').map(Number).filter(Number.isInteger))]; } catch (_) { return []; }
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return db.prepare(`SELECT id FROM users WHERE status = 'active' AND id IN (${placeholders})`).all(...ids).map(row => row.id);
  }
  const isStaff = group !== 'students';
  const conditions = [isStaff ? `u.role = 'staff'` : `u.role = 'student'`, `u.status = 'active'`];
  const params = {};
  if (group === 'academic_staff') conditions.push(`u.staff_type = 'academic'`);
  if (group === 'non_academic_staff') conditions.push(`u.staff_type = 'non_academic'`);
  if (rule.faculty_id) { conditions.push('sp.faculty_id = @facultyId'); params.facultyId = rule.faculty_id; }
  if (rule.department_id) { conditions.push('sp.department_id = @departmentId'); params.departmentId = rule.department_id; }
  if (!isStaff) {
    if (rule.programme_id) { conditions.push('sp.programme_id = @programmeId'); params.programmeId = rule.programme_id; }
    if (rule.level_id) { conditions.push('sp.level_id = @levelId'); params.levelId = rule.level_id; }
    if (rule.study_mode_id) { conditions.push('sp.study_mode_id = @studyModeId'); params.studyModeId = rule.study_mode_id; }
    if (rule.course_id) { conditions.push('sc.course_id = @courseId'); params.courseId = rule.course_id; }
  }
  const profileJoin = isStaff ? `JOIN staff_profiles sp ON sp.user_id = u.id` : `JOIN student_profiles sp ON sp.user_id = u.id`;
  const courseJoin = !isStaff && rule.course_id ? `JOIN student_courses sc ON sc.student_id = u.id` : '';
  return db.prepare(`SELECT DISTINCT u.id FROM users u ${profileJoin} ${courseJoin} WHERE ${conditions.join(' AND ')}`).all(params).map(row => row.id);
}

/** Returns just the count, for the "Estimated recipients: N" preview. */
function estimateRecipientCount(rule, isInstitutionWide) {
  return resolveRecipientIds(rule, isInstitutionWide).length;
}

module.exports = { resolveRecipientIds, estimateRecipientCount };
