// Populates the database with the academic structure and administrator account.
// Safe to re-run: existing lookup records are reused.

require('dotenv').config();

const bcrypt = require('bcryptjs');
const initDatabase = require('./init');
const db = require('./db');

const hash = (pw) => bcrypt.hashSync(pw, 10);

function upsertLookup(table, name, extra = {}) {
  const cols = ['name', ...Object.keys(extra)];

  const existing = db
    .prepare(`SELECT id FROM ${table} WHERE name = ?`)
    .get(name);

  if (existing) return existing.id;

  const placeholders = cols.map(() => '?').join(', ');

  const result = db
    .prepare(
      `INSERT INTO ${table} (${cols.join(', ')})
       VALUES (${placeholders})`
    )
    .run(name, ...Object.values(extra));

  return result.lastInsertRowid;
}

async function seed() {
  await initDatabase();

  console.log('Seeding EduMemo database...');

  // The administrator credentials must come from environment variables.
  const adminEmail = process.env.SEED_ADMIN_EMAIL;
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    throw new Error(
      'SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set before running the seed.'
    );
  }

  const tx = db.transaction(() => {

    // ---------------------------------------------------------
    // FACULTIES
    // ---------------------------------------------------------

    const facScience = upsertLookup(
      'faculties',
      'Faculty of Science',
      { code: 'SCI' }
    );

    const facEng = upsertLookup(
      'faculties',
      'Faculty of Engineering',
      { code: 'ENG' }
    );

    const facArts = upsertLookup(
      'faculties',
      'Faculty of Arts',
      { code: 'ART' }
    );

    const facGenStudies = upsertLookup(
      'faculties',
      'General Studies',
      { code: 'GEN' }
    );

    const legacyScit = db
      .prepare(
        `SELECT id FROM faculties
         WHERE name = ?`
      )
      .get('School of Communication and Information Technology');

    const namedScit = db
      .prepare(
        `SELECT id FROM faculties
         WHERE name = ?`
      )
      .get(
        'School of Communication and Information Technology (SCIT)'
      );

    if (legacyScit && !namedScit) {
      db.prepare(
        `UPDATE faculties
         SET name = ?
         WHERE id = ?`
      ).run(
        'School of Communication and Information Technology (SCIT)',
        legacyScit.id
      );
    }

    upsertLookup(
      'faculties',
      'School of Communication and Information Technology (SCIT)',
      { code: 'SCIT' }
    );

    upsertLookup(
      'faculties',
      'School of Engineering',
      { code: 'SENG' }
    );

    upsertLookup(
      'faculties',
      'School of Environmental Studies',
      { code: 'SENV' }
    );

    upsertLookup(
      'faculties',
      'School of Management Studies',
      { code: 'SMS' }
    );

    upsertLookup(
      'faculties',
      'School of Pure and Applied Sciences',
      { code: 'SPAS' }
    );

    upsertLookup(
      'faculties',
      'School of Part-Time Studies',
      { code: 'SPTS' }
    );

    upsertLookup(
      'faculties',
      'School of Agricultural Technology',
      { code: 'SAT' }
    );

    upsertLookup(
      'faculties',
      'School of Art, Design and Printing',
      { code: 'SADP' }
    );

    const facultyIdByCode = Object.fromEntries(
      db
        .prepare('SELECT id, code FROM faculties')
        .all()
        .map(row => [row.code, row.id])
    );

    // ---------------------------------------------------------
    // DEPARTMENTS
    // ---------------------------------------------------------

    const departmentGroups = {
      SCIT: [
        'Office Technology and Management',
        'Library and Information Science',
        'Mass Communication',
        'Music Technology',
        'Multimedia Technology',
        'Computer Science'
      ],

      SENG: [
        'Agricultural & Bio-Environmental Engineering',
        'Civil Engineering',
        'Computer Engineering',
        'Electrical/Electronic Engineering',
        'Mechanical Engineering',
        'Mechatronics Engineering',
        'Welding and Fabrication Engineering Technology'
      ],

      SENV: [
        'Architectural Technology',
        'Building Technology',
        'Estate Management and Valuation',
        'Quantity Surveying',
        'Surveying and Geo-informatics',
        'Transportation Planning & Management Technology',
        'Urban & Regional Planning'
      ],

      SMS: [
        'Accountancy',
        'Banking and Finance',
        'Business Administration and Management',
        'Insurance',
        'Marketing',
        'Public Administration',
        'Taxation'
      ],

      SPAS: [
        'Food Technology',
        'Hospitality Management Technology',
        'Nutrition and Dietetics',
        'Statistics',
        'Science Laboratory Technology',
        'Tourism Management Technology'
      ],

      SAT: [
        'Agricultural Extension and Management',
        'Animal Production Technology',
        'Crop Production Technology',
        'Agricultural Technology',
        'Animal Health Production Technology',
        'Horticultural Technology'
      ],

      SADP: [
        'Art and Design — Painting',
        'Art and Design — Sculpture',
        'Graphic Art',
        'Industrial Design — Ceramics',
        'Industrial Design — Textile'
      ]
    };

    let departmentCode = 1;

    for (const [facultyCode, names] of Object.entries(departmentGroups)) {
      for (const name of names) {

        const existing = db
          .prepare(
            `SELECT id
             FROM departments
             WHERE name = ?
             AND faculty_id = ?`
          )
          .get(
            name,
            facultyIdByCode[facultyCode]
          );

        if (!existing) {
          db.prepare(
            `INSERT INTO departments
             (name, code, faculty_id)
             VALUES (?, ?, ?)`
          ).run(
            name,
            `DEPT${departmentCode}`,
            facultyIdByCode[facultyCode]
          );
        }

        departmentCode += 1;
      }
    }

    // ---------------------------------------------------------
    // SPECIFIC DEPARTMENTS
    // ---------------------------------------------------------

    const deptCompSci =
      db
        .prepare(
          `INSERT OR IGNORE INTO departments
           (name, code, faculty_id)
           VALUES (?, ?, ?)`
        )
        .run(
          'Computer Science',
          'CSC',
          facScience
        ).lastInsertRowid ||

      db
        .prepare(
          `SELECT id
           FROM departments
           WHERE name = ?
           AND faculty_id = ?`
        )
        .get(
          'Computer Science',
          facScience
        ).id;

    const deptMaths =
      db
        .prepare(
          `INSERT OR IGNORE INTO departments
           (name, code, faculty_id)
           VALUES (?, ?, ?)`
        )
        .run(
          'Mathematics',
          'MTH',
          facScience
        ).lastInsertRowid ||

      db
        .prepare(
          `SELECT id
           FROM departments
           WHERE name = ?
           AND faculty_id = ?`
        )
        .get(
          'Mathematics',
          facScience
        ).id;

    const deptElecEng =
      db
        .prepare(
          `INSERT OR IGNORE INTO departments
           (name, code, faculty_id)
           VALUES (?, ?, ?)`
        )
        .run(
          'Electrical Engineering',
          'EEE',
          facEng
        ).lastInsertRowid ||

      db
        .prepare(
          `SELECT id
           FROM departments
           WHERE name = ?
           AND faculty_id = ?`
        )
        .get(
          'Electrical Engineering',
          facEng
        ).id;

    const deptEnglish =
      db
        .prepare(
          `INSERT OR IGNORE INTO departments
           (name, code, faculty_id)
           VALUES (?, ?, ?)`
        )
        .run(
          'English Language',
          'ENG-LANG',
          facArts
        ).lastInsertRowid ||

      db
        .prepare(
          `SELECT id
           FROM departments
           WHERE name = ?
           AND faculty_id = ?`
        )
        .get(
          'English Language',
          facArts
        ).id;

    const deptGeneral =
      db
        .prepare(
          `INSERT OR IGNORE INTO departments
           (name, code, faculty_id)
           VALUES (?, ?, ?)`
        )
        .run(
          'General Studies',
          'GST',
          facGenStudies
        ).lastInsertRowid ||

      db
        .prepare(
          `SELECT id
           FROM departments
           WHERE name = ?
           AND faculty_id = ?`
        )
        .get(
          'General Studies',
          facGenStudies
        ).id;

    // ---------------------------------------------------------
    // PROGRAMMES
    // ---------------------------------------------------------

    const progCompSci =
      db
        .prepare(
          `INSERT OR IGNORE INTO programmes
           (name, code, department_id)
           VALUES (?, ?, ?)`
        )
        .run(
          'B.Sc. Computer Science',
          'BSC-CSC',
          deptCompSci
        ).lastInsertRowid ||

      db
        .prepare(
          `SELECT id
           FROM programmes
           WHERE name = ?
           AND department_id = ?`
        )
        .get(
          'B.Sc. Computer Science',
          deptCompSci
        ).id;

    const progElecEng =
      db
        .prepare(
          `INSERT OR IGNORE INTO programmes
           (name, code, department_id)
           VALUES (?, ?, ?)`
        )
        .run(
          'B.Eng. Electrical Engineering',
          'BENG-EEE',
          deptElecEng
        ).lastInsertRowid ||

      db
        .prepare(
          `SELECT id
           FROM programmes
           WHERE name = ?
           AND department_id = ?`
        )
        .get(
          'B.Eng. Electrical Engineering',
          deptElecEng
        ).id;

    // ---------------------------------------------------------
    // LEVELS
    // ---------------------------------------------------------

    const level100 = upsertLookup(
      'levels',
      '100 Level',
      { sort_order: 1 }
    );

    const level200 = upsertLookup(
      'levels',
      '200 Level',
      { sort_order: 2 }
    );

    const level300 = upsertLookup(
      'levels',
      '300 Level',
      { sort_order: 3 }
    );

    const level400 = upsertLookup(
      'levels',
      '400 Level',
      { sort_order: 4 }
    );

    const level500 = upsertLookup(
      'levels',
      '500 Level',
      { sort_order: 5 }
    );

    // ---------------------------------------------------------
    // STUDY MODES
    // ---------------------------------------------------------

    const modeFullTime = upsertLookup(
      'study_modes',
      'Full-time'
    );

    const modePartTime = upsertLookup(
      'study_modes',
      'Part-time'
    );

    // ---------------------------------------------------------
    // COURSES
    // ---------------------------------------------------------

    const upsertCourse = (code, title, deptId, levelId) => {

      const existing = db
        .prepare(
          `SELECT id
           FROM courses
           WHERE code = ?`
        )
        .get(code);

      if (existing) return existing.id;

      return db
        .prepare(
          `INSERT INTO courses
           (code, title, department_id, level_id)
           VALUES (?, ?, ?, ?)`
        )
        .run(
          code,
          title,
          deptId,
          levelId
        ).lastInsertRowid;
    };

    upsertCourse(
      'GST 102',
      'Use of English II',
      deptGeneral,
      level100
    );

    upsertCourse(
      'CSC 201',
      'Introduction to Programming',
      deptCompSci,
      level200
    );

    upsertCourse(
      'EEE 301',
      'Electromagnetic Theory',
      deptElecEng,
      level300
    );

    // ---------------------------------------------------------
    // MEMO CATEGORIES
    // ---------------------------------------------------------

    [
      'General',
      'Examination',
      'Academic',
      'Event',
      'Health & Safety',
      'Financial',
      'Urgent'
    ].forEach(category => {
      upsertLookup(
        'memo_categories',
        category
      );
    });

    // ---------------------------------------------------------
    // ADMINISTRATOR
    // ---------------------------------------------------------

    let admin = db
      .prepare(
        `SELECT id
         FROM users
         WHERE email = ?`
      )
      .get(adminEmail);

    if (!admin) {

      const result = db
        .prepare(
          `INSERT INTO users
           (
             role,
             email,
             password_hash,
             first_name,
             last_name,
             status,
             email_verified
           )
           VALUES
           (
             'administrator',
             ?,
             ?,
             'System',
             'Administrator',
             'active',
             1
           )`
        )
        .run(
          adminEmail,
          hash(adminPassword)
        );

      db.prepare(
        `INSERT INTO administrators
         (user_id, super_admin)
         VALUES (?, 1)`
      ).run(
        result.lastInsertRowid
      );

      admin = {
        id: result.lastInsertRowid
      };

      console.log(
        `Created administrator: ${adminEmail}`
      );

    } else {

      console.log(
        `Administrator already exists: ${adminEmail}`
      );
    }
  });

  tx();

  console.log('\nSeed complete.');
  console.log('=========================================================');
  console.log('Only the configured administrator account was seeded.');
  console.log(`Administrator: ${adminEmail}`);
  console.log('Demo staff accounts were NOT created.');
  console.log('Demo student accounts were NOT created.');
  console.log('=========================================================\n');

}

// Keep `npm run seed` working from the command line while also allowing
// server.js to call seed() directly (used to bootstrap a fresh database on
// first boot of a new environment such as a Render deployment).
if (require.main === module) {
  seed().catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
}

module.exports = seed;