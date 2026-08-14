// api.js
// REST routes for contacts, conversations, calls history, and messages.
// Mounted in server.js as: app.use('/api', api)
// Every route requires a valid JWT (via requireAuth), so req.user is always
// the logged-in user.
//
// Messaging is ALSO handled over Socket.IO for real-time delivery; the
// POST /api/messages route exists mainly so a client can send without a
// socket, and GET is used to load history when a conversation is opened.

const express = require('express');
const db = require('./db');
const presence = require('./presence');
const { requireAuth } = require('./auth');
const { visibleProfileFor } = require('./profile');

const router = express.Router();
router.use(requireAuth);

// Apply privacy to a contact/conversation row for the logged-in viewer.
function publicContactFields(viewerId, ownerId, base = {}) {
  const owner = db.getUserById(ownerId);
  if (!owner) {
    return {
      ...base,
      avatar: null,
      avatar_url: null,
      about: null,
      online: false,
      last_seen: null,
    };
  }
  const visible = visibleProfileFor(viewerId, owner);
  // Single source for online: live presence map when last-seen is visible,
  // otherwise force offline so we never leak presence via REST.
  const online = visible.last_seen_hidden
    ? false
    : presence.isOnline(ownerId);
  return {
    ...base,
    avatar: visible.avatar_url || null,
    avatar_url: visible.avatar_url || null,
    about: visible.about || null,
    online,
    last_seen: visible.last_seen || null,
  };
}

// ---------- Contacts ----------

// POST /api/contacts  { email }
// Add someone to my contact list by their email.
router.post('/contacts', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const target = db.getUserByEmail(email);
  if (!target) {
    return res.status(404).json({ error: 'No user found with that email' });
  }
  if (target.id === req.user.id) {
    return res.status(400).json({ error: "You can't add yourself" });
  }
  if (db.getContact(req.user.id, target.id)) {
    return res.status(409).json({ error: 'This person is already in your contacts' });
  }

  db.addContact(req.user.id, target.id);
  const fields = publicContactFields(req.user.id, target.id, {
    id: target.id,
    email: target.email,
    display_name: target.display_name,
  });
  res.status(201).json({
    contact: fields,
  });
});

// GET /api/contacts
// List my contacts, each tagged with their current online/offline status.
router.get('/contacts', (req, res) => {
  const contacts = db.getContacts(req.user.id).map((c) =>
    publicContactFields(req.user.id, c.id, {
      id: c.id,
      email: c.email,
      display_name: c.display_name,
      added_at: c.added_at,
      unread: c.unread,
    })
  );
  res.json({ contacts });
});

// GET /api/conversations
// "Recent Chats": one entry per contact I've exchanged messages with, each
// with the contact's id/name/avatar, the most recent message (text + time),
// and how many unread messages they've sent me. Newest conversation first.
router.get('/conversations', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const conversations = db.getConversations(req.user.id).map((c) => {
    const fields = publicContactFields(req.user.id, c.contact_id, {
      id: c.contact_id,
      name: c.display_name,
      email: c.email,
      display_name: c.display_name,
      unread: c.unread,
      last_message: {
        text: c.last_text,
        created_at: c.last_at,
        from_me: c.last_sender_id === req.user.id,
        status: c.last_status,
        message_type: c.last_message_type || 'text',
        file_name: c.last_file_name || null,
      },
    });
    return fields;
  });
  res.json({ conversations });
});

// ---------- Calls ----------

// GET /api/calls — my call history (made + received), newest first.
router.get('/calls', (req, res) => {
  const calls = db.getCallHistory(req.user.id).map((c) => ({
    id: c.id,
    caller_id: c.caller_id,
    receiver_id: c.receiver_id,
    call_type: c.call_type,
    status: c.status,
    started_at: c.started_at,
    ended_at: c.ended_at,
    duration_seconds: c.duration_seconds,
    direction: c.caller_id === req.user.id ? 'outgoing' : 'incoming',
    other: {
      id: c.other_id,
      name: c.other_name,
      display_name: c.other_name,
      email: c.other_email,
      avatar: c.other_avatar,
    },
  }));
  res.json({ calls });
});

// ---------- Messages ----------

// GET /api/messages/:contactId
// Full conversation timeline between me and the contact (messages + call events).
router.get('/messages/:contactId', (req, res) => {
  const contactId = Number(req.params.contactId);
  if (!Number.isInteger(contactId)) {
    return res.status(400).json({ error: 'Invalid contact id' });
  }
  if (!db.getContact(req.user.id, contactId)) {
    // #region agent log
    fetch('http://127.0.0.1:7304/ingest/f7240f87-4c83-4789-8af7-2ec9bebdbade',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'9e2c42'},body:JSON.stringify({sessionId:'9e2c42',runId:'fix2',hypothesisId:'E',location:'api.js:GET /messages/:contactId',message:'reject history: not a contact',data:{userId:req.user.id,contactId},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    return res.status(403).json({ error: 'You can only view conversations with your contacts' });
  }
  // #region agent log
  fetch('http://127.0.0.1:7304/ingest/f7240f87-4c83-4789-8af7-2ec9bebdbade',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'9e2c42'},body:JSON.stringify({sessionId:'9e2c42',runId:'fix2',hypothesisId:'F',location:'api.js:GET /messages/:contactId',message:'allow history: contact ok',data:{userId:req.user.id,contactId},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  res.setHeader('Cache-Control', 'no-store');
  const messages = db.getConversationTimeline(req.user.id, contactId);
  res.json({ messages });
});

// POST /api/messages  { receiverId, text, messageType?, fileUrl?, ... }
router.post('/messages', (req, res) => {
  const receiverId = Number(req.body.receiverId);
  const text = (req.body.text || '').trim();
  const messageType = req.body.messageType || req.body.message_type || 'text';
  const fileUrl = req.body.fileUrl || req.body.file_url || null;

  if (!Number.isInteger(receiverId)) {
    return res.status(400).json({ error: 'receiverId is required' });
  }
  if (messageType === 'text' && !text) {
    return res.status(400).json({ error: 'Message text is required' });
  }
  if (messageType !== 'text' && !fileUrl) {
    return res.status(400).json({ error: 'fileUrl is required for media messages' });
  }
  if (!db.getUserById(receiverId)) {
    return res.status(404).json({ error: 'Recipient does not exist' });
  }
  if (!db.getContact(req.user.id, receiverId)) {
    // #region agent log
    fetch('http://127.0.0.1:7304/ingest/f7240f87-4c83-4789-8af7-2ec9bebdbade',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'9e2c42'},body:JSON.stringify({sessionId:'9e2c42',runId:'fix1',hypothesisId:'D',location:'api.js:POST /messages',message:'reject REST message: not a contact',data:{userId:req.user.id,receiverId},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    return res.status(403).json({ error: 'You can only message people in your contacts' });
  }

  const message = db.createMessage({
    senderId: req.user.id,
    receiverId,
    text,
    status: 'sent',
    messageType,
    fileUrl,
    thumbnailUrl: req.body.thumbnailUrl || req.body.thumbnail_url || null,
    fileName: req.body.fileName || req.body.file_name || null,
    fileSize: req.body.fileSize || req.body.file_size || null,
  });
  res.status(201).json({ message });
});

module.exports = router;
