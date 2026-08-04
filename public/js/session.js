// session.js (frontend)
// One small place that owns the auth token + cached user, so "Keep me logged
// in" can choose WHERE to store them:
//   - remember = true  -> localStorage (survives closing the browser)
//   - remember = false -> sessionStorage (cleared when the tab closes)
// Every page reads through getToken()/getUser() so it doesn't care which store
// was used.

function saveSession(token, user, remember) {
  clearSession();
  const store = remember ? localStorage : sessionStorage;
  store.setItem('token', token);
  if (user) store.setItem('user', JSON.stringify(user));
}

function getToken() {
  return localStorage.getItem('token') || sessionStorage.getItem('token');
}

function getUser() {
  const raw = localStorage.getItem('user') || sessionStorage.getItem('user');
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearSession() {
  for (const store of [localStorage, sessionStorage]) {
    store.removeItem('token');
    store.removeItem('user');
  }
}
