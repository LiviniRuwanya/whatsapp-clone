// presence.js
// Tracks which user IDs currently have at least one live socket connected.
// It's just an in-memory set (resets when the server restarts), which is all
// we need for online/offline dots. The Socket.IO layer in server.js will call
// addConnection/removeConnection; the REST routes read isOnline().
//
// We count connections (not just a boolean) so a user open in two tabs stays
// "online" until the LAST tab disconnects.

const connectionCounts = new Map(); // userId -> number of open sockets

function addConnection(userId) {
  connectionCounts.set(userId, (connectionCounts.get(userId) || 0) + 1);
}

function removeConnection(userId) {
  const n = (connectionCounts.get(userId) || 0) - 1;
  if (n <= 0) connectionCounts.delete(userId);
  else connectionCounts.set(userId, n);
}

function isOnline(userId) {
  return connectionCounts.has(userId);
}

module.exports = { addConnection, removeConnection, isOnline };
