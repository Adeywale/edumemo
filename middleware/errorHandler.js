const multer = require('multer');

// Central error handler. Never exposes stack traces, SQL errors, file paths,
// or environment values to the client -- only human-readable messages.
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  // Multer-specific errors (file too large, wrong type, etc.)
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Attachment is too large. Maximum size is 15MB.' });
    }
    return res.status(400).json({ error: 'There was a problem with your file upload.' });
  }
  if (err && /not supported/i.test(err.message || '')) {
    return res.status(400).json({ error: 'Attachment type is not supported.' });
  }

  console.error('Unhandled error:', err); // full detail stays server-side only

  const status = err.status || 500;
  const publicMessage = status === 500
    ? 'Something went wrong on our end. Please try again shortly.'
    : (err.publicMessage || err.message || 'Request could not be completed.');

  res.status(status).json({ error: publicMessage });
}

module.exports = errorHandler;
