// profile.js
// Profile customization: about text, avatar upload, and per-field privacy.
// Mounted in server.js as: app.use('/api/profile', profile.router)

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');

const db = require('./db');
const { requireAuth } = require('./auth');
const { canView } = require('./privacy');

// Wired from server.js after Socket.IO is created (see setRealtime).
let broadcastProfileUpdated = null;
let syncPresenceAfterPrivacyChange = null;

function setRealtime(handlers = {}) {
  if (typeof handlers.broadcastProfileUpdated === 'function') {
    broadcastProfileUpdated = handlers.broadcastProfileUpdated;
  }
  if (typeof handlers.syncPresenceAfterPrivacyChange === 'function') {
    syncPresenceAfterPrivacyChange = handlers.syncPresenceAfterPrivacyChange;
  }
}

function emitProfileUpdated(userId, fields) {
  if (broadcastProfileUpdated) broadcastProfileUpdated(userId, fields);
}

const ABOUT_MAX = 139;
const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Avatars live under the same uploads root as chat media, in an /avatars subfolder.
// Served at /uploads/avatars/<userId>.webp via existing static mount.
const AVATAR_DIR = path.join(__dirname, '..', 'uploads', 'avatars');
if (!fs.existsSync(AVATAR_DIR)) {
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AVATAR_MAX_BYTES },
  fileFilter(_req, file, cb) {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, or WebP images are allowed'));
    }
    cb(null, true);
  },
});

function avatarPaths(userId) {
  return {
    full: path.join(AVATAR_DIR, `${userId}.webp`),
    thumb: path.join(AVATAR_DIR, `${userId}-thumb.webp`),
    url: `/uploads/avatars/${userId}.webp`,
    thumbUrl: `/uploads/avatars/${userId}-thumb.webp`,
  };
}

function deleteAvatarFiles(userId) {
  const { full, thumb } = avatarPaths(userId);
  for (const p of [full, thumb]) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (err) {
      console.warn('[profile] failed to delete avatar file:', p, err.message);
    }
  }
}

// Also remove any legacy path stored in avatar_url that isn't our standard name.
function deleteStoredAvatarUrl(avatarUrl) {
  if (!avatarUrl || typeof avatarUrl !== 'string') return;
  const clean = avatarUrl.split('?')[0];
  if (!clean.startsWith('/uploads/')) return;
  const abs = path.join(__dirname, '..', clean.replace(/^\//, ''));
  // Only delete files inside uploads/avatars for safety.
  const avatarsRoot = path.resolve(AVATAR_DIR);
  const resolved = path.resolve(abs);
  if (!resolved.startsWith(avatarsRoot + path.sep) && resolved !== avatarsRoot) {
    return;
  }
  try {
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch (err) {
    console.warn('[profile] failed to delete stored avatar:', abs, err.message);
  }
}

function isContactEitherWay(a, b) {
  return !!(db.getContact(a, b) || db.getContact(b, a));
}

function visibleProfileFor(viewerId, owner) {
  if (!owner) return null;

  const isSelf = Number(viewerId) === Number(owner.id);
  const isContact = isSelf || isContactEitherWay(viewerId, owner.id);

  const fields = ['avatar', 'about', 'last_seen', 'status'];
  const privacyMap = {
    avatar: owner.privacy_avatar || 'everyone',
    about: owner.privacy_about || 'everyone',
    last_seen: owner.privacy_last_seen || 'everyone',
    status: owner.privacy_status || 'everyone',
  };

  const result = {
    id: owner.id,
    email: isSelf ? owner.email : undefined,
    display_name: owner.display_name,
    is_online: !!owner.is_online,
  };

  for (const field of fields) {
    const exceptions = db.getPrivacyExceptions(owner.id, field);
    const allowed = canView(
      viewerId,
      owner.id,
      field,
      privacyMap[field],
      isContact,
      exceptions
    );

    if (field === 'avatar') {
      result.avatar_url = allowed ? (owner.avatar_url || null) : null;
      result.avatar_hidden = !allowed && !isSelf;
    } else if (field === 'about') {
      const about =
        owner.about != null && owner.about !== ''
          ? owner.about
          : db.DEFAULT_ABOUT;
      result.about = allowed ? about : null;
      result.about_hidden = !allowed && !isSelf;
    } else if (field === 'last_seen') {
      result.last_seen = allowed ? (owner.last_seen || null) : null;
      result.last_seen_hidden = !allowed && !isSelf;
      // If last_seen is hidden, also hide online status (WhatsApp-like).
      if (!allowed && !isSelf) {
        result.is_online = false;
      }
    }
    // status reserved for Stories — no public field yet
  }

  // Don't leak email to other users.
  if (!isSelf) delete result.email;

  return result;
}

const router = express.Router();
router.use(requireAuth);

// GET /api/profile/me
router.get('/me', (req, res) => {
  const profile = db.getOwnProfile(req.user.id);
  if (!profile) return res.status(404).json({ error: 'User not found' });
  res.json({ profile });
});

// PATCH /api/profile/about  { about }
router.patch('/about', (req, res) => {
  let about = req.body && req.body.about != null ? String(req.body.about) : '';
  about = about.trim();
  if (about.length > ABOUT_MAX) {
    return res.status(400).json({
      error: `About text must be at most ${ABOUT_MAX} characters`,
    });
  }
  if (!about) about = db.DEFAULT_ABOUT;
  const profile = db.updateUserAbout(req.user.id, about);
  emitProfileUpdated(req.user.id, {
    avatar_url: profile.avatar_url,
    about: profile.about,
  });
  res.json({ profile });
});

// PATCH /api/profile/name  { displayName }
router.patch('/name', (req, res) => {
  const displayName = (req.body && req.body.displayName) || '';
  const name = String(displayName).trim();
  if (!name) {
    return res.status(400).json({ error: 'Display name is required' });
  }
  if (name.length > 64) {
    return res.status(400).json({ error: 'Display name must be at most 64 characters' });
  }
  const profile = db.updateUserDisplayName(req.user.id, name);
  if (!profile) {
    return res.status(400).json({ error: 'Could not update display name' });
  }
  emitProfileUpdated(req.user.id, {
    avatar_url: profile.avatar_url,
    about: profile.about,
    display_name: profile.display_name,
  });
  res.json({ profile });
});

// POST /api/profile/avatar  multipart field "avatar"
router.post('/avatar', (req, res) => {
  upload.single('avatar')(req, res, (err) => handleAvatarUpload(req, res, err));
});

async function handleAvatarUpload(req, res, err) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Image is too large. Maximum size is 5MB.' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message || 'Upload failed' });
  }
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({
      error: 'No image uploaded. Use form field "avatar".',
    });
  }

  // Sniff with sharp — don't trust Content-Type alone.
  let meta;
  try {
    meta = await sharp(req.file.buffer).metadata();
  } catch {
    return res.status(400).json({ error: 'Invalid image file' });
  }
  if (!meta || !meta.format || !['jpeg', 'png', 'webp'].includes(meta.format)) {
    return res.status(400).json({ error: 'Only JPEG, PNG, or WebP images are allowed' });
  }

  const userId = req.user.id;
  const paths = avatarPaths(userId);
  const previousUrl = req.user.avatar_url;

  try {
    await sharp(req.file.buffer)
      .rotate()
      .resize(512, 512, { fit: 'cover', position: 'centre' })
      .webp({ quality: 82 })
      .toFile(paths.full);

    await sharp(req.file.buffer)
      .rotate()
      .resize(128, 128, { fit: 'cover', position: 'centre' })
      .webp({ quality: 75 })
      .toFile(paths.thumb);
  } catch (processErr) {
    console.error('[profile] avatar processing failed:', processErr.message);
    return res.status(400).json({ error: 'Could not process image' });
  }

  // Drop any previous avatar that isn't the new canonical path.
  if (previousUrl && previousUrl.split('?')[0] !== paths.url) {
    deleteStoredAvatarUrl(previousUrl);
  }

  // Cache-bust so browsers pick up the new file at the same URL.
  const avatarUrl = `${paths.url}?v=${Date.now()}`;
  const profile = db.updateUserAvatar(userId, avatarUrl);
  emitProfileUpdated(userId, {
    avatar_url: profile.avatar_url,
    about: profile.about,
  });
  res.status(201).json({
    profile,
    avatar_url: avatarUrl,
    thumbnail_url: `${paths.thumbUrl}?v=${Date.now()}`,
  });
}

// DELETE /api/profile/avatar
router.delete('/avatar', (req, res) => {
  const previousUrl = req.user.avatar_url;
  deleteAvatarFiles(req.user.id);
  if (previousUrl) deleteStoredAvatarUrl(previousUrl);
  const profile = db.updateUserAvatar(req.user.id, null);
  emitProfileUpdated(req.user.id, {
    avatar_url: null,
    about: profile.about,
  });
  res.json({ profile, avatar_url: null });
});

// PATCH /api/profile/privacy
// { field, value, exceptions?: number[] }
router.patch('/privacy', (req, res) => {
  const field = (req.body && req.body.field) || '';
  const value = (req.body && req.body.value) || '';
  let exceptions = (req.body && req.body.exceptions) || [];

  if (!db.PRIVACY_FIELDS.has(field)) {
    return res.status(400).json({
      error: "field must be one of: avatar, about, last_seen, status",
    });
  }
  if (!db.PRIVACY_VALUES.has(value)) {
    return res.status(400).json({
      error: "value must be one of: everyone, contacts, contacts_except, nobody",
    });
  }

  if (!Array.isArray(exceptions)) {
    return res.status(400).json({ error: 'exceptions must be an array of user ids' });
  }
  exceptions = exceptions
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id !== req.user.id);

  if (value === 'contacts_except') {
    // Only allow excluding people who are actually in my contacts.
    exceptions = exceptions.filter((id) => db.getContact(req.user.id, id));
  } else {
    exceptions = [];
  }

  const profile = db.updateUserPrivacy(req.user.id, field, value, exceptions);
  if (!profile) return res.status(400).json({ error: 'Could not update privacy' });
  // Push filtered avatar/about so open chat lists clear hidden fields live.
  emitProfileUpdated(req.user.id, {
    avatar_url: profile.avatar_url,
    about: profile.about,
  });
  // Last-seen privacy change must also clear/refresh presence on open tabs.
  if (field === 'last_seen' && syncPresenceAfterPrivacyChange) {
    syncPresenceAfterPrivacyChange(req.user.id);
  }
  res.json({ profile });
});

// GET /api/profile/:userId — privacy-filtered view of another user.
// Registered after /me so "me" is not captured as an id.
router.get('/:userId', (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId)) {
    return res.status(400).json({ error: 'Invalid user id' });
  }
  const owner = db.getUserById(userId);
  if (!owner) return res.status(404).json({ error: 'User not found' });

  const profile = visibleProfileFor(req.user.id, owner);
  res.json({ profile });
});

module.exports = {
  router,
  setRealtime,
  AVATAR_DIR,
  visibleProfileFor,
  canView,
  ABOUT_MAX,
};
