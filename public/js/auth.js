// auth.js (frontend)
// Drives the login/signup screen: switching between the two forms, the
// password show/hide toggle, "keep me logged in", and posting to the API.
// Requires session.js to be loaded first (getToken / saveSession).

const loginForm = document.getElementById('login-form');
const signupForm = document.getElementById('signup-form');
const messageEl = document.getElementById('message');
const titleEl = document.getElementById('auth2-title');
const subtitleEl = document.getElementById('auth2-subtitle');
const switchLogin = document.querySelector('[data-mode="login"]');
const switchSignup = document.querySelector('[data-mode="signup"]');

// Already logged in? Skip straight to the app.
if (getToken()) {
  window.location.replace('/chat.html');
}

function showMode(mode) {
  const login = mode === 'login';
  loginForm.classList.toggle('hidden', !login);
  signupForm.classList.toggle('hidden', login);
  switchLogin.classList.toggle('hidden', !login);
  switchSignup.classList.toggle('hidden', login);
  titleEl.textContent = login ? 'Welcome back' : 'Create your account';
  subtitleEl.textContent = login
    ? 'Enter your details to access your account'
    : 'Just a username and password to get started';
  messageEl.textContent = '';
}

document.getElementById('go-signup').addEventListener('click', (e) => { e.preventDefault(); showMode('signup'); });
document.getElementById('go-login').addEventListener('click', (e) => { e.preventDefault(); showMode('login'); });

// Arriving from the welcome page's "Get Started" opens signup.
if (window.location.hash === '#signup') {
  showMode('signup');
}

// Password show/hide toggles.
document.querySelectorAll('.pw-toggle').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = btn.parentElement.querySelector('input');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.classList.toggle('active', show);
  });
});

// Elements that aren't wired to a backend yet just say so.
document.querySelectorAll('[data-soon]').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    showInfo(`${el.dataset.soon} isn't set up yet.`);
  });
});
document.querySelectorAll('.social-btn').forEach((btn) => {
  btn.addEventListener('click', () => showInfo(`${btn.dataset.provider} sign-in isn't set up yet.`));
});

async function completeGoogleLogin(credential, remember = true) {
  messageEl.textContent = '';
  try {
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    const data = await res.json();
    if (!res.ok) {
      showError(data.error || 'Google sign-in failed');
      return;
    }
    saveSession(data.token, data.user, remember);
    window.location.href = '/chat.html';
  } catch {
    showError('Could not reach the server');
  }
}

function showGoogleFallback(slot, text) {
  slot.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'google-signin-fallback';
  el.title = text;
  el.innerHTML = `
    <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.2 13.2 17.6 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9.1h12.4c-.5 2.9-2.1 5.3-4.6 7l7.1 5.5c4.2-3.9 6.6-9.6 6.6-16.5z"/><path fill="#FBBC05" d="M10.4 28.3c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.8-6.1C1 16.1 0 19.9 0 24s1 7.9 2.6 11.1l7.8-6.8z"/><path fill="#34A853" d="M24 48c6.2 0 11.5-2 15.3-5.5l-7.1-5.5c-2 1.4-4.6 2.2-8.2 2.2-6.4 0-11.8-3.7-13.6-9.8l-7.8 6.1C6.5 42.6 14.6 48 24 48z"/></svg>
    Google
  `;
  el.addEventListener('click', () => showInfo(text));
  slot.appendChild(el);
}

function initGoogleSignIn() {
  const slot = document.getElementById('google-signin-slot');
  if (!slot) return;

  fetch('/api/auth/google/config')
    .then((r) => r.json())
    .then((config) => {
      if (!config.enabled || !config.clientId) {
        showGoogleFallback(
          slot,
          'Add GOOGLE_CLIENT_ID to your .env file to enable Google sign-in.'
        );
        return;
      }

      function renderButton() {
        if (!window.google || !google.accounts || !google.accounts.id) {
          showGoogleFallback(slot, 'Google sign-in failed to load. Refresh the page.');
          return;
        }
        google.accounts.id.initialize({
          client_id: config.clientId,
          callback: (response) => {
            const remember = document.querySelector('#login-form [name="remember"]')?.checked !== false;
            completeGoogleLogin(response.credential, remember);
          },
          auto_select: false,
          cancel_on_tap_outside: true,
        });
        slot.innerHTML = '';
        google.accounts.id.renderButton(slot, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          width: Math.min(320, slot.offsetWidth || 320),
        });
      }

      if (window.google && google.accounts && google.accounts.id) {
        renderButton();
      } else {
        window.addEventListener('load', renderButton, { once: true });
      }
    })
    .catch(() => {
      showGoogleFallback(slot, 'Could not load Google sign-in settings.');
    });
}

initGoogleSignIn();

function showInfo(text) {
  messageEl.textContent = text;
  messageEl.className = 'message';
}
function showError(text) {
  messageEl.textContent = text;
  messageEl.className = 'message error';
}

async function submitAuth(endpoint, body, remember) {
  messageEl.textContent = '';
  try {
    const res = await fetch(`/api/auth/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      showError(data.error || 'Something went wrong');
      return;
    }
    saveSession(data.token, data.user, remember);
    window.location.href = '/chat.html';
  } catch {
    showError('Could not reach the server');
  }
}

// DEV ONLY: seed demo data and jump straight into a populated dashboard.
// The button is hidden unless /api/dev/status responds (NODE_ENV !== production).
const seedBtn = document.getElementById('seed-demo');
if (seedBtn) {
  seedBtn.hidden = true;
  fetch('/api/dev/status')
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data || !data.seed) return;
      seedBtn.hidden = false;
    })
    .catch(() => {});

  seedBtn.addEventListener('click', async () => {
    seedBtn.disabled = true;
    seedBtn.textContent = 'Seeding…';
    try {
      const res = await fetch('/api/dev/seed-demo-data', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        showError(data.error || 'Seeding failed');
        seedBtn.disabled = false;
        seedBtn.textContent = '⚙ DEV: Seed demo data & preview';
        return;
      }
      saveSession(data.token, data.user, true);
      window.location.href = '/chat.html';
    } catch {
      showError('Could not reach the server');
      seedBtn.disabled = false;
      seedBtn.textContent = '⚙ DEV: Seed demo data & preview';
    }
  });
}

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(loginForm);
  submitAuth('login', {
    email: f.get('email'),
    password: f.get('password'),
  }, f.get('remember') === 'on');
});

signupForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(signupForm);
  // New accounts are remembered by default.
  submitAuth('signup', {
    email: f.get('email'),
    displayName: f.get('displayName'),
    password: f.get('password'),
  }, true);
});
