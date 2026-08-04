// auth.js
// Everything about "who is this user":
//   - hashing passwords (never store plain text)
//   - signing/verifying JWTs (the token the browser keeps after logging in)
//   - the /signup and /login HTTP routes
//   - middleware that protects routes and a helper to authenticate sockets
//
// A JWT is just a signed string. When a user logs in we hand them a token that
// says "user id = 5". They send it back on every request; we verify the
// signature to trust it. No server-side session storage needed.

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

// Never fall back to a hardcoded secret — if .env is missing, fail loudly
// so production cannot accidentally sign tokens with a known default.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || !String(JWT_SECRET).trim()) {
  throw new Error(
    'JWT_SECRET is required. Copy .env.example to .env and set a long random secret.'
  );
}
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

// ---------- Token helpers ----------
function signToken(user) {
  // Keep the payload tiny: just enough to identify the user.
  return jwt.sign(
    { id: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

// Very light email sanity check — good enough to catch obvious typos.
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Returns the decoded payload, or null if the token is missing/invalid/expired.
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ---------- Express middleware ----------
// Attaches req.user (the safe public user row) or responds 401.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token && verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const user = db.getUserById(payload.id);
  if (!user) {
    return res.status(401).json({ error: 'User no longer exists' });
  }
  req.user = user;
  next();
}

// ---------- Routes ----------
const router = express.Router();

// POST /api/auth/signup  { email, displayName, password }
router.post('/signup', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  // Fall back to the part before the "@" if no display name is given.
  const displayName = (req.body.displayName || '').trim() || email.split('@')[0];
  const password = req.body.password || '';

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (db.getUserByEmail(email)) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = db.createUser({ email, displayName, passwordHash });
  const token = signToken(user);
  res.status(201).json({ token, user });
});

// POST /api/auth/login  { email, password }
router.post('/login', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  const row = db.getUserByEmail(email);
  const match = row ? await bcrypt.compare(password, row.password_hash) : false;

  // Same generic error whether the email or password is wrong, so we don't
  // reveal which emails have accounts.
  if (!row || !match) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const user = db.getUserById(row.id);
  const token = signToken(user);
  res.json({ token, user });
});

module.exports = {
  router,
  requireAuth,
  verifyToken,
  signToken,
};
