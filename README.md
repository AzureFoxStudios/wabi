# Wabi - A Self-Hosted, Extensible Chat Platform

Wabi is a **private**, **self-hosted**, and **ephemeral** real-time chat application designed for small to medium-sized communities (10-50 users). It runs as a web application and can be packaged as a native desktop application using Tauri. It prioritizes privacy and simplicity, with all chat data stored in-memory and disappearing when the server restarts.

A chill place to hang out with your friends. No fuss. No spying. No bloat. Just chill.

## Features

- **Real-time Chat**: Instant messaging with typing indicators
- **Screen Sharing**: WebRTC-based screen sharing with multiple participants
- **Collaborative Drawing**: Integrated Excalidraw whiteboard for team collaboration
- **GIF Support**: Giphy integration for fun conversations
- **User Presence**: See who's online in real-time
- **Export Chat**: Download chat history as JSON
- **PWA Support**: Install as a Progressive Web App
- **Ephemeral Storage**: All data stored in-memory (no database required)
- **Privacy-Focused**: No data persistence, opt-in logging, self-hosted deployment
- **File Management**: Uploaded files are automatically deleted when messages are deleted

## Tech Stack

- **Backend**: Node.js (Bun Runtime), Socket.IO, TypeScript
- **Frontend**: SvelteKit, TypeScript
- **Desktop**: Tauri
- **Real-time Comms**: Socket.IO (Signaling), WebRTC (Media)
- **Relay Server**: Coturn, Docker & Docker Compose

## Project Structure

```
.
├── backend/         # Node.js Socket.IO backend
├── frontend/        # SvelteKit frontend & Tauri desktop wrapper
├── plugins/         # Directory for backend plugins
├── turn-server/     # Pre-configured Coturn TURN server for Docker
└── pureref-connector/ # Standalone tool for PureRef integration
```

# System Requirements

So far this has only been tested on Linux (Bazzite & Ubuntu), please do write in about your experience!

You also need the latest version of [Docker](https://www.docker.com/products/docker-desktop/) installed.

# Setting Up Wabi

- Navigate to your terminal.
- Clone this repository: `git clone https://github.com/AzureFoxStudios/wabi`
- Navigate to the new `wabi` folder on your computer.
- Run `docker build .`

The containers should start themselves automatically.

Congratulations, you now have a Wabi instance running locally!

### Configuring the Backend URL

Backend (create `backend/.env`):
```env
PORT=3000
FRONTEND_URL=http://localhost:5173
ENABLE_LOGGING=false  # Set to 'true' to enable activity logging
```

### Configuring and Running the TURN Relay Server

For voice/video calls to work reliably, you need the TURN relay server.

1.  Navigate to the `turn-server` directory: `cd turn-server`.
2.  **Open `turnserver.conf`** and change `external-ip=127.0.0.1` to your machine's local IP address (or public IP for production).
3.  Start the server using Docker Compose: `docker-compose up -d`.
4.  Navigate back to the root directory: `cd ..`

### Running the Application

Start the backend and frontend development servers concurrently from the root directory.

```bash
bun run dev
```

This will start:
- Frontend dev server on `http://localhost:5173`
- Backend server on `http://localhost:3000`

## Production Deployment

### Option 1: Single Binary (Recommended)

1. Build the project:
```bash
chmod +x build.sh
./build.sh
```

2. The `dist/` folder will contain:
   - `community-chat-server` (single binary executable)
   - `static/` (frontend build files)

3. Deploy and run:
```bash
cd dist
PORT=3000 ./community-chat-server

# Or with logging enabled:
ENABLE_LOGGING=true PORT=3000 ./community-chat-server
```

The server will serve both the API and static files on the specified port.

### Option 2: Docker

1. Build the Docker image:
```bash
docker build -t community-chat .
```

2. Run the container:
```bash
docker run -p 3000:3000 community-chat
```

Or use Docker Compose:
```bash
docker-compose up -d
```

## Configuration

### Backend Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `FRONTEND_URL` | Frontend URL for CORS | `http://localhost:5173` |
| `ENABLE_LOGGING` | Enable activity logging (user joins/leaves, messages, etc.) | `false` |

### Frontend Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `VITE_SOCKET_URL` | Backend Socket.IO URL | `http://localhost:3000` |
| `VITE_GIPHY_API_KEY` | Giphy API key | Demo key (limited) |

### Getting a Giphy API Key

1. Sign up at [Giphy Developers](https://developers.giphy.com/)
2. Create a new app
3. Copy the API key to `VITE_GIPHY_API_KEY`

## Architecture

### Backend Plugin System

- In-memory data storage (ephemeral)
- Socket.IO event handlers for:
  - Chat messages (with edit, delete, pin support)
  - User presence
  - Typing indicators
  - WebRTC signaling (screen sharing, voice/video calls)
  - Excalidraw state sync
  - File uploads (with automatic cleanup on message deletion)
  - Channel management
  - Custom emotes
- Privacy-focused: Opt-in activity logging (disabled by default)
- Automatic file deletion when messages are removed

- The server automatically loads any subdirectory in `plugins/` that contains a `plugin.json` manifest.
- Each plugin's entry point receives a `context` object, giving it access to the core `io` (Socket.IO server) instance and the application's `state`.
- This allows you to listen for events, emit new ones, and modify the shared server state, enabling deep integration and extension of core functionality.

### WebRTC and the TURN Server

For reliable WebRTC connections (especially across different networks), STUN and TURN servers are used.

- **STUN**: Public STUN servers are pre-configured to help clients discover their public IP address.
- **TURN**: This project includes a pre-configured `coturn` TURN server in the `/turn-server` directory. It relays media traffic when a direct peer-to-peer connection fails. The frontend is already configured to use it, but you must ensure it's running and its IP is correctly configured in `turnserver.conf` and `frontend/src/lib/(calling|webrtc).ts`.

## Building for Production

This application can be built into a native desktop application.

1.  Ensure all configurations (especially server URLs) are set for production.
2.  Run the Tauri build command from the `frontend/` directory:

```bash
cd frontend
bun run tauri build
```

## Usage

1. **Login**: Enter a username to join the chat
2. **Chat**:
   - Type messages in the input field
   - Click "GIF" to search and send GIFs
   - Click "Export" to download chat history
3. **Drawing**: Switch to "Draw" tab for collaborative whiteboard
4. **Screen Share**:
   - Switch to "Screen Share" tab
   - Click "Start Sharing" to share your screen
   - View others' shared screens in real-time

## Limitations

- **Ephemeral**: All data is lost when the server restarts
- **Scale**: Designed for 10-50 concurrent users
- **Network**: Screen sharing requires good network bandwidth
- **HTTPS**: WebRTC screen sharing requires HTTPS in production

## Production Considerations

### HTTPS Setup

For screen sharing to work in production, you need HTTPS:

1. Use a reverse proxy (nginx, Caddy):
```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

2. Or use a platform with built-in SSL (Railway, Fly.io, etc.)

### STUN/TURN Servers

For better WebRTC connectivity, configure TURN servers in `frontend/src/lib/webrtc.ts`:

```typescript
const rtcConfig: RTCConfiguration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        {
            urls: 'turn:your-turn-server.com:3478',
            username: 'user',
            credential: 'pass'
        }
    ]
};
```

## Privacy & Data Management

### Truly Ephemeral by Default

This chat system is designed with **privacy first**:

- **No Database**: All messages stored in-memory only, lost on server restart
- **Opt-in Logging**: Server activity logs are **disabled by default**
  - Set `ENABLE_LOGGING=true` to log user activity (joins, messages, file uploads, etc.)
  - Error logs and startup info always enabled for operational purposes
  - Without logging enabled, no audit trail is created
- **Automatic File Cleanup**: When messages with uploaded files are deleted:
  - Files are **permanently removed** from the server filesystem
  - No orphaned files left behind
- **No Persistence**: Chat history, user data, and files exist only while the server runs

### What Gets Logged (if `ENABLE_LOGGING=true`)

- User connections/disconnections
- Users joining/leaving chat
- Channel creation/deletion
- File uploads/deletions
- Emote additions/deletions
- Profile updates

### What's Always Logged (operational)

- Server startup information (port, directories)
- Error messages (for debugging)
- Health check requests

## Security Notes

- This is designed for trusted groups (team chat, friend groups)
- No authentication or authorization built-in
- No rate limiting on messages
- For public deployment, add:
  - Authentication layer
  - Rate limiting
  - Message validation
  - User moderation tools

## Troubleshooting

**Screen sharing not working:**
- Ensure you're using HTTPS in production
- Check browser permissions
- Verify WebRTC is supported

**Messages not appearing:**
- Check Socket.IO connection in browser console
- Verify backend is running
- Check CORS settings match frontend URL

**Build fails:**
- Ensure Bun is installed and up to date
- Clear node_modules and reinstall
- Check for TypeScript errors

## Contributing

This project is under active development. Key areas for contribution include:

- [ ] Add authentication and user accounts
- [ ] Persist messages to an optional database (e.g., SQLite)
- [ ] Add message reactions
- [ ] Admin/moderation controls
- [ ] Custom themes
- [ ] Message threading
- [ ] DevOps, Docker optimization

## License

MIT License
