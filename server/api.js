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
const EventEmitter = require('events');
const db = require('./db');
const presence = require('./presence');
const { requireAuth } = require('./auth');
const { visibleProfileFor } = require('./profile');
const groupImage = require('./groupImage');

const router = express.Router();
router.use(requireAuth);
router.groupEvents = new EventEmitter();

const GROUP_NAME_MAX = 50;
const GROUP_DESCRIPTION_MAX = 139;

function toGroupResponse(group) {
  if (!group) return null;
  const groupId = group.groupId || group.id;
  const members = Array.isArray(group.members) ? group.members : [];
  const memberCount = group.member_count != null
    ? Number(group.member_count)
    : members.length;
  const creatorId = Number(group.creator_id);
  const profileImage = group.avatar_url || null;
  return {
    id: groupId,
    groupId,
    name: group.name,
    description: group.description || '',
    profileImage,
    avatar_url: profileImage,
    imageUrl: profileImage,
    createdBy: creatorId,
    creator_id: creatorId,
    createdAt: group.created_at || null,
    created_at: group.created_at || null,
    updatedAt: group.updated_at || group.created_at || null,
    updated_at: group.updated_at || group.created_at || null,
    memberCount,
    member_count: memberCount,
    members,
    last_text: group.last_text,
    last_at: group.last_at,
    last_sender_id: group.last_sender_id,
  };
}

function validateGroupEditor(groupId, userId) {
  const existing = db.getGroupById(groupId);
  if (!existing) return { status: 404, error: 'Group not found.' };
  if (!db.isGroupMember(groupId, userId)) {
    return { status: 403, error: 'You do not have permission to access this group.' };
  }
  if (!db.isGroupCreator(groupId, userId)) {
    return { status: 403, error: 'You do not have permission to edit this group.' };
  }
  return { group: existing };
}

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
  const groups = db.getGroupsForUser(req.user.id).map(toGroupResponse);
  res.json({ conversations, groups });
});

// ---------- Groups ----------

// POST /api/groups { name, memberIds }
router.post('/groups', (req, res) => {
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim();
  const memberIds = Array.isArray(req.body.memberIds)
    ? [...new Set(req.body.memberIds.map(Number))]
    : [];
  if (!name || name.length > GROUP_NAME_MAX || description.length > GROUP_DESCRIPTION_MAX) {
    return res.status(400).json({ error: 'Group name is required and description must be 139 characters or fewer' });
  }
  if (memberIds.length < 1 || memberIds.some((id) => !Number.isInteger(id) || id === req.user.id)) {
    return res.status(400).json({ error: 'Choose at least one valid group member' });
  }
  for (const memberId of memberIds) {
    if (!db.getUserById(memberId)) return res.status(404).json({ error: 'A selected user does not exist' });
    if (!db.getContact(req.user.id, memberId)) {
      return res.status(403).json({ error: 'You can only add your contacts to a group' });
    }
  }
  const group = db.createGroup({ name, description, creatorId: req.user.id, memberIds });
  res.status(201).json({ group: toGroupResponse(group) });
});

// GET /api/groups
router.get('/groups', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ groups: db.getGroupsForUser(req.user.id).map(toGroupResponse) });
});

// GET /api/groups/:groupId
router.get('/groups/:groupId', (req, res) => {
  const groupId = String(req.params.groupId);
  const group = db.getGroupForUser(groupId, req.user.id);
  if (!group) {
    const exists = db.getGroupById(groupId);
    if (!exists) return res.status(404).json({ error: 'Group not found.' });
    return res.status(403).json({ error: 'You do not have permission to access this group.' });
  }
  res.json({ group: toGroupResponse(group) });
});

function updateGroupInfoHandler(req, res) {
  const groupId = String(req.params.groupId);
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim();
  const auth = validateGroupEditor(groupId, req.user.id);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  if (!name) return res.status(400).json({ error: 'Group name is required.' });
  if (name.length > GROUP_NAME_MAX) {
    return res.status(400).json({ error: `Group name must be ${GROUP_NAME_MAX} characters or fewer.` });
  }
  if (description.length > GROUP_DESCRIPTION_MAX) {
    return res.status(400).json({ error: `Description must be ${GROUP_DESCRIPTION_MAX} characters or fewer.` });
  }

  try {
    db.updateGroupInfo(groupId, { name, description });
    const group = db.getGroupForUser(groupId, req.user.id);
    if (!group) return res.status(404).json({ error: 'Group not found.' });
    const payload = toGroupResponse(group);
    router.groupEvents.emit('updated', { groupId: payload.groupId, group: payload });
    return res.json({ group: payload });
  } catch (err) {
    console.error('[api] failed to update group information:', {
      groupId,
      userId: req.user.id,
      error: err && err.stack ? err.stack : err,
    });
    return res.status(500).json({ error: 'Failed to update group information.' });
  }
}

// PUT /api/groups/:groupId { name, description }
router.put('/groups/:groupId', updateGroupInfoHandler);
// PATCH alias for backward compatibility.
router.patch('/groups/:groupId', updateGroupInfoHandler);

function handleGroupImageUpload(req, res) {
  groupImage.upload.single('avatar')(req, res, async (err) => {
    const groupId = String(req.params.groupId);
    const auth = validateGroupEditor(groupId, req.user.id);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });

    if (err && err.name === 'MulterError') {
      return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
        error: err.code === 'LIMIT_FILE_SIZE'
          ? 'Image is too large. Maximum size is 5MB.'
          : err.message,
      });
    }
    if (err) return res.status(400).json({ error: err.message || 'Upload failed.' });
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'No image uploaded. Use form field "avatar".' });
    }

    try {
      const avatarUrl = await groupImage.saveGroupImage(groupId, req.file.buffer);
      db.updateGroupAvatar(groupId, avatarUrl);
      const group = db.getGroupForUser(groupId, req.user.id);
      if (!group) return res.status(404).json({ error: 'Group not found.' });
      const payload = toGroupResponse(group);
      router.groupEvents.emit('updated', { groupId: payload.groupId, group: payload });
      return res.status(201).json({ group: payload, profileImage: payload.profileImage });
    } catch (processErr) {
      console.error('[api] failed to update group image:', {
        groupId,
        userId: req.user.id,
        error: processErr && processErr.stack ? processErr.stack : processErr,
      });
      const status = processErr.status || 500;
      return res.status(status).json({
        error: status === 500 ? 'Failed to update group image.' : processErr.message,
      });
    }
  });
}

// PUT /api/groups/:groupId/image  multipart field "avatar"
router.put('/groups/:groupId/image', handleGroupImageUpload);

// POST alias for clients still using POST semantics.
router.post('/groups/:groupId/image', handleGroupImageUpload);

// POST /api/groups/:groupId/members { userId }
router.post('/groups/:groupId/members', (req, res) => {
  const groupId = String(req.params.groupId);
  const requestedIds = Array.isArray(req.body.userIds) ? req.body.userIds : [req.body.userId];
  const userIds = [...new Set(requestedIds.map(Number))];
  if (!db.isGroupCreator(groupId, req.user.id)) {
    return res.status(403).json({ error: 'Only the group creator can manage members' });
  }
  if (!userIds.length || userIds.some((userId) => !Number.isInteger(userId))) {
    return res.status(400).json({ error: 'Select at least one valid user' });
  }
  if (userIds.some((userId) => !db.getUserById(userId))) {
    return res.status(404).json({ error: 'One or more selected users do not exist' });
  }
  if (userIds.some((userId) => db.isGroupMember(groupId, userId))) {
    return res.status(409).json({ error: 'One or more selected users are already in the group' });
  }
  userIds.forEach((userId) => db.addGroupMember(groupId, userId));
  const group = db.getGroupForUser(groupId, req.user.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const payload = toGroupResponse(group);
  userIds.forEach((userId) => router.groupEvents.emit('added', { group: payload, userId }));
  res.status(201).json({ group: payload });
});

// DELETE /api/groups/:groupId/members/:userId — creator removes a member.
router.delete('/groups/:groupId/members/:userId', (req, res) => {
  const groupId = String(req.params.groupId);
  const userId = Number(req.params.userId);
  if (!db.isGroupCreator(groupId, req.user.id)) {
    return res.status(403).json({ error: 'Only the group creator can remove members' });
  }
  if (!Number.isInteger(userId) || userId === req.user.id) {
    return res.status(400).json({ error: 'The creator cannot be removed' });
  }
  if (!db.isGroupMember(groupId, userId)) {
    return res.status(404).json({ error: 'Member not found' });
  }
  db.removeGroupMember(groupId, userId);
  router.groupEvents.emit('removed', { groupId, userId });
  res.json({ ok: true, groupId, userId });
});

// POST /api/groups/:groupId/leave — any member may leave; the creator must delete.
router.post('/groups/:groupId/leave', (req, res) => {
  const groupId = String(req.params.groupId);
  if (!db.isGroupMember(groupId, req.user.id)) {
    return res.status(404).json({ error: 'Group not found' });
  }
  const result = db.leaveGroup(groupId, req.user.id);
  router.groupEvents.emit(result.deleted ? 'deleted' : 'left', { groupId, userId: req.user.id });
  res.json({ ok: true, groupId });
});

// DELETE /api/groups/:groupId — creator-only, with SQLite cascades removing members/messages.
router.delete('/groups/:groupId', (req, res) => {
  const groupId = String(req.params.groupId);
  if (!db.isGroupCreator(groupId, req.user.id)) {
    return res.status(403).json({ error: 'Only the group creator can delete the group' });
  }
  if (!db.deleteGroup(groupId)) return res.status(404).json({ error: 'Group not found' });
  router.groupEvents.emit('deleted', { groupId });
  res.json({ ok: true, groupId });
});

// GET /api/groups/:groupId/messages
router.get('/groups/:groupId/messages', (req, res) => {
  const group = db.getGroupForUser(req.params.groupId, req.user.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ group: toGroupResponse(group), messages: db.getGroupTimeline(req.params.groupId, req.user.id) });
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
  const groupId = req.body.groupId || req.body.group_id || null;
  const receiverId = Number(req.body.receiverId);
  const text = (req.body.text || '').trim();
  const messageType = req.body.messageType || req.body.message_type || 'text';
  const fileUrl = req.body.fileUrl || req.body.file_url || null;

  if (groupId) {
    if (!db.getGroupForUser(groupId, req.user.id)) {
      return res.status(403).json({ error: 'You must belong to this group' });
    }
    if (messageType === 'text' && !text) {
      return res.status(400).json({ error: 'Message text is required' });
    }
    if (messageType !== 'text' && !fileUrl) {
      return res.status(400).json({ error: 'fileUrl is required for media messages' });
    }
    const message = db.createMessage({
      senderId: req.user.id,
      groupId,
      text,
      status: 'sent',
      messageType,
      fileUrl,
      thumbnailUrl: req.body.thumbnailUrl || req.body.thumbnail_url || null,
      fileName: req.body.fileName || req.body.file_name || null,
      fileSize: req.body.fileSize || req.body.file_size || null,
    });
    return res.status(201).json({ message });
  }

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
