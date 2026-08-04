// welcome.js (frontend)
// The marketing landing page. If the visitor is already logged in there's no
// reason to show it — send them straight into the app.

if (getToken()) {
  window.location.replace('/chat.html');
}
