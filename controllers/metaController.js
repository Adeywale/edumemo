const db = require('../database/db');
const { logAction } = require('../utils/audit');

// ---------- Generic read-only lookups (used by registration forms, memo targeting UI) ----------
function listFaculties(req, res) {
  res.json(db.prepare(`SELECT * FROM faculties ORDER BY name`).all());
}
function listDepartments(req, res) {
  const facultyId = req.query.facultyId;
  const rows = facultyId
    ? db.prepare(`SELECT * FROM departments WHERE faculty_id = ? ORDER BY name`).all(facultyId)
    : db.prepare(`SELECT * FROM departments ORDER BY name`).all();
  res.json(rows);
}
function listProgrammes(req, res) {
  const departmentId = req.query.departmentId;
  const rows = departmentId
    ? db.prepare(`SELECT * FROM programmes WHERE department_id = ? ORDER BY name`).all(departmentId)
    : db.prepare(`SELECT * FROM programmes ORDER BY name`).all();
  res.json(rows);
}
function listLevels(req, res) {
  res.json(db.prepare(`SELECT * FROM levels ORDER BY sort_order, name`).all());
}
function listStudyModes(req, res) {
  res.json(db.prepare(`SELECT * FROM study_modes ORDER BY name`).all());
}
function listCourses(req, res) {
  const { search, departmentId, levelId } = req.query;
  let where = [];
  let params = {};
  if (search) { where.push(`(code LIKE @s OR title LIKE @s)`); params.s = `%${search}%`; }
  if (departmentId) { where.push(`department_id = @d`); params.d = departmentId; }
  if (levelId) { where.push(`level_id = @l`); params.l = levelId; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  res.json(db.prepare(`SELECT * FROM courses ${whereClause} ORDER BY code LIMIT 50`).all(params));
}
function listCategories(req, res) {
  res.json(db.prepare(`SELECT * FROM memo_categories ORDER BY name`).all());
}

// ---------- Admin CRUD (generic helper for simple lookup tables) ----------
function makeCrud(table, fields, extraCols = []) {
  return {
    create(req, res) {
      const values = fields.map(f => req.body[f] ?? null);
      const cols = [...fields, ...extraCols.map(c => c.name)];
      const extraVals = extraCols.map(c => req.body[c.name] ?? c.default ?? null);
      const placeholders = cols.map(() => '?').join(', ');
      try {
        const result = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`)
          .run(...values, ...extraVals);
        logAction({ actor: req.session.user, action: `${table}.create`, targetType: table, targetId: result.lastInsertRowid, ip: req.ip });
        res.status(201).json({ id: result.lastInsertRowid, message: 'Created successfully.' });
      } catch (err) {
        res.status(400).json({ error: 'Could not create record. It may already exist or reference an invalid item.' });
      }
    },
    update(req, res) {
      const id = req.params.id;
      const cols = [...fields, ...extraCols.map(c => c.name)];
      const setClause = cols.map(c => `${c} = ?`).join(', ');
      const values = cols.map(c => req.body[c] ?? null);
      try {
        db.prepare(`UPDATE ${table} SET ${setClause} WHERE id = ?`).run(...values, id);
        logAction({ actor: req.session.user, action: `${table}.update`, targetType: table, targetId: Number(id), ip: req.ip });
        res.json({ message: 'Updated successfully.' });
      } catch (err) {
        res.status(400).json({ error: 'Could not update record.' });
      }
    },
    remove(req, res) {
      const id = req.params.id;
      try {
        db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
        logAction({ actor: req.session.user, action: `${table}.delete`, targetType: table, targetId: Number(id), ip: req.ip });
        res.json({ message: 'Deleted successfully.' });
      } catch (err) {
        res.status(400).json({ error: 'Could not delete record. It may be referenced by existing data (e.g. registered users).' });
      }
    },
  };
}

const facultyCrud = makeCrud('faculties', ['name', 'code']);
const departmentCrud = makeCrud('departments', ['name', 'code', 'faculty_id']);
const programmeCrud = makeCrud('programmes', ['name', 'code', 'department_id']);
const levelCrud = makeCrud('levels', ['name'], [{ name: 'sort_order', default: 0 }]);
const studyModeCrud = makeCrud('study_modes', ['name']);
const courseCrud = makeCrud('courses', ['code', 'title', 'department_id', 'level_id']);
const categoryCrud = makeCrud('memo_categories', ['name']);

module.exports = {
  listFaculties, listDepartments, listProgrammes, listLevels, listStudyModes, listCourses, listCategories,
  facultyCrud, departmentCrud, programmeCrud, levelCrud, studyModeCrud, courseCrud, categoryCrud,
};
