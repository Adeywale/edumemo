const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

// ------------------------------------------------------------------
// Where uploaded memo attachments are stored, same priority order as
// database/db.js uses for the SQLite file:
//   1. UPLOAD_DIR env var -- explicit override, always wins.
//   2. RAILWAY_VOLUME_MOUNT_PATH -- if a Railway Volume is attached,
//      store attachments inside it automatically (in an "uploads"
//      subfolder) so they survive redeploys, same as the database.
//   3. Local "public/uploads" folder -- fine for local dev, but on most
//      hosts (Railway included) this is wiped on every redeploy/restart,
//      so previously-uploaded attachments would 404 after a deploy even
//      though the memo record referencing them still exists in the DB.
// ------------------------------------------------------------------
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.cwd(), process.env.UPLOAD_DIR)
  : process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'uploads')
  : path.join(__dirname, '..', 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15 MB

// Allow-list of extension -> accepted MIME types. Both must match, which
// blocks the classic "rename a .exe to .pdf" trick and other MIME spoofing.
const ALLOWED_TYPES = {
  '.pdf': ['application/pdf'],
  '.doc': ['application/msword'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.png': ['image/png'],
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // Never trust the original filename for the stored path (path traversal,
    // collisions, unsafe characters). Generate a random, safe name instead.
    const ext = path.extname(file.originalname).toLowerCase();
    const safeName = `${Date.now()}-${crypto.randomBytes(12).toString('hex')}${ext}`;
    cb(null, safeName);
  },
});

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  const allowedMimes = ALLOWED_TYPES[ext];
  if (!allowedMimes) {
    return cb(new Error('Attachment type is not supported.'));
  }
  if (!allowedMimes.includes(file.mimetype)) {
    return cb(new Error('Attachment type is not supported.'));
  }
  cb(null, true);
}

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 5 },
  fileFilter,
});

module.exports = { upload, UPLOAD_DIR, MAX_FILE_SIZE_BYTES, ALLOWED_TYPES };
