// privacy.js
// Shared helper: should viewerId be allowed to see ownerId's `field`?
// Used by REST profile routes and (later) Socket.IO presence broadcasts.
// Never rely on the frontend alone to hide private fields.

/**
 * @param {number} viewerId
 * @param {number} ownerId
 * @param {'avatar'|'about'|'last_seen'|'status'} field
 * @param {string} privacyValue  everyone | contacts | contacts_except | nobody
 * @param {boolean} isContact    true if viewer has owner in contacts (or vice-versa for presence watchers)
 * @param {number[]} exceptionUserIds  excluded_user_id list when privacy is contacts_except
 */
function canView(viewerId, ownerId, field, privacyValue, isContact, exceptionUserIds = []) {
  if (Number(viewerId) === Number(ownerId)) return true;

  const value = privacyValue || 'everyone';
  if (value === 'everyone') return true;
  if (value === 'nobody') return false;
  if (value === 'contacts') return !!isContact;
  if (value === 'contacts_except') {
    if (!isContact) return false;
    const excluded = new Set((exceptionUserIds || []).map(Number));
    return !excluded.has(Number(viewerId));
  }
  // Unknown setting → fail closed.
  return false;
}

module.exports = { canView };
