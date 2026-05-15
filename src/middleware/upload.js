const multer = require('multer');

module.exports = multer({
  dest: 'data/uploads/',
  limits: { fileSize: 1024 * 1024 * 5000 } // 5GB
});