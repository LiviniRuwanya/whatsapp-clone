// dev.js  — DEV-ONLY helpers. Safe to delete this whole file later.
// Mounted at /api/dev only when NODE_ENV !== 'production' (see server.js).
//
// POST /api/dev/seed-demo-data
//   Creates a brand-new demo account plus a handful of fake contacts with
//   sample conversations (varied timestamps + unread counts), then returns a
//   login token so the caller lands on a populated dashboard. Purely for
//   previewing the UI.

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('./db');
const presence = require('./presence');
const { signToken } = require('./auth');

const router = express.Router();

// Extra guard on top of the conditional mount in server.js.
router.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Demo seeding is disabled in production' });
  }
  next();
});

// Store timestamps in the same shape as SQLite's datetime('now'): UTC,
// "YYYY-MM-DD HH:MM:SS" (no timezone), so ordering matches real messages.
function dbTime(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

// Each contact: their profile, whether we fake them as "online", and a small
// script of messages (from 'me' = demo user, or 'them' = the contact).
const DEMO_CONTACTS = [
  {
    name: 'Elena Fox',
    online: true,
    messages: [
      { from: 'me', text: 'Hey Elena! Lunch today?', minsAgo: 45, read: true },
      { from: 'them', text: 'Are we still on for lunch? 🍜', minsAgo: 12, read: false },
      { from: 'them', text: 'Let me know!', minsAgo: 11, read: false },
    ],
  },
  {
    name: 'Julian Rivers',
    online: true,
    messages: [
      { from: 'them', text: "I'll send the report by EOD. Let me know when you get a chance.", minsAgo: 90, read: false },
    ],
  },
  {
    name: 'Sarah Jenkins',
    online: false,
    messages: [
      { from: 'me', text: 'Pushed the fix, can you review?', minsAgo: 60 * 26, read: true },
      { from: 'them', text: 'Thanks for the update! See you in the standup.', minsAgo: 60 * 25, read: true },
    ],
  },
  {
    name: 'Michael Scott',
    online: false,
    messages: [
      { from: 'them', text: 'Did it work?', minsAgo: 60 * 50, read: true },
      { from: 'me', text: "That's what she said!", minsAgo: 60 * 49, read: true },
    ],
  },
];

// Tiny probe so the login page can hide the Seed button if this router
// somehow isn't mounted (e.g. production).
router.get('/status', (req, res) => {
  res.json({ ok: true, seed: true, note: 'DEV ONLY — safe to delete server/dev.js' });
});

router.post('/seed-demo-data', async (req, res) => {
  try {
    const stamp = Date.now();
    const passwordHash = await bcrypt.hash('demo1234', 10);

    // The main demo user the caller will be logged in as.
    const meUser = db.createUser({
      email: `demo+${stamp}@chatconnect.dev`,
      displayName: 'Demo User',
      passwordHash,
    });

    const rawInsertMsg = db.db.prepare(`
      INSERT INTO messages (sender_id, receiver_id, text, status, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    DEMO_CONTACTS.forEach((c, i) => {
      const contact = db.createUser({
        email: `demo+${stamp}+${i}@chatconnect.dev`,
        displayName: c.name,
        passwordHash,
      });

      // Two-way contact link.
      db.addContact(meUser.id, contact.id);
      db.addContact(contact.id, meUser.id);

      // Fake presence so the "Online Now" strip has content to preview.
      // (In-memory only — gone on server restart, which is fine for demo.)
      if (c.online) {
        presence.addConnection(contact.id);
        db.setUserOnline(contact.id);
      }

      c.messages.forEach((m) => {
        const senderId = m.from === 'me' ? meUser.id : contact.id;
        const receiverId = m.from === 'me' ? contact.id : meUser.id;
        // Unread = a message the contact sent me that isn't read yet.
        const status = m.from === 'them' && !m.read ? 'delivered' : 'read';
        rawInsertMsg.run(senderId, receiverId, m.text, status, dbTime(m.minsAgo));
      });
    });

    // Sample call history so the Calls tab isn't empty in the demo.
    const contacts = db.getContacts(meUser.id);
    if (contacts[0]) {
      db.createCall({
        callerId: contacts[0].id,
        receiverId: meUser.id,
        callType: 'voice',
        status: 'missed',
        startedAt: dbTime(30),
        endedAt: dbTime(30),
        durationSeconds: null,
      });
    }
    if (contacts[1]) {
      db.createCall({
        callerId: meUser.id,
        receiverId: contacts[1].id,
        callType: 'video',
        status: 'answered',
        startedAt: dbTime(120),
        endedAt: dbTime(115),
        durationSeconds: 5 * 60,
      });
    }
    if (contacts[2]) {
      db.createCall({
        callerId: meUser.id,
        receiverId: contacts[2].id,
        callType: 'voice',
        status: 'declined',
        startedAt: dbTime(60 * 5),
        endedAt: dbTime(60 * 5),
        durationSeconds: null,
      });
    }

    const token = signToken(meUser);
    res.status(201).json({
      token,
      user: meUser,
      note: 'Demo data seeded. This route is dev-only.',
    });
  } catch (e) {
    console.error('[seed-demo-data] failed', e);
    res.status(500).json({ error: 'Seeding failed' });
  }
});

module.exports = router;
