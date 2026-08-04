// upload.js
// POST /api/upload — multipart file upload (images, videos, documents).
// Images also get a sharp-generated thumbnail for chat previews.

const fs = require('fs');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const express = require('express');
const { requireAuth } = require('./auth');

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');
const MAX_BYTES = 15 * 1024 * 1024; // 15MB

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov']);
const DOC_EXTS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.rar', '.7z', '.txt', '.csv', '.rtf',
]);

if (!fs.existsSync(UPLOAD_ROOT)) {
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
}

function extOf(name) {
  return path.extname(name || '').toLowerCase();
}

function classifyExt(ext) {
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (DOC_EXTS.has(ext)) return 'file';
  return null;
}

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    cb(null, UPLOAD_ROOT);
  },
  filename(_req, file, cb) {
    const ext = extOf(file.originalname) || '';
    const safe = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;
    cb(null, safe);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_BYTES },
  fileFilter(_req, file, cb) {
    const kind = classifyExt(extOf(file.originalname));
    if (!kind) {
      return cb(new Error(
        'Unsupported file type. Allowed: images (jpg/png/gif/webp), videos (mp4/mov), and documents (pdf/docx/xlsx/zip/…).'
      ));
    }
    cb(null, true);
  },
});

const router = express.Router();
router.use(requireAuth);

router.post('/', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: 'File is too large. Maximum size is 15MB.',
        });
      }
      return res.status(400).json({ error: err.message });
    }
    if (err) {
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded. Use field name "file".' });
    }

    const originalName = req.file.originalname;
    const ext = extOf(originalName);
    const fileType = classifyExt(ext);
    const url = '/uploads/' + req.file.filename;
    let thumbnailUrl = null;

    if (fileType === 'image') {
      try {
        const thumbName = 'thumb-' + path.parse(req.file.filename).name + '.jpg';
        const thumbPath = path.join(UPLOAD_ROOT, thumbName);
        await sharp(req.file.path)
          .rotate()
          .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 72 })
          .toFile(thumbPath);
        thumbnailUrl = '/uploads/' + thumbName;
      } catch (thumbErr) {
        console.warn('[upload] thumbnail failed:', thumbErr.message);
        // Fall back to the full image URL as the thumbnail.
        thumbnailUrl = url;
      }
    }

    res.status(201).json({
      url,
      thumbnailUrl,
      originalName,
      fileType,
      sizeInBytes: req.file.size,
    });
  });
});

module.exports = { router, UPLOAD_ROOT, MAX_BYTES };
