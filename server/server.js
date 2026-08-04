// server.js
// The entrypoint. It wires together:
//   - Express (serves the frontend + the JSON API)
//   - the auth routes (signup/login)
//   - Socket.IO (real-time messaging, delivery/read receipts, presence)

require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { Server } = require('socket.io');

const auth = require('./auth');
const db = require('./db');
const presence = require('./presence');
const api = require('./api');
const upload = require('./upload');
const profile = require('./profile');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const IS_PROD = process.env.NODE_ENV === 'production';

app.use(cors());
app.use(express.json());

// ---------- Static frontend + uploaded media ----------
app.use(
  express.static(PUBLIC_DIR, {
    setHeaders(res) {
      if (!IS_PROD) {
        res.setHeader('Cache-Control', 'no-store');
      }
    },
  })
);
app.use('/uploads', express.static(upload.UPLOAD_ROOT));

// ---------- Auth API ----------
app.use('/api/auth', auth.router);

app.get('/api/me', auth.requireAuth, (req, res) => {
  res.json({ user: req.user });
});

if (process.env.NODE_ENV !== 'production') {
  app.use('/api/dev', require('./dev'));
  console.log('[dev] demo seeding enabled at POST /api/dev/seed-demo-data');
}

app.use('/api/upload', upload.router);
app.use('/api/profile', profile.router);
app.use('/api', api);

// ---------- Real-time layer ----------
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const payload = token && auth.verifyToken(token);
  if (!payload) return next(new Error('Not authenticated'));
  socket.data.userId = payload.id;
  socket.data.email = payload.email;
  next();
});

// Pending/active calls live in memory; a `calls` row is written when the
// attempt ends (answered / declined / missed).
const activeCalls = new Map();

io.on('connection', (socket) => {
  const userId = socket.data.userId;

  socket.join(`user:${userId}`);
  socket.data.activeChat = null;

  const wasOffline = !presence.isOnline(userId);
  presence.addConnection(userId);
  if (wasOffline) {
    db.setUserOnline(userId);
    broadcastPresence(userId, { online: true, lastSeen: null });
  }
  console.log(`socket connected: ${socket.data.email} (user ${userId})`);

  // Anything still 'sent' addressed to this user is now delivered.
  const justDelivered = db.markMessagesDeliveredForReceiver(userId);
  for (const row of justDelivered) {
    io.to(`user:${row.sender_id}`).emit('message:status', {
      id: row.id,
      status: 'delivered',
    });
  }

  // Opening a chat marks that contact's messages to me as read and notifies them.
  socket.on('chat:open', (payload = {}) => {
    const contactId = payload.contactId ? Number(payload.contactId) : null;
    socket.data.activeChat = contactId;
    if (!contactId) return;

    const messageIds = db.markConversationRead(userId, contactId);
    if (messageIds.length > 0) {
      // Sender (contactId) learns which of their messages I just read.
      io.to(`user:${contactId}`).emit('messages:read', {
        by: userId,
        contactId: userId,
        messageIds,
      });
      // Also emit per-message status for UIs that listen that way.
      for (const id of messageIds) {
        io.to(`user:${contactId}`).emit('message:status', { id, status: 'read' });
      }
    }
  });

  // Send a text or media message. Media must already be uploaded via /api/upload.
  // The SAME serialized DB row is emitted to sender and receiver — no field drops.
  async function handleMessageSend(payload = {}, ack) {
    const receiverId = Number(payload.receiverId);
    const text = (payload.text || '').trim();
    const messageType = payload.messageType || payload.message_type || 'text';
    const fileUrl = payload.fileUrl || payload.file_url || null;
    const thumbnailUrl = payload.thumbnailUrl || payload.thumbnail_url || null;
    const fileName = payload.fileName || payload.file_name || null;
    const fileSize = payload.fileSize != null
      ? Number(payload.fileSize)
      : (payload.file_size != null ? Number(payload.file_size) : null);

    if (!Number.isInteger(receiverId)) {
      if (typeof ack === 'function') ack({ error: 'receiverId is required' });
      return;
    }
    if (!db.getContact(userId, receiverId)) {
      // #region agent log
      fetch('http://127.0.0.1:7304/ingest/f7240f87-4c83-4789-8af7-2ec9bebdbade',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'9e2c42'},body:JSON.stringify({sessionId:'9e2c42',runId:'fix1',hypothesisId:'A',location:'server.js:message:send',message:'reject message: not a contact',data:{userId,receiverId},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      if (typeof ack === 'function') ack({ error: 'You can only message people in your contacts' });
      return;
    }
    if (messageType === 'text' && !text) {
      if (typeof ack === 'function') ack({ error: 'text is required for text messages' });
      return;
    }
    if (messageType !== 'text' && !fileUrl) {
      if (typeof ack === 'function') ack({ error: 'fileUrl is required for media messages' });
      return;
    }

    // #region agent log
    fetch('http://127.0.0.1:7304/ingest/f7240f87-4c83-4789-8af7-2ec9bebdbade',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'9e2c42'},body:JSON.stringify({sessionId:'9e2c42',runId:'fix1',hypothesisId:'B',location:'server.js:message:send',message:'allow message: contact ok',data:{userId,receiverId},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    let row = db.createMessage({
      senderId: userId,
      receiverId,
      text,
      status: 'sent',
      messageType,
      fileUrl,
      thumbnailUrl,
      fileName,
      fileSize,
    });

    let viewing = false;
    if (presence.isOnline(receiverId)) {
      viewing = await isViewingChat(receiverId, userId);
      row = db.updateMessageStatus(row.id, viewing ? 'read' : 'delivered');
    }

    // One canonical payload for both parties (media fields always present).
    const message = db.toPublicMessage(row);

    // Emit the identical object to sender + receiver rooms.
    io.to(`user:${message.sender_id}`).emit('message:new', message);
    io.to(`user:${message.receiver_id}`).emit('message:new', message);

    if (presence.isOnline(receiverId)) {
      if (!viewing) {
        const count = db.getUnreadCount(receiverId, userId);
        io.to(`user:${receiverId}`).emit('unread:update', { contactId: userId, count });
      } else if (message.status === 'read') {
        io.to(`user:${userId}`).emit('messages:read', {
          by: receiverId,
          contactId: receiverId,
          messageIds: [message.id],
        });
      }
    }

    if (message.status !== 'sent') {
      io.to(`user:${userId}`).emit('message:status', {
        id: message.id,
        status: message.status,
      });
    }
    if (typeof ack === 'function') ack({ message });
  }

  socket.on('message:send', handleMessageSend);

  // ---------- Voice / video call signaling (WebRTC media is peer-to-peer) ----------
  socket.on('call:invite', (payload = {}, ack) => {
    const receiverId = Number(payload.receiverId);
    const callType = payload.callType === 'video' ? 'video' : 'voice';
    if (!Number.isInteger(receiverId) || receiverId === userId) {
      if (typeof ack === 'function') ack({ error: 'Invalid receiver' });
      return;
    }
    if (!db.getContact(userId, receiverId)) {
      // #region agent log
      fetch('http://127.0.0.1:7304/ingest/f7240f87-4c83-4789-8af7-2ec9bebdbade',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'9e2c42'},body:JSON.stringify({sessionId:'9e2c42',runId:'fix1',hypothesisId:'C',location:'server.js:call:invite',message:'reject call: not a contact',data:{userId,receiverId},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      if (typeof ack === 'function') ack({ error: 'You can only call people in your contacts' });
      return;
    }

    // One ringing/active call at a time per user.
    if (findCallForUser(userId)) {
      if (typeof ack === 'function') ack({ error: 'Already in a call' });
      return;
    }

    const callId = `${userId}-${receiverId}-${Date.now()}`;
    const online = presence.isOnline(receiverId);
    const call = {
      id: callId,
      callerId: userId,
      receiverId,
      callType,
      state: 'ringing',
      createdAt: Date.now(),
      answeredAt: null,
      dbId: null,
      timeout: null,
      savedCall: null,
      threadMessage: null,
    };

    // Offline: don't wait 30s — miss immediately and tell the caller.
    if (!online) {
      finalizeCallRecord(call, 'missed');
      if (typeof ack === 'function') {
        ack({ callId, callType, receiverId, online: false });
      }
      io.to(`user:${userId}`).emit('call:ended', {
        callId,
        reason: 'no-answer',
        offline: true,
        call: call.savedCall || null,
      });
      return;
    }

    activeCalls.set(callId, call);

    call.timeout = setTimeout(() => {
      const current = activeCalls.get(callId);
      if (!current || current.state !== 'ringing') return;
      finalizeCallRecord(current, 'missed');
      activeCalls.delete(callId);
      io.to(`user:${current.callerId}`).emit('call:ended', {
        callId,
        reason: 'no-answer',
        offline: false,
        call: current.savedCall || null,
      });
      io.to(`user:${current.receiverId}`).emit('call:ended', {
        callId,
        reason: 'no-answer',
        offline: false,
        call: current.savedCall || null,
      });
    }, 30000);

    const caller = db.getUserById(userId);
    io.to(`user:${receiverId}`).emit('call:incoming', {
      callId,
      callType,
      from: {
        id: caller.id,
        name: caller.display_name,
        display_name: caller.display_name,
        email: caller.email,
        avatar: caller.avatar_url,
      },
    });

    if (typeof ack === 'function') {
      ack({ callId, callType, receiverId, online: true });
    }
  });

  socket.on('call:accept', (payload = {}) => {
    const callId = payload.callId;
    const call = activeCalls.get(callId);
    if (!call || call.receiverId !== userId || call.state !== 'ringing') return;

    clearTimeout(call.timeout);
    call.timeout = null;
    call.state = 'active';
    call.answeredAt = Date.now();

    io.to(`user:${call.callerId}`).emit('call:accepted', {
      callId,
      callType: call.callType,
      by: userId,
    });
    // Confirm to the accepter's other tabs too.
    io.to(`user:${call.receiverId}`).emit('call:accepted', {
      callId,
      callType: call.callType,
      by: userId,
    });
  });

  socket.on('call:decline', (payload = {}) => {
    const callId = payload.callId;
    const call = activeCalls.get(callId);
    if (!call || call.receiverId !== userId || call.state !== 'ringing') return;

    clearTimeout(call.timeout);
    finalizeCallRecord(call, 'declined');
    activeCalls.delete(callId);

    io.to(`user:${call.callerId}`).emit('call:declined', {
      callId,
      by: userId,
      call: call.savedCall || null,
    });
    io.to(`user:${call.receiverId}`).emit('call:ended', {
      callId,
      reason: 'declined',
      call: call.savedCall || null,
    });
  });

  // WebRTC signaling — relay only; media never touches the server.
  socket.on('call:offer', (payload = {}) => {
    const call = activeCalls.get(payload.callId);
    if (!call || !isCallParticipant(call, userId)) return;
    const target = userId === call.callerId ? call.receiverId : call.callerId;
    io.to(`user:${target}`).emit('call:offer', {
      callId: call.id,
      sdp: payload.sdp,
      from: userId,
    });
  });

  socket.on('call:answer', (payload = {}) => {
    const call = activeCalls.get(payload.callId);
    if (!call || !isCallParticipant(call, userId)) return;
    const target = userId === call.callerId ? call.receiverId : call.callerId;
    io.to(`user:${target}`).emit('call:answer', {
      callId: call.id,
      sdp: payload.sdp,
      from: userId,
    });
  });

  socket.on('call:ice-candidate', (payload = {}) => {
    const call = activeCalls.get(payload.callId);
    if (!call || !isCallParticipant(call, userId)) return;
    const target = userId === call.callerId ? call.receiverId : call.callerId;
    io.to(`user:${target}`).emit('call:ice-candidate', {
      callId: call.id,
      candidate: payload.candidate,
      from: userId,
    });
  });

  socket.on('call:end', (payload = {}) => {
    let call = payload.callId ? activeCalls.get(payload.callId) : null;
    // Cancel before invite ack: client may send callId=null — end this user's call.
    if (!call) call = findCallForUser(userId);
    if (!call || !isCallParticipant(call, userId)) return;

    clearTimeout(call.timeout);
    const status = call.state === 'active' ? 'answered' : 'missed';
    finalizeCallRecord(call, status);
    activeCalls.delete(call.id);

    const ended = {
      callId: call.id,
      reason: call.state === 'active' ? 'hangup' : 'cancelled',
      by: userId,
      call: call.savedCall || null,
    };
    io.to(`user:${call.callerId}`).emit('call:ended', ended);
    io.to(`user:${call.receiverId}`).emit('call:ended', ended);
  });

  socket.on('disconnect', () => {
    // If this user was ringing/in a call and this was their last socket, end it.
    presence.removeConnection(userId);
    if (!presence.isOnline(userId)) {
      const lastSeen = db.setUserOffline(userId);
      broadcastPresence(userId, { online: false, lastSeen });

      const call = findCallForUser(userId);
      if (call) {
        clearTimeout(call.timeout);
        const status = call.state === 'active' ? 'answered' : 'missed';
        finalizeCallRecord(call, status);
        activeCalls.delete(call.id);
        const ended = {
          callId: call.id,
          reason: 'disconnect',
          by: userId,
          call: call.savedCall || null,
        };
        io.to(`user:${call.callerId}`).emit('call:ended', ended);
        io.to(`user:${call.receiverId}`).emit('call:ended', ended);
      }
    }
    console.log(`socket disconnected: ${socket.data.email}`);
  });
});

function isCallParticipant(call, userId) {
  return call.callerId === userId || call.receiverId === userId;
}

function findCallForUser(userId) {
  for (const call of activeCalls.values()) {
    if (isCallParticipant(call, userId)) return call;
  }
  return null;
}

function finalizeCallRecord(call, status) {
  if (call.savedCall) return call.savedCall;
  const endedAt = new Date().toISOString();
  let durationSeconds = null;
  if (status === 'answered' && call.answeredAt) {
    durationSeconds = Math.max(1, Math.round((Date.now() - call.answeredAt) / 1000));
  }
  const startedAt = new Date(call.createdAt).toISOString().slice(0, 19).replace('T', ' ');
  const row = db.createCall({
    callerId: call.callerId,
    receiverId: call.receiverId,
    callType: call.callType,
    status,
    startedAt,
    endedAt: endedAt.slice(0, 19).replace('T', ' '),
    durationSeconds,
  });
  call.savedCall = row;

  // Inline thread event for BOTH participants (reuses messages pipeline).
  const threadMessage = db.createCallThreadMessage({
    callerId: call.callerId,
    receiverId: call.receiverId,
    callType: call.callType,
    status,
    durationSeconds,
    startedAt,
    callId: row.id,
  });
  call.threadMessage = threadMessage;
  io.to(`user:${call.callerId}`).emit('message:new', threadMessage);
  io.to(`user:${call.receiverId}`).emit('message:new', threadMessage);

  io.to(`user:${call.callerId}`).emit('calls:updated', { call: row });
  io.to(`user:${call.receiverId}`).emit('calls:updated', { call: row });
  return row;
}

async function isViewingChat(userId, contactId) {
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  return sockets.some((s) => Number(s.data.activeChat) === Number(contactId));
}

function broadcastPresence(userId, { online, lastSeen }) {
  const watchers = db.getContactOwners(userId);
  for (const watcherId of watchers) {
    io.to(`user:${watcherId}`).emit('presence:update', { userId, online, lastSeen });
  }
}

server.listen(PORT, () => {
  console.log(`WhatsApp-clone server running at http://localhost:${PORT}`);
});
