// db.js
// Database connection + queries.
//
// We use SQLite (via better-sqlite3) so the app runs locally with zero setup:
// the whole database is a single file (whatsapp.db) created automatically on
// first run. better-sqlite3 is synchronous, which keeps the query code simple
// and easy to read.
//
// If you later move to PostgreSQL, this is the ONLY file that needs to change:
// the rest of the app only calls the exported functions below, not the driver
// directly.

const path = require('path');
const Database = require('better-sqlite3');

const DB_FILE = path.join(__dirname, '..', 'whatsapp.db');
const db = new Database(DB_FILE);

// Recommended pragmas: WAL gives better concurrency, foreign_keys enforces
// relationships between tables.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Rebuild messages if the CHECK constraint still forbids message_type='call'.
function ensureMessagesAllowCallType() {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'")
    .get();
  if (!row || !row.sql) return;
  if (row.sql.includes("'call'")) return;
  // No CHECK on message_type (column added via ALTER) → inserts of 'call' already work.
  if (!/message_type[^,)]*CHECK/i.test(row.sql)) return;

  db.pragma('foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE messages_mig (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        receiver_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        text          TEXT NOT NULL DEFAULT '',
        status        TEXT NOT NULL DEFAULT 'sent'
                        CHECK (status IN ('sent', 'delivered', 'read')),
        message_type  TEXT NOT NULL DEFAULT 'text'
                        CHECK (message_type IN ('text', 'image', 'video', 'file', 'call')),
        file_url      TEXT,
        thumbnail_url TEXT,
        file_name     TEXT,
        file_size     INTEGER,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO messages_mig (
        id, sender_id, receiver_id, text, status,
        message_type, file_url, thumbnail_url, file_name, file_size, created_at
      )
      SELECT
        id, sender_id, receiver_id, text, status,
        message_type, file_url, thumbnail_url, file_name, file_size, created_at
      FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_mig RENAME TO messages;
      CREATE INDEX IF NOT EXISTS idx_messages_pair
        ON messages (sender_id, receiver_id, created_at);
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('[db] messages call-type migration failed:', err.message);
  }
  db.pragma('foreign_keys = ON');
}

// ---------- Schema ----------
// We create tables feature-by-feature. Phase 1, Feature 1 only needs users.
// Users log in with their email address.
function initSchema() {
  // Migration: an earlier version keyed users by "username". If we find that
  // old shape, drop it (dev data only) so we can recreate with an email column.
  const existing = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
    .get();
  if (existing) {
    const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    if (!cols.includes('email')) {
      db.exec('DROP TABLE users');
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name  TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      avatar_url    TEXT,
      is_online     INTEGER NOT NULL DEFAULT 0,
      last_seen     TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migration for databases created before these columns existed: add any that
  // are missing.
  const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userCols.includes('avatar_url')) {
    db.exec('ALTER TABLE users ADD COLUMN avatar_url TEXT');
  }
  if (!userCols.includes('is_online')) {
    db.exec('ALTER TABLE users ADD COLUMN is_online INTEGER NOT NULL DEFAULT 0');
  }
  if (!userCols.includes('last_seen')) {
    db.exec('ALTER TABLE users ADD COLUMN last_seen TEXT');
  }
  // Profile customization: about text + per-field privacy.
  // SQLite ALTER TABLE cannot add CHECK constraints; we validate in app code.
  // Reuses existing `last_seen` (no separate last_seen_at column).
  const DEFAULT_ABOUT = 'Hey there! I am using WhatsApp Clone.';
  if (!userCols.includes('about')) {
    db.exec(`ALTER TABLE users ADD COLUMN about TEXT DEFAULT '${DEFAULT_ABOUT}'`);
    db.exec(`UPDATE users SET about = '${DEFAULT_ABOUT}' WHERE about IS NULL`);
  }
  for (const col of [
    'privacy_avatar',
    'privacy_about',
    'privacy_last_seen',
    'privacy_status',
  ]) {
    if (!userCols.includes(col)) {
      db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT NOT NULL DEFAULT 'everyone'`);
    }
  }

  // Who is excluded when privacy_* = 'contacts_except'.
  db.exec(`
    CREATE TABLE IF NOT EXISTS privacy_exceptions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      field            TEXT NOT NULL
                         CHECK (field IN ('avatar', 'about', 'last_seen', 'status')),
      excluded_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE (owner_id, field, excluded_user_id)
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_privacy_exceptions_owner_field
      ON privacy_exceptions (owner_id, field);
  `);

  // My contact list. A row means "user_id has added contact_user_id".
  // UNIQUE stops the same person being added twice.
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      contact_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, contact_user_id)
    );
  `);

  // 1-to-1 messages. status tracks the delivery lifecycle.
  // text is the body for text messages, or an optional caption for media.
  // message_type 'call' = inline call event in the thread (missed/answered/declined).
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text          TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT 'sent'
                      CHECK (status IN ('sent', 'delivered', 'read')),
      message_type  TEXT NOT NULL DEFAULT 'text'
                      CHECK (message_type IN ('text', 'image', 'video', 'file', 'call')),
      file_url      TEXT,
      thumbnail_url TEXT,
      file_name     TEXT,
      file_size     INTEGER,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_pair
      ON messages (sender_id, receiver_id, created_at);
  `);

  // Migrations for DBs created before media / call columns existed.
  const msgCols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  const addCol = (name, ddl) => {
    if (!msgCols.includes(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${ddl}`);
  };
  addCol('message_type', "message_type TEXT NOT NULL DEFAULT 'text'");
  addCol('file_url', 'file_url TEXT');
  addCol('thumbnail_url', 'thumbnail_url TEXT');
  addCol('file_name', 'file_name TEXT');
  addCol('file_size', 'file_size INTEGER');

  // Older DBs have CHECK (... 'file') without 'call' — rebuild so call events can be stored.
  ensureMessagesAllowCallType();
  // Call history (Phase A). Real WebRTC calling comes in Phase B/C.
  db.exec(`
    CREATE TABLE IF NOT EXISTS calls (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      caller_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      call_type        TEXT NOT NULL CHECK (call_type IN ('voice', 'video')),
      status           TEXT NOT NULL CHECK (status IN ('missed', 'answered', 'declined')),
      started_at       TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at         TEXT,
      duration_seconds INTEGER
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_calls_participants
      ON calls (caller_id, receiver_id, started_at);
  `);

  // A previous run may have crashed while users were marked online. Reset
  // everyone to offline on startup so presence starts from a clean slate.
  db.exec('UPDATE users SET is_online = 0');
}
initSchema();

// ---------- User queries ----------
// Returns the newly created user (without the password hash).
function createUser({ email, displayName, passwordHash }) {
  const stmt = db.prepare(`
    INSERT INTO users (email, display_name, password_hash)
    VALUES (@email, @displayName, @passwordHash)
  `);
  const info = stmt.run({ email, displayName, passwordHash });
  return getUserById(info.lastInsertRowid);
}

// Full row INCLUDING password_hash — only use this for login verification.
function getUserByEmail(email) {
  return db
    .prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE')
    .get(email);
}

// Safe public view of a user (no password hash), used everywhere else.
function getUserById(id) {
  return db
    .prepare(`
      SELECT
        id, email, display_name, avatar_url, about,
        privacy_avatar, privacy_about, privacy_last_seen, privacy_status,
        is_online, last_seen, created_at
      FROM users WHERE id = ?
    `)
    .get(id);
}

const DEFAULT_ABOUT = 'Hey there! I am using WhatsApp Clone.';
const PRIVACY_VALUES = new Set(['everyone', 'contacts', 'contacts_except', 'nobody']);
const PRIVACY_FIELDS = new Set(['avatar', 'about', 'last_seen', 'status']);
const PRIVACY_COLUMN = {
  avatar: 'privacy_avatar',
  about: 'privacy_about',
  last_seen: 'privacy_last_seen',
  status: 'privacy_status',
};

// Full profile for the logged-in user (includes privacy settings + exceptions).
function getOwnProfile(userId) {
  const user = getUserById(userId);
  if (!user) return null;
  const exceptions = db
    .prepare(
      'SELECT field, excluded_user_id FROM privacy_exceptions WHERE owner_id = ? ORDER BY field, excluded_user_id'
    )
    .all(userId);
  const byField = { avatar: [], about: [], last_seen: [], status: [] };
  for (const row of exceptions) {
    if (byField[row.field]) byField[row.field].push(row.excluded_user_id);
  }
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    avatar_url: user.avatar_url || null,
    about: user.about != null ? user.about : DEFAULT_ABOUT,
    privacy: {
      avatar: user.privacy_avatar || 'everyone',
      about: user.privacy_about || 'everyone',
      last_seen: user.privacy_last_seen || 'everyone',
      status: user.privacy_status || 'everyone',
    },
    privacy_exceptions: byField,
    is_online: !!user.is_online,
    last_seen: user.last_seen || null,
    last_seen_at: user.last_seen || null,
    created_at: user.created_at,
  };
}

function updateUserAbout(userId, about) {
  db.prepare('UPDATE users SET about = ? WHERE id = ?').run(about, userId);
  return getOwnProfile(userId);
}

function updateUserAvatar(userId, avatarUrl) {
  db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatarUrl, userId);
  return getOwnProfile(userId);
}

function updateUserPrivacy(userId, field, value, exceptionUserIds) {
  const col = PRIVACY_COLUMN[field];
  if (!col || !PRIVACY_VALUES.has(value)) return null;

  const run = db.transaction(() => {
    db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(value, userId);
    db.prepare(
      'DELETE FROM privacy_exceptions WHERE owner_id = ? AND field = ?'
    ).run(userId, field);

    if (value === 'contacts_except' && Array.isArray(exceptionUserIds)) {
      const insert = db.prepare(`
        INSERT OR IGNORE INTO privacy_exceptions (owner_id, field, excluded_user_id)
        VALUES (?, ?, ?)
      `);
      for (const raw of exceptionUserIds) {
        const excludedId = Number(raw);
        if (!Number.isInteger(excludedId) || excludedId === userId) continue;
        if (!getUserById(excludedId)) continue;
        insert.run(userId, field, excludedId);
      }
    }
  });
  run();
  return getOwnProfile(userId);
}

function getPrivacyExceptions(ownerId, field) {
  return db
    .prepare(
      'SELECT excluded_user_id FROM privacy_exceptions WHERE owner_id = ? AND field = ?'
    )
    .all(ownerId, field)
    .map((r) => r.excluded_user_id);
}

// Raw privacy settings row for a user (used by the privacy helper).
function getPrivacySettings(userId) {
  const user = getUserById(userId);
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    avatar_url: user.avatar_url || null,
    about_text: user.about != null ? user.about : DEFAULT_ABOUT,
    is_online: !!user.is_online,
    last_seen_at: user.last_seen || null,
    privacy: {
      avatar: user.privacy_avatar || 'everyone',
      about: user.privacy_about || 'everyone',
      last_seen: user.privacy_last_seen || 'everyone',
      status: user.privacy_status || 'everyone',
    },
  };
}

// ---------- Presence queries ----------
function setUserOnline(id) {
  db.prepare('UPDATE users SET is_online = 1 WHERE id = ?').run(id);
}

// Marks offline and stamps last_seen with the current time; returns last_seen.
function setUserOffline(id) {
  const lastSeen = new Date().toISOString();
  db.prepare('UPDATE users SET is_online = 0, last_seen = ? WHERE id = ?').run(lastSeen, id);
  return lastSeen;
}

// The users who have `userId` in THEIR contact list — i.e. the people who
// should be told when userId comes online / goes offline.
function getContactOwners(userId) {
  return db
    .prepare('SELECT user_id FROM contacts WHERE contact_user_id = ?')
    .all(userId)
    .map((row) => row.user_id);
}

// ---------- Contact queries ----------
function addContact(userId, contactUserId) {
  db.prepare(`
    INSERT OR IGNORE INTO contacts (user_id, contact_user_id)
    VALUES (?, ?)
  `).run(userId, contactUserId);
  return getContact(userId, contactUserId);
}

function getContact(userId, contactUserId) {
  return db
    .prepare('SELECT * FROM contacts WHERE user_id = ? AND contact_user_id = ?')
    .get(userId, contactUserId);
}

// Returns each contact as a public user row, including presence + the number
// of unread messages that contact has sent me.
function getContacts(userId) {
  return db.prepare(`
    SELECT
      u.id,
      u.email,
      u.display_name,
      u.avatar_url,
      u.is_online,
      u.last_seen,
      c.created_at AS added_at,
      (
        SELECT COUNT(*) FROM messages m
        WHERE m.sender_id = u.id
          AND m.receiver_id = @me
          AND m.status <> 'read'
      ) AS unread
    FROM contacts c
    JOIN users u ON u.id = c.contact_user_id
    WHERE c.user_id = @me
    ORDER BY u.display_name COLLATE NOCASE
  `).all({ me: userId });
}

// ---------- Message queries ----------
function createMessage({
  senderId,
  receiverId,
  text = '',
  status = 'sent',
  messageType = 'text',
  fileUrl = null,
  thumbnailUrl = null,
  fileName = null,
  fileSize = null,
  createdAt = null,
}) {
  const type = ['text', 'image', 'video', 'file', 'call'].includes(messageType)
    ? messageType
    : 'text';
  const info = createdAt
    ? db.prepare(`
        INSERT INTO messages (
          sender_id, receiver_id, text, status,
          message_type, file_url, thumbnail_url, file_name, file_size, created_at
        )
        VALUES (
          @senderId, @receiverId, @text, @status,
          @messageType, @fileUrl, @thumbnailUrl, @fileName, @fileSize, @createdAt
        )
      `).run({
        senderId,
        receiverId,
        text: text || '',
        status,
        messageType: type,
        fileUrl,
        thumbnailUrl,
        fileName,
        fileSize,
        createdAt,
      })
    : db.prepare(`
        INSERT INTO messages (
          sender_id, receiver_id, text, status,
          message_type, file_url, thumbnail_url, file_name, file_size
        )
        VALUES (
          @senderId, @receiverId, @text, @status,
          @messageType, @fileUrl, @thumbnailUrl, @fileName, @fileSize
        )
      `).run({
        senderId,
        receiverId,
        text: text || '',
        status,
        messageType: type,
        fileUrl,
        thumbnailUrl,
        fileName,
        fileSize,
      });
  return toPublicMessage(getMessageById(info.lastInsertRowid));
}

function getMessageById(id) {
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
}

// Canonical message shape for REST + Socket.IO. Always includes media fields
// so sender and receiver get the exact same object (no dropped columns).
function toPublicMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    sender_id: row.sender_id,
    receiver_id: row.receiver_id,
    text: row.text == null ? '' : String(row.text),
    status: row.status || 'sent',
    message_type: row.message_type || 'text',
    file_url: row.file_url || null,
    thumbnail_url: row.thumbnail_url || null,
    file_name: row.file_name || null,
    file_size: row.file_size == null ? null : Number(row.file_size),
    created_at: row.created_at,
  };
}

// Inline thread event for a finished call (also linked via file_url = call:<id>).
function createCallThreadMessage({
  callerId,
  receiverId,
  callType,
  status,
  durationSeconds = null,
  startedAt = null,
  callId = null,
}) {
  // Missed calls stay 'delivered' so they bump the receiver's unread count.
  const msgStatus = status === 'missed' ? 'delivered' : 'read';
  return createMessage({
    senderId: callerId,
    receiverId,
    text: status, // missed | answered | declined
    status: msgStatus,
    messageType: 'call',
    fileUrl: callId != null ? 'call:' + callId : null,
    fileName: callType === 'video' ? 'video' : 'voice',
    fileSize: durationSeconds,
    createdAt: startedAt,
  });
}

function getCallsBetween(userA, userB) {
  return db.prepare(`
    SELECT * FROM calls
    WHERE (caller_id = @a AND receiver_id = @b)
       OR (caller_id = @b AND receiver_id = @a)
    ORDER BY started_at ASC, id ASC
  `).all({ a: userA, b: userB });
}

// Parse SQLite / ISO timestamps to ms for reliable ordering across formats.
function timestampMs(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const s = String(value).trim();
  if (!s) return 0;
  // "YYYY-MM-DD HH:MM:SS" (SQLite UTC) → treat as UTC
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) {
    const t = Date.parse(s.replace(' ', 'T') + 'Z');
    return Number.isFinite(t) ? t : 0;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

function compareTimelineItems(a, b) {
  const dt = timestampMs(a && a.created_at) - timestampMs(b && b.created_at);
  if (dt !== 0) return dt;
  return Number(a && a.id) - Number(b && b.id);
}

// Full conversation timeline: regular messages + call events, oldest first.
// Prefer real message rows; synthesize from `calls` only when no linked call message exists.
function getConversationTimeline(userA, userB) {
  const messages = db.prepare(`
    SELECT * FROM messages
    WHERE (sender_id = @a AND receiver_id = @b)
       OR (sender_id = @b AND receiver_id = @a)
    ORDER BY created_at ASC, id ASC
  `).all({ a: userA, b: userB }).map(toPublicMessage);

  // Drop bogus call pills that don't link to a real `calls` row (e.g. old test data).
  const validCallIds = new Set(
    getCallsBetween(userA, userB).map((c) => Number(c.id))
  );
  const cleaned = messages.filter((m) => {
    if (m.message_type !== 'call') return true;
    const url = m.file_url != null ? String(m.file_url) : '';
    if (!url.startsWith('call:')) return false;
    const cid = Number(url.slice(5));
    return Number.isFinite(cid) && validCallIds.has(cid);
  });

  const linked = new Set(
    cleaned
      .filter((m) => m.message_type === 'call' && m.file_url)
      .map((m) => m.file_url)
  );

  for (const c of getCallsBetween(userA, userB)) {
    const key = 'call:' + c.id;
    if (linked.has(key)) continue;
    // Use started_at so call pills sit at when the call happened, not when it was saved.
    cleaned.push(toPublicMessage({
      id: -c.id, // negative id = synthetic from calls table (history only)
      sender_id: c.caller_id,
      receiver_id: c.receiver_id,
      text: c.status,
      status: 'read',
      message_type: 'call',
      file_url: key,
      thumbnail_url: null,
      file_name: c.call_type,
      file_size: c.duration_seconds,
      created_at: c.started_at,
    }));
  }

  cleaned.sort(compareTimelineItems);
  return cleaned;
}

// Full conversation between two users, oldest first (messages only).
function getMessagesBetween(userA, userB) {
  return getConversationTimeline(userA, userB);
}

function updateMessageStatus(id, status) {
  db.prepare('UPDATE messages SET status = ? WHERE id = ?').run(status, id);
  return toPublicMessage(getMessageById(id));
}

// Number of messages `contactId` sent `userId` that aren't read yet.
function getUnreadCount(userId, contactId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM messages
    WHERE receiver_id = ? AND sender_id = ? AND status <> 'read'
  `).get(userId, contactId);
  return row.n;
}

// Mark every message `contactId` sent `userId` as read. Returns the ids that
// were updated (empty array means nothing to update).
function markConversationRead(userId, contactId) {
  const rows = db.prepare(`
    SELECT id FROM messages
    WHERE receiver_id = ? AND sender_id = ? AND status <> 'read'
  `).all(userId, contactId);
  if (rows.length === 0) return [];
  db.prepare(`
    UPDATE messages SET status = 'read'
    WHERE receiver_id = ? AND sender_id = ? AND status <> 'read'
  `).run(userId, contactId);
  return rows.map((r) => r.id);
}

// When a user connects, any messages still at 'sent' that were addressed to
// them become 'delivered'. Returns [{ id, sender_id }, ...] for notifying senders.
function markMessagesDeliveredForReceiver(receiverId) {
  const rows = db.prepare(`
    SELECT id, sender_id FROM messages
    WHERE receiver_id = ? AND status = 'sent'
  `).all(receiverId);
  if (rows.length === 0) return [];
  db.prepare(`
    UPDATE messages SET status = 'delivered'
    WHERE receiver_id = ? AND status = 'sent'
  `).run(receiverId);
  return rows;
}

// One row per contact I've exchanged messages with: the latest message in that
// conversation plus my unread count, newest conversation first. Contacts with
// no messages yet are omitted (nothing to show in "Recent Chats").
function getConversations(userId) {
  return db.prepare(`
    SELECT
      u.id            AS contact_id,
      u.email         AS email,
      u.display_name  AS display_name,
      u.avatar_url    AS avatar_url,
      u.is_online     AS is_online,
      u.last_seen     AS last_seen,
      m.text          AS last_text,
      m.created_at    AS last_at,
      m.sender_id     AS last_sender_id,
      m.status        AS last_status,
      m.message_type  AS last_message_type,
      m.file_name     AS last_file_name,
      (
        SELECT COUNT(*) FROM messages mu
        WHERE mu.sender_id = u.id
          AND mu.receiver_id = @me
          AND mu.status <> 'read'
      ) AS unread
    FROM contacts c
    JOIN users u ON u.id = c.contact_user_id
    JOIN messages m ON m.id = (
      SELECT mm.id FROM messages mm
      WHERE (mm.sender_id = @me AND mm.receiver_id = u.id)
         OR (mm.sender_id = u.id AND mm.receiver_id = @me)
      ORDER BY mm.created_at DESC, mm.id DESC
      LIMIT 1
    )
    WHERE c.user_id = @me
    ORDER BY m.created_at DESC, m.id DESC
  `).all({ me: userId });
}

// ---------- Call history ----------
function createCall({
  callerId,
  receiverId,
  callType,
  status,
  startedAt = null,
  endedAt = null,
  durationSeconds = null,
}) {
  const type = callType === 'video' ? 'video' : 'voice';
  const st = ['missed', 'answered', 'declined'].includes(status) ? status : 'missed';
  const info = db.prepare(`
    INSERT INTO calls (
      caller_id, receiver_id, call_type, status,
      started_at, ended_at, duration_seconds
    )
    VALUES (
      @callerId, @receiverId, @callType, @status,
      COALESCE(@startedAt, datetime('now')),
      @endedAt,
      @durationSeconds
    )
  `).run({
    callerId,
    receiverId,
    callType: type,
    status: st,
    startedAt,
    endedAt,
    durationSeconds,
  });
  return getCallById(info.lastInsertRowid);
}

function getCallById(id) {
  return db.prepare('SELECT * FROM calls WHERE id = ?').get(id);
}

function updateCall(id, { status, endedAt = null, durationSeconds = null }) {
  const row = getCallById(id);
  if (!row) return null;
  const st = status && ['missed', 'answered', 'declined'].includes(status) ? status : row.status;
  db.prepare(`
    UPDATE calls
    SET status = @status,
        ended_at = COALESCE(@endedAt, ended_at, datetime('now')),
        duration_seconds = COALESCE(@durationSeconds, duration_seconds)
    WHERE id = @id
  `).run({
    id,
    status: st,
    endedAt,
    durationSeconds,
  });
  return getCallById(id);
}

// Calls I made or received, newest first, with the other person's profile.
function getCallHistory(userId) {
  return db.prepare(`
    SELECT
      c.id,
      c.caller_id,
      c.receiver_id,
      c.call_type,
      c.status,
      c.started_at,
      c.ended_at,
      c.duration_seconds,
      u.id           AS other_id,
      u.display_name AS other_name,
      u.email        AS other_email,
      u.avatar_url   AS other_avatar
    FROM calls c
    JOIN users u ON u.id = CASE
      WHEN c.caller_id = @me THEN c.receiver_id
      ELSE c.caller_id
    END
    WHERE c.caller_id = @me OR c.receiver_id = @me
    ORDER BY c.started_at DESC, c.id DESC
  `).all({ me: userId });
}

module.exports = {
  db,
  createUser,
  getUserByEmail,
  getUserById,
  DEFAULT_ABOUT,
  PRIVACY_VALUES,
  PRIVACY_FIELDS,
  getOwnProfile,
  updateUserAbout,
  updateUserAvatar,
  updateUserPrivacy,
  getPrivacyExceptions,
  getPrivacySettings,
  // presence
  setUserOnline,
  setUserOffline,
  getContactOwners,
  // contacts
  addContact,
  getContact,
  getContacts,
  // messages
  createMessage,
  getMessageById,
  toPublicMessage,
  createCallThreadMessage,
  getConversationTimeline,
  getMessagesBetween,
  updateMessageStatus,
  getUnreadCount,
  markConversationRead,
  markMessagesDeliveredForReceiver,
  getConversations,
  // calls
  createCall,
  getCallById,
  updateCall,
  getCallHistory,
};
