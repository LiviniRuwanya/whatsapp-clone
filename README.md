# ChatConnect

ChatConnect is a WhatsApp-inspired messaging application built with Node.js, Express, SQLite, and Socket.IO. It provides a working local chat experience with user authentication, contact management, real-time messaging, media upload support, profile customization, and privacy controls.

This project is designed as a practical MVP/demo app for learning full-stack chat application architecture and real-time communication patterns.

## Project overview

The app includes:

- Email/password authentication
- Google Sign-In support (optional)
- Contact management by email
- Recent chat list with unread messages
- Real-time message sending and delivery/read tracking
- Profile settings with avatar upload
- Privacy controls for profile visibility
- Media upload support for images, videos, and documents
- Call history (voice/video) tracking
- Online/offline presence

## Features

### Authentication
- User sign up and login with email and password
- JWT-based authentication for protected routes
- Google Sign-In integration using Google Identity Services
- Session persistence in browser storage

### Messaging
- Create and manage contacts
- View recent conversations
- Open a conversation and load its message history
- Send text messages and media messages
- Delivery / read status updates via Socket.IO
- Unread message counters per contact

### Profile and privacy
- Update display name
- Update profile bio / about text
- Upload and process avatar images
- Set privacy for avatar, about, last seen, and status-related fields
- Manage privacy exceptions for specific contacts

### Presence and calls
- Track whether a user is online
- Update last-seen timestamps on disconnect
- Record call history for voice/video calls
- Show call events in the thread timeline

### Media handling
- Upload media files through the backend
- Generate image thumbnails automatically
- Serve uploaded files from the public uploads directory
- Support common image, video, and document formats

## Tech stack

- Node.js
- Express.js
- Socket.IO
- SQLite (better-sqlite3)
- JWT (jsonwebtoken)
- bcryptjs for password hashing
- Google Auth Library
- Multer for file uploads
- Sharp for image processing
- Vanilla HTML, CSS, and JavaScript on the frontend

## Project structure

```bash
.
├── public/
│   ├── css/
│   ├── js/
│   ├── chat.html
│   ├── login.html
│   ├── welcome.html
│   └── index.html
├── server/
│   ├── api.js
│   ├── auth.js
│   ├── db.js
│   ├── dev.js
│   ├── presence.js
│   ├── privacy.js
│   ├── profile.js
│   ├── server.js
│   ├── upload.js
│   └── ...
├── uploads/
├── .env
├── .env.example
├── package.json
├── README.md
├── whatsapp.db
└── ...
```

## Architecture overview

### Backend
The backend is centered around Express and Socket.IO.

- [server/server.js](server/server.js) boots the app and mounts the API + realtime socket layer
- [server/auth.js](server/auth.js) manages sign-up, login, JWT issuance, and Google auth
- [server/api.js](server/api.js) exposes REST API endpoints for contacts and messages
- [server/db.js](server/db.js) contains the SQLite schema, migrations, and database helpers
- [server/profile.js](server/profile.js) handles profile updates and avatar storage
- [server/upload.js](server/upload.js) handles file upload upload flows
- [server/presence.js](server/presence.js) tracks online active users in memory

### Frontend
The frontend is lightweight and static:

- [public/welcome.html](public/welcome.html) is the landing page
- [public/login.html](public/login.html) contains the auth forms
- [public/chat.html](public/chat.html) is the main chat interface shell
- [public/js/session.js](public/js/session.js) stores and reads the auth token
- [public/js/auth.js](public/js/auth.js) drives the auth flow

## Environment setup

This project requires a `.env` file in the root directory.

1. Copy the example file:

```bash
cp .env.example .env
```

2. Update the values in `.env`:

```env
JWT_SECRET=your-long-random-secret
JWT_EXPIRES_IN=7d
PORT=3000
GOOGLE_CLIENT_ID=
```

### Important notes
- `JWT_SECRET` is required for auth to work properly.
- `GOOGLE_CLIENT_ID` is optional; without it, Google Sign-In is disabled.
- Keep your `.env` file private and do not commit real secrets.

## Installation

Install dependencies with:

```bash
npm install
```

## Running the project

### Production-like start

```bash
npm start
```

This starts the app using:

```bash
node server/server.js
```

### Development mode

```bash
npm run dev
```

This uses Node's watch mode for automatic restarts while developing.

Then open in the browser:

```text
http://localhost:3000
```

## Demo login / preview mode

The app includes a dev-only demo seeder route for quickly generating test data.

- The button appears in the login screen when dev mode is enabled.
- This is controlled in [server/dev.js](server/dev.js).

To preview the app with demo data:

1. Start the app in development mode
2. Open the login page
3. Click the demo seed button

This route is intended for local previews and should not be left enabled in production.

## Key API routes

### Auth
- `POST /api/auth/signup`
- `POST /api/auth/login`
- `GET /api/auth/google/config`
- `POST /api/auth/google`

### Contacts and conversations
- `POST /api/contacts`
- `GET /api/contacts`
- `GET /api/conversations`

### Messages
- `GET /api/messages/:contactId`
- `POST /api/messages`

### Profile
- `GET /api/profile/me`
- `PATCH /api/profile/about`
- `PATCH /api/profile/name`
- `POST /api/profile/avatar`

### Uploads
- `POST /api/upload`

### Calls
- `GET /api/calls`

## Socket.IO behavior

The app uses Socket.IO for live updates, including:

- message send / receive
- delivery status changes
- read receipts
- chat open state
- online presence updates
- incoming call invites and call events

## Database

The app uses SQLite and creates the schema automatically on startup.

Key tables include:

- `users`
- `contacts`
- `messages`
- `calls`
- `privacy_exceptions`

This keeps the app simple and easy to run locally without external database setup.

## Security considerations

This project is a learning/demo app, but the code already demonstrates several good practices:

- Passwords are hashed with bcrypt
- JWT tokens are used for session authentication
- Auth is required for protected routes
- Privacy checks are enforced server-side
- Uploaded files are validated before use

For production, consider adding:

- proper rate limiting
- HTTPS
- stronger deployment configuration
- Redis for shared presence/session data
- PostgreSQL or a managed database
- automated tests and CI

## Production notes

Before deploying to production, review and remove or restrict:

- dev-only seed endpoints in [server/dev.js](server/dev.js)
- debug-style network calls found in the server logic
- any mock/demo data assumptions in the frontend
- local SQLite-only storage if multi-instance deployment is needed

## Summary

ChatConnect is a full-stack real-time chat app that demonstrates how a modern messaging platform can be structured using lightweight web technologies. It covers authentication, real-time communication, contact management, profile privacy, media uploads, and a polished frontend experience.

It is a great foundation for extending into a larger production chat product, such as adding group chats, message search, typing indicators, voice/video calling, notifications, or a production-grade database.

## License

This project is provided as-is for learning and project experimentation.

## Author / project status

This repository is a local full-stack app created for chat app prototyping and educational use.
