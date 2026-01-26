# Wabi - Architecture & Project Documentation

## Overview

Wabi is a **private, self-hosted, ephemeral real-time chat platform** designed for small to medium-sized communities (10-50 concurrent users). It prioritizes user privacy through in-memory storage with no database persistence, opt-in logging, and automatic file cleanup. The application can run as a web app or native desktop application via Tauri.

**Core Philosophy**: No spying. No bloat. Just chill.

---

## Architecture

### High-Level System Design

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (SvelteKit)                     │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Routes: Login, Chat, Draw, Screen Share, Settings   │   │
│  │ Components: Messages, Users, DM Panel, Theme System │   │
│  │ State: Svelte stores (users, channels, theme)       │   │
│  │ Real-time: Socket.IO client, WebRTC peer conns     │   │
│  └──────────────────────────────────────────────────────┘   │
└────────────┬────────────────────────────────┬────────────────┘
             │                                │
        Socket.IO              HTTP/Upgrade (WebRTC Signaling)
        (Port 3000)                  (Port 3000)
             │                                │
┌────────────▼────────────────────────────────▼────────────────┐
│                  Backend (Node.js + Socket.IO)               │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Handler: socket.io event listeners                  │    │
│  │  - auth:login/logout                                │    │
│  │  - chat:send/edit/delete/pin                        │    │
│  │  - channel:create/join/leave                        │    │
│  │  - presence:update                                  │    │
│  │  - webrtc:signal (screen share, voice, video)      │    │
│  │  - file:upload/delete                              │    │
│  │  - drawing:sync                                    │    │
│  │  - theme:save/get                                  │    │
│  └──────────────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Storage: In-memory state (NO DATABASE)              │    │
│  │  - Users, channels, messages, files                 │    │
│  │  - All data lost on server restart                  │    │
│  └──────────────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Plugin System: Hot-loaded modules in /plugins       │    │
│  │  - Access to io (Socket.IO), state, logging         │    │
│  │  - Can listen/emit events, modify shared state      │    │
│  └──────────────────────────────────────────────────────┘    │
└────────────┬────────────────────────────────────────────────┘
             │
    ┌────────▼─────────┐
    │  File Storage    │
    │  /data/uploads   │
    │  (Ephemeral)     │
    └────────┬─────────┘
             │
    ┌────────▼──────────────┐
    │ TURN Server (Coturn)  │
    │ (Port 3478)           │
    │ WebRTC Media Relay    │
    └───────────────────────┘
```

### Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** | SvelteKit | Web framework with file-based routing |
| **Frontend State** | Svelte Stores | Reactive state management |
| **Frontend Desktop** | Tauri | Native desktop app wrapper |
| **Frontend Real-time** | Socket.IO Client | WebSocket communication |
| **Frontend Media** | WebRTC | Peer-to-peer screen share, voice, video |
| **Backend Runtime** | Node.js | JavaScript runtime |
| **Backend API** | Node.js HTTP Server | REST endpoints + health checks |
| **Backend Real-time** | Socket.IO | WebSocket server for events |
| **Backend Auth** | JWT (Custom) | Token-based session management |
| **File Storage** | Filesystem (/data/uploads) | Temporary, ephemeral storage |
| **Media Relay** | Coturn (TURN Server) | WebRTC relay for restricted networks |
| **Deployment** | Docker + Docker Compose | Containerization |

---

## Frontend Architecture

**Location**: `/frontend`

### Project Structure

```
frontend/
├── src/
│   ├── app.css                    # Global styles & theme CSS variables
│   ├── app.html                   # HTML template
│   ├── routes/
│   │   ├── +page.svelte          # Main chat interface
│   │   ├── +layout.svelte        # Root layout (version polling, update notifications)
│   │   ├── +page.server.ts       # Server-side authentication
│   │   └── +error.svelte         # Error boundary
│   ├── lib/
│   │   ├── socket.ts             # Socket.IO initialization & stores
│   │   ├── components/
│   │   │   ├── ChatPanel.svelte   # Message display & input
│   │   │   ├── UserList.svelte    # Online users sidebar
│   │   │   ├── DMListPanel.svelte # Direct messages (Discord-style layout)
│   │   │   ├── DrawingBoard.svelte # Excalidraw integration
│   │   │   ├── ScreenShare.svelte  # WebRTC screen sharing
│   │   │   ├── GifPicker.svelte    # Giphy integration
│   │   │   ├── MessageItem.svelte  # Individual message component
│   │   │   ├── CreateChannelModal.svelte
│   │   │   ├── CreateDMModal.svelte
│   │   │   ├── ThemeCustomizer.svelte
│   │   │   ├── UniformFontMode.svelte
│   │   │   └── ChannelSidebar.svelte
│   │   ├── theme/
│   │   │   ├── themes.ts          # Theme definitions (colors, names, custom themes)
│   │   │   ├── themeStore.ts      # Svelte store for theme state
│   │   │   ├── themeManager.ts    # Applies themes to DOM via CSS variables
│   │   │   ├── themeApi.ts        # HTTP client for theme persistence
│   │   │   ├── initTheme.ts       # Theme initialization on app load
│   │   └── types/
│   │       └── theme.ts           # TypeScript types for theme system
│   └── types/
│       ├── index.ts               # Shared types (User, Channel, Message)
│       └── theme.ts               # Theme preference types
├── svelte.config.js               # SvelteKit configuration
├── vite.config.ts                 # Vite bundler configuration
└── package.json                   # Dependencies (Socket.IO, Tauri, etc.)
```

### Key Frontend Systems

#### 1. Socket.IO Connection (socket.ts)
**Location**: `frontend/src/lib/socket.ts`

Initializes Socket.IO client and manages reactive stores:
- `users` - list of connected users with presence status
- `channels` - list of channels/DMs with metadata
- `channelMessages` - message history per channel
- `currentUser` - authenticated user info
- `typingUsers` - who's currently typing

```typescript
// Example: Listen to new messages
messages.on('message:new', (data: Message) => {
  channelMessages.update(msgs => ({
    ...msgs,
    [data.channelId]: [...(msgs[data.channelId] || []), data]
  }));
});
```

**Event Flow**:
- User joins → `auth:login` → server creates session
- User sends message → `chat:send` → server broadcasts to channel
- User leaves → `auth:logout` → cleanup on server side

#### 2. Theme System (theme/)
**Location**: `frontend/src/lib/theme/`

Multi-layer theme architecture:

1. **themeStore.ts**: Svelte writable store holding theme state
   - Current theme ID, custom theme data, uniform font settings
   - `load()`, `setTheme()`, `setUniformFont()` methods

2. **themes.ts**: Theme definitions
   - Presets: `darkTheme`, `lightTheme`, `midnightBlueTheme`, `vscodeHighContrastTheme`
   - Each theme has: colors object, cssVariables map, name/id

3. **themeManager.ts**: Applies theme to DOM
   - `applyTheme(theme, backgroundImage?, uniformFontSettings?)`
   - Sets CSS custom properties on `:root`
   - Sets `data-theme` attribute for CSS selectors
   - Handles uniform font styling via CSS variables

4. **themeApi.ts**: HTTP client
   - `fetchThemePreferences()` - GET /api/user/theme
   - `saveThemePreferences(prefs)` - POST /api/user/theme
   - `resetThemePreferences()` - POST /api/user/theme/reset
   - **Auth**: Reads token from `localStorage.getItem('authToken')`

5. **initTheme.ts**: Theme initialization on app load
   - Loads saved preferences from server
   - Falls back to default theme if not authenticated
   - Watches for theme changes and persists them

**CSS Custom Properties**:
- `--bg-primary`, `--bg-secondary`, `--bg-tertiary` - backgrounds
- `--text-primary`, `--text-secondary` - text colors
- `--accent`, `--accent-hex` - accent color
- `--border` - border color
- `--uniform-font-family/size/weight/style` - uniform font overrides

#### 3. Authentication Flow
**Location**: `frontend/src/routes/+page.server.ts`, `frontend/src/lib/socket.ts`

```
1. User enters username → "Login" button
2. POST /auth/login (username)
3. Server responds with JWT token
4. Frontend stores token in localStorage['authToken']
5. Socket.IO connects with Bearer token in headers
6. Server validates token → grants access
```

**Token Format**: JWT with payload: `{ userId, sessionId }`

#### 4. Direct Messages (DMListPanel.svelte)
**Location**: `frontend/src/lib/components/DMListPanel.svelte`

Discord-style layout with:
- Avatar (36x36px circular) on left
- Username + last message preview on right
- "Direct Messages" header with "+" to start new DM
- Hover effects with accent color
- Sorted by most recent message first

```typescript
// DM Channel ID format: 'dm-{userId1}-{userId2}' (sorted alphabetically)
const dmId = `dm-${memberIds.sort().join('-')}`;
```

#### 5. Version Polling & Update Notifications
**Location**: `frontend/src/routes/+layout.svelte`

Polls `/health` endpoint every 30 seconds:
- Detects when backend restarts
- Shows "Updates available" toast
- Reloads app automatically or on user click
- Uses Svelte's `updated` store to detect rebuild

---

## Backend Architecture

**Location**: `/backend`

### Project Structure

```
backend/
├── src/
│   ├── index.ts                   # Main server entry point
│   ├── routes.ts                  # HTTP route registration
│   ├── handlers/
│   │   ├── auth.ts               # Login/logout handlers
│   │   ├── socket-handlers.ts    # Socket.IO event handlers
│   │   ├── channel.ts            # Channel creation/management
│   │   ├── messages.ts           # Message CRUD operations
│   │   ├── webrtc.ts             # WebRTC signaling relay
│   │   ├── file.ts               # File upload/deletion
│   │   ├── emotes.ts             # Custom emotes
│   │   └── presence.ts           # User status updates
│   ├── api/
│   │   └── themeRoutes.ts        # Theme preference endpoints
│   ├── auth/
│   │   ├── jwt.ts                # JWT signing/verification
│   │   └── session.ts            # Session management
│   ├── db/
│   │   ├── repositories/
│   │   │   ├── userRepository.ts # User storage
│   │   │   ├── channelRepository.ts
│   │   │   ├── messageRepository.ts
│   │   │   ├── sessionRepository.ts
│   │   │   ├── fileRepository.ts
│   │   │   └── themeRepository.ts # Theme preference storage
│   │   └── types.ts              # Database type definitions
│   ├── logger.ts                 # Logging (disabled by default)
│   ├── server-state.ts           # Global in-memory state
│   └── plugins.ts                # Plugin loader
├── .env                          # Config (PORT, FRONTEND_URL, ENABLE_LOGGING)
├── Dockerfile                    # Container image
└── package.json                  # Dependencies
```

### Key Backend Systems

#### 1. Server Entry Point (index.ts)
**Location**: `backend/src/index.ts`

```typescript
1. Load environment variables
2. Initialize in-memory state (users, channels, messages)
3. Create HTTP server
4. Mount Socket.IO on server
5. Register HTTP routes
6. Load plugins from /plugins
7. Start server on PORT
8. Expose health check endpoint (/health)
```

#### 2. Authentication (auth/jwt.ts, auth/session.ts)
**Location**: `backend/src/auth/`

JWT-based session management:
- **signToken(userId, sessionId)**: Creates JWT with 7-day expiry
- **verifyToken(token)**: Validates token and returns payload
- **Session Storage**: In-memory map of sessionId → { userId, createdAt, expires_at }
- **Auto-cleanup**: Sessions expire after 7 days

```typescript
// Token structure: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
// Payload: { userId: number, sessionId: string, iat: timestamp, exp: timestamp }
```

#### 3. Socket.IO Event Handlers (handlers/socket-handlers.ts)
**Location**: `backend/src/handlers/socket-handlers.ts`

Core events:

| Event | Handler | Description |
|-------|---------|-------------|
| `auth:login` | handleLogin | Authenticate user, create session |
| `auth:logout` | handleLogout | Destroy session, notify others |
| `channel:create` | handleCreateChannel | Create new text channel |
| `channel:join` | handleJoinChannel | User joins channel |
| `channel:leave` | handleLeaveChannel | User leaves channel |
| `chat:send` | handleSendMessage | Broadcast message to channel |
| `chat:edit` | handleEditMessage | Edit existing message |
| `chat:delete` | handleDeleteMessage | Delete message + cleanup files |
| `chat:pin` | handlePinMessage | Pin message to channel |
| `presence:update` | handlePresenceUpdate | Update user status (active/away/offline) |
| `typing:start` | handleTypingStart | Notify users who's typing |
| `typing:stop` | handleTypingStop | Stop typing notification |
| `webrtc:signal` | handleWebRTCSignal | Relay SDP/ICE candidates for screen share |
| `file:upload` | handleFileUpload | Save uploaded file, emit URL |
| `emote:add` | handleAddEmote | Add custom emote |
| `drawing:sync` | handleDrawingSync | Broadcast Excalidraw state |

#### 4. Theme Persistence (api/themeRoutes.ts)
**Location**: `backend/src/api/themeRoutes.ts`

HTTP endpoints for theme preferences:

```
GET /api/user/theme
  Authorization: Bearer {token}
  Response: { theme_id, custom_theme, uniform_font_enabled, uniform_font_family, ... }

POST /api/user/theme
  Authorization: Bearer {token}
  Body: { theme_id?, custom_theme?, uniform_font_enabled?, ... }
  Response: { success, updated preferences }

POST /api/user/theme/reset
  Authorization: Bearer {token}
  Response: { success, theme_id: 'midnight-blue' }
```

**Storage**: In-memory per-user theme data
- Key: userId
- Value: { theme_id, custom_theme (JSON string), uniform_font_* }
- Lost on server restart

#### 5. File Management (handlers/file.ts)
**Location**: `backend/src/handlers/file.ts`

```
Upload Flow:
1. User selects file → socket 'file:upload'
2. Server receives file buffer
3. Save to /data/uploads/{messageId}/{filename}
4. Emit 'file:uploaded' with { url, messageId, fileId }
5. Frontend displays download link

Delete Flow (auto on message delete):
1. Message deleted → check for attached files
2. Delete files from filesystem
3. Clean up orphaned directories
4. Emit 'file:deleted' event
```

**Ephemeral**: All files in /data/uploads are temporary and lost on restart.

#### 6. Plugin System (plugins.ts)
**Location**: `backend/src/plugins.ts`

Auto-loads plugins from `/plugins` directory:

```typescript
// Directory structure
/plugins
  /my-plugin
    plugin.json
    index.js

// plugin.json format
{
  "name": "my-plugin",
  "version": "1.0.0",
  "entry": "index.js"
}

// index.js receives context
module.exports = (context) => {
  const { io, state, logger } = context;

  // Listen to events
  io.on('connection', (socket) => {
    socket.on('custom:event', (data) => {
      // Do something
      state.customData = data;
    });
  });
};
```

**Available Context**:
- `io` - Socket.IO server instance
- `state` - Global in-memory state object
- `logger` - Logging function (respects ENABLE_LOGGING)

#### 7. Database Layer (db/repositories/)
**Location**: `backend/src/db/repositories/`

No actual database - all in-memory maps:

```typescript
// Example: userRepository.ts
export const userRepository = {
  create: (user) => { state.users[user.id] = user; },
  findById: (id) => state.users[id],
  findAll: () => Object.values(state.users),
  delete: (id) => { delete state.users[id]; },
  // ... etc
};
```

**Data Lost On Restart**: Everything in these repositories is ephemeral.

#### 8. Server Health Check
**Location**: `backend/src/index.ts`

```
GET /health
Response: { status: 'ok' }
HTTP 200
```

Used by Docker health checks and frontend version polling.

---

## User Privacy & Data Security

### Privacy-First Design

**Core Principle**: Zero data persistence by default. User data exists only while server runs.

#### 1. In-Memory Storage (Ephemeral by Default)
- **No Database**: All user data, messages, files stored in RAM
- **Automatic Cleanup**: All data deleted on server restart
- **Zero Persistence**: No logs, no archives, no backups
- **User Benefit**: Complete privacy - nothing to leak or be subpoenaed

**Storage Locations**:
- Users: `state.users` (RAM)
- Messages: `state.channels[id].messages` (RAM)
- Files: `/data/uploads/` (filesystem, deleted on restart)
- Sessions: `state.sessions` (RAM)
- Theme Prefs: `state.themePreferences` (RAM)

#### 2. Optional Activity Logging
- **Disabled by Default**: Set `ENABLE_LOGGING=false` in backend/.env
- **Opt-in Only**: Must explicitly enable with `ENABLE_LOGGING=true`
- **What Gets Logged** (if enabled):
  - User connections/disconnections
  - Channel creation/deletion
  - File uploads/downloads
  - Emote additions
  - Profile changes
  - **Errors always logged** (for debugging)
  - **Startup info always logged** (for operations)

**Logging Implementation**: `backend/src/logger.ts`
```typescript
function log(category, message, data?) {
  if (!ENABLE_LOGGING && category !== 'ERROR' && category !== 'INFO') {
    return; // Don't log activity unless explicitly enabled
  }
  console.log(`[${category}]`, message, data);
}
```

#### 3. Token Security
- **JWT Tokens**: Self-contained, no server storage of token content
- **Session Storage**: sessionId maps to userId, expires after 7 days
- **Token Verification**: Validated on each Socket.IO event
- **HTTPS Required**: In production, tokens must be sent over HTTPS only

#### 4. File Privacy
- **Automatic Deletion**: Files deleted when messages are deleted
- **No Orphaned Files**: Directory cleanup prevents orphaned uploads
- **Temporary Storage**: /data/uploads deleted on server restart
- **No Backups**: Files exist only on live server

**File Deletion Logic** (handlers/messages.ts):
```typescript
function handleDeleteMessage(messageId) {
  const msg = state.messages[messageId];

  // Delete attached files
  if (msg.fileUrl) {
    deleteFileFromDisk(msg.fileUrl);
  }

  // Remove message from state
  delete state.messages[messageId];

  // Broadcast deletion to all clients
  io.emit('message:deleted', { messageId });
}
```

#### 5. What Users Should Know
- **Nothing persists**: Close the browser, restart the server, everything is gone
- **No audit trail**: Without logging enabled, zero record of activity
- **No metadata leaks**: No IP logging, no connection history, no activity graphs
- **Self-hosted**: You own the server, you control the data
- **Open source**: Code is public, no hidden tracking

### Security Limitations

⚠️ **NOT suitable for**:
- Public deployment (no rate limiting, no auth, no moderation)
- Sensitive data (no encryption, no signatures)
- Compliance requirements (no audit logs by default)

**Recommended Use**:
- Team chat (trusted group)
- Friend groups
- Private communities
- Temporary meetings

**For Production Deployment**, add:
- Authentication/authorization layer
- Rate limiting on events
- Message validation and sanitization
- HTTPS/TLS encryption
- Access control lists (ACL)
- Optional persistent logging with compliance

---

## Documentation Locations

### Frontend Systems

| Feature | Location | Key Files |
|---------|----------|-----------|
| **Authentication** | `frontend/src/routes/` | `+page.server.ts`, `+layout.svelte` |
| **Socket.IO Setup** | `frontend/src/lib/` | `socket.ts` |
| **Chat Messages** | `frontend/src/lib/components/` | `ChatPanel.svelte`, `MessageItem.svelte` |
| **User List** | `frontend/src/lib/components/` | `UserList.svelte` |
| **Direct Messages** | `frontend/src/lib/components/` | `DMListPanel.svelte`, `CreateDMModal.svelte` |
| **Theme System** | `frontend/src/lib/theme/` | All files in theme/ |
| **Uniform Fonts** | `frontend/src/lib/components/` | `UniformFontMode.svelte` |
| **Drawing/Whiteboard** | `frontend/src/lib/components/` | `DrawingBoard.svelte` |
| **Screen Share** | `frontend/src/lib/components/` | `ScreenShare.svelte` |
| **GIF Search** | `frontend/src/lib/components/` | `GifPicker.svelte` |
| **Global Styles** | `frontend/src/` | `app.css` |
| **Routing** | `frontend/src/routes/` | `+page.svelte`, `+layout.svelte` |
| **Version Polling** | `frontend/src/routes/` | `+layout.svelte` (updated store) |

### Backend Systems

| Feature | Location | Key Files |
|---------|----------|-----------|
| **Server Setup** | `backend/src/` | `index.ts` |
| **HTTP Routes** | `backend/src/` | `routes.ts` |
| **Socket.IO Events** | `backend/src/handlers/` | `socket-handlers.ts` |
| **Authentication** | `backend/src/auth/` | `jwt.ts`, `session.ts` |
| **Theme Persistence** | `backend/src/api/` | `themeRoutes.ts` |
| **File Upload/Delete** | `backend/src/handlers/` | `file.ts` |
| **Channel Management** | `backend/src/handlers/` | `channel.ts` |
| **Message CRUD** | `backend/src/handlers/` | `messages.ts` |
| **User Presence** | `backend/src/handlers/` | `presence.ts` |
| **WebRTC Signaling** | `backend/src/handlers/` | `webrtc.ts` |
| **Emotes System** | `backend/src/handlers/` | `emotes.ts` |
| **Database (In-Memory)** | `backend/src/db/` | All repositories |
| **Plugin System** | `backend/src/` | `plugins.ts` |
| **Logging** | `backend/src/` | `logger.ts` |

### Configuration

| Item | Location |
|------|----------|
| **Backend Config** | `backend/.env` (PORT, FRONTEND_URL, ENABLE_LOGGING) |
| **Frontend Config** | `frontend/.env` (VITE_SOCKET_URL, VITE_GIPHY_API_KEY) |
| **Docker Setup** | `docker-compose.yml` (services, networks, volumes) |
| **Dockerfile (Frontend)** | `frontend/Dockerfile` |
| **Dockerfile (Backend)** | `backend/Dockerfile` |
| **TURN Server** | `turn-server/turnserver.conf` |

---

## How Everything Works

### User Login Flow

```
1. User enters username in frontend
2. Frontend: POST /auth/login with { username }
3. Backend: Creates user in state.users
4. Backend: Creates session, signs JWT token
5. Backend: Responds with { token, userId }
6. Frontend: Saves token to localStorage['authToken']
7. Frontend: Closes login modal
8. Socket.IO connects with Bearer token
9. Backend: Validates token, grants socket access
10. User sees chat interface with online users
```

### Message Send Flow

```
Frontend:
1. User types message, hits Enter
2. Emit 'chat:send' with { text, channelId, timestamp }
3. Optimistically update local UI

Backend:
1. Receive 'chat:send' on socket
2. Validate user is in channel
3. Create message object with ID
4. Save to state.channels[channelId].messages
5. Broadcast 'message:new' to all users in channel

Frontend:
1. Receive 'message:new'
2. Append to channelMessages store
3. Re-render chat list
4. Scroll to bottom
```

### Theme Save Flow

```
Frontend (UniformFontMode.svelte):
1. User clicks "Save Settings"
2. Call themeStore.setUniformFont({ enabled, family, size, weight, style })
3. POST /api/user/theme with font settings + token in Authorization header
4. Backend validates token
5. Backend saves to state.themePreferences[userId]
6. Backend returns 200 OK
7. Frontend shows green toast "Saved!"
8. Toast auto-dismisses after 3 seconds

Page Reload:
1. initTheme.ts runs on app load
2. Frontend: GET /api/user/theme with token
3. Backend returns user's saved preferences
4. themeManager.ts applies CSS variables
5. DOM re-renders with saved theme
6. Font already applied via --uniform-font-* vars
```

### Screen Share Flow

```
Frontend (Initiator):
1. Click "Start Sharing"
2. Browser requests screen permission
3. Capture screen stream via getDisplayMedia()
4. Create RTCPeerConnection with config (STUN/TURN servers)
5. Add screen stream as video track
6. Create SDP offer
7. Emit 'webrtc:signal' with { offer, recipientId }

Backend:
1. Receive 'webrtc:signal' with offer
2. Find recipient socket
3. Emit 'webrtc:signal:incoming' with offer to recipient

Frontend (Recipient):
1. Receive 'webrtc:signal:incoming' with offer
2. Create RTCPeerConnection
3. Set remote description (offer)
4. Create SDP answer
5. Emit 'webrtc:signal' with { answer, senderId }

Backend:
1. Receive answer
2. Forward to initiator

Frontend (Initiator):
1. Receive answer
2. Set remote description
3. ICE candidates exchanged via 'webrtc:icecandidate'
4. Connection established
5. Video stream renders in <video> element

Throughout:
- STUN servers help discover public IP
- TURN server relays media if direct connection fails
- All signaling goes through Socket.IO
```

### File Upload Flow

```
Frontend:
1. User selects file
2. Emit 'file:upload' with { file, channelId, messageId }
3. Backend writes file to /data/uploads/{messageId}/{filename}
4. Backend emits 'file:uploaded' with { url, messageId }
5. Frontend creates message with fileUrl
6. User sees download link in message

File Deletion (auto when message deleted):
1. User clicks delete on message
2. Emit 'chat:delete' with { messageId }
3. Backend finds message
4. Backend deletes /data/uploads/{messageId}/* files
5. Backend removes message from state
6. Backend broadcasts 'message:deleted'
7. All clients remove message from UI
```

### Plugin Load Flow

```
Server Startup (plugins.ts):
1. Scan /plugins directory
2. For each subdirectory:
   a. Read plugin.json
   b. Validate entry field
   c. Require() the entry file
   d. Call with context: { io, state, logger }
   e. Plugin can listen/emit Socket.IO events
   f. Plugin can modify shared state
3. Plugins are now active and integrated
```

---

## Deployment

### Docker Deployment

```bash
# Build and start
docker-compose up -d --build

# Check status
docker-compose ps

# View logs
docker-compose logs -f backend
docker-compose logs -f frontend

# Stop
docker-compose down
```

**Services**:
- `backend`: Node.js server (port 3000)
- `frontend`: SvelteKit dev server (port 5173) during dev, nginx (port 80) in prod
- `turn-server`: Coturn relay (port 3478)

### Zero-Downtime Deployment

**Health Checks** (docker-compose.yml):
```yaml
backend:
  healthcheck:
    test: ["CMD", "node", "-e", "..."]
    interval: 10s
    timeout: 5s
    retries: 3
```

**Frontend Version Polling** (+layout.svelte):
```typescript
// Polls /health every 30 seconds
// Detects when backend restarts
// Shows "Updates available" notification
// Auto-reloads on user click
```

---

## Common Debugging

### Theme Not Saving
1. Check browser console for network errors
2. Verify token in localStorage['authToken']
3. Check backend logs: `docker-compose logs backend`
4. Ensure POST /api/user/theme returns 200
5. Check themeApi.ts is reading from 'authToken' key

### Messages Not Sending
1. Check Socket.IO connection in browser console
2. Look for 'chat:send' event in Socket.IO debug output
3. Verify user is in correct channel
4. Check backend is running: `curl http://localhost:3000/health`

### Screen Share Not Working
1. Ensure HTTPS in production (required by browser)
2. Check browser console for permissions errors
3. Verify TURN server is running: `docker-compose ps`
4. Check WebRTC peer connection status in console

### Files Not Uploading
1. Check /data/uploads directory exists
2. Verify disk space available
3. Check file size limits in handlers
4. Look for errors in backend logs

---

## Key File Reference Map

Quick lookup for implementing features:

```
Want to add new Socket.IO event?
→ backend/src/handlers/socket-handlers.ts

Want to change how theme applies?
→ backend/src/lib/theme/themeManager.ts

Want to add new frontend component?
→ frontend/src/lib/components/YourComponent.svelte

Want to add new HTTP endpoint?
→ backend/src/routes.ts + backend/src/api/

Want to change message format?
→ frontend/src/types/index.ts (types)
→ backend/src/db/types.ts (storage)

Want to add plugin?
→ Create /backend/plugins/my-plugin/
→ Add plugin.json and index.js

Want to change styling?
→ frontend/src/app.css (global)
→ Component .svelte files (scoped)

Want to modify theme colors?
→ frontend/src/lib/theme/themes.ts

Want to change authentication?
→ backend/src/auth/jwt.ts
→ backend/src/handlers/socket-handlers.ts (login handler)

Want to persist data permanently?
→ backend/src/db/repositories/ (would need real DB)
→ Update handler logic to use DB instead of state
```

---

## Project Summary

Wabi is a minimal, privacy-first chat platform that proves you don't need databases, tracking, or complexity to build real-time communication. Every design decision prioritizes user privacy: ephemeral storage, optional logging, automatic cleanup, and self-hosting. The architecture is modular (plugins, components, handlers) making it easy to extend without compromising privacy or simplicity.

**Remember**: This is designed for trusted groups. For public deployment, add authentication, rate limiting, and moderation. But for a chill hangout with friends? It's perfect as-is.
