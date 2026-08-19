// groupImage.js — group profile picture storage (separate from user avatars in profile.js).
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const GROUP_AVATAR_DIR = path.join(__dirname, '..', 'uploads', 'groups');

if (!fs.existsSync(GROUP_AVATAR_DIR)) {
  fs.mkdirSync(GROUP_AVATAR_DIR, { recursive: true });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
  fileFilter(_req, file, cb) {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, or WebP images are allowed'));
    }
    cb(null, true);
  },
});

function safeGroupId(groupId) {
  return String(groupId).replace(/[^a-zA-Z0-9_-]/g, '');
}

function pathsForGroup(groupId) {
  const safeId = safeGroupId(groupId);
  return {
    full: path.join(GROUP_AVATAR_DIR, `${safeId}.webp`),
    thumb: path.join(GROUP_AVATAR_DIR, `${safeId}-thumb.webp`),
    url: `/uploads/groups/${safeId}.webp`,
  };
}

async function saveGroupImage(groupId, buffer) {
  let meta;
  try {
    meta = await sharp(buffer).metadata();
  } catch (_error) {
    meta = null;
  }
  if (!meta || !['jpeg', 'png', 'webp'].includes(meta.format)) {
    const err = new Error('Only JPEG, PNG, or WebP images are allowed.');
    err.status = 400;
    throw err;
  }

  const paths = pathsForGroup(groupId);
  await sharp(buffer)
    .rotate()
    .resize(512, 512, { fit: 'cover', position: 'centre' })
    .webp({ quality: 82 })
    .toFile(paths.full);

  await sharp(buffer)
    .rotate()
    .resize(128, 128, { fit: 'cover', position: 'centre' })
    .webp({ quality: 75 })
    .toFile(paths.thumb);

  return `${paths.url}?v=${Date.now()}`;
}

module.exports = {
  upload,
  pathsForGroup,
  saveGroupImage,
  GROUP_AVATAR_DIR,
};
