// splash.js (frontend)
// Shows the branded splash for a short beat, then routes on:
//   - logged in (token present)  -> the chat app
//   - otherwise                  -> the welcome/landing page
// The token is only checked for existence here; the destination page fully
// validates it against the server (and bounces back to login if it's stale).

const SPLASH_MS = 1800;

setTimeout(() => {
  const dest = getToken() ? '/chat.html' : '/welcome.html';
  window.location.replace(dest);
}, SPLASH_MS);
