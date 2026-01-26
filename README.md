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

- **Backend**: Node.js, Socket.IO, TypeScript
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

## Quick Start (Local Development)

1. Clone the repository:
   ```bash
   git clone https://github.com/AzureFoxStudios/wabi
   cd wabi
   ```

2. Set up environment configuration:
   ```bash
   cp .env.example .env
   cp frontend/.env.example frontend/.env
   ```

3. Start all services with Docker Compose:
   ```bash
   docker-compose up -d
   ```

The application will be available at:
- Frontend: `http://localhost:3000`
- Backend API: `http://localhost:8080`
- TURN server: Running on port 3478

## Environment Configuration

Wabi uses environment variables for configuration. Two `.env` files are required:

### Root `.env` (Backend & TURN Server)

```env
# TURN Server Configuration
TURN_EXTERNAL_IP=127.0.0.1              # Your domain or public IP
TURN_REALM=wabi.local                   # TURN server realm
TURN_USERNAME=wabi                      # TURN username
TURN_PASSWORD=change_this_password      # TURN password (generate with: openssl rand -base64 32)

# Backend Configuration
BACKEND_PORT=8080
NODE_ENV=production
JWT_SECRET=your_jwt_secret_here         # Generate with: openssl rand -base64 64
```

### Frontend `.env` (Frontend/Client)

```env
# TURN Server Configuration
VITE_TURN_SERVER=127.0.0.1             # Must match TURN_EXTERNAL_IP
VITE_TURN_PORT=3478                    # 3478 for TURN, 5349 for TURNS
VITE_TURN_USERNAME=wabi                # Must match TURN_USERNAME
VITE_TURN_PASSWORD=change_this_password # Must match TURN_PASSWORD
VITE_USE_TURNS=false                   # Set to true if using SSL/TLS
VITE_ENABLE_GOOGLE_STUN=true           # Optional Google STUN fallback

# Optional: Giphy API Key
VITE_GIPHY_API_KEY=                    # Get from https://developers.giphy.com/
```

**Important:** Credentials must match between root `.env` and `frontend/.env`.

## TURN Server Setup

For production voice/video calling that works across different networks, you need to configure the integrated TURN server.

**See the comprehensive [TURN Setup Guide](TURN_SETUP.md) for:**
- Production deployment with public IP/domain
- SSL/TLS certificate setup for TURNS
- Firewall configuration
- Testing and troubleshooting
- Advanced configurations

### Quick TURN Setup for Production

1. Generate secure credentials:
   ```bash
   openssl rand -base64 32
   ```

2. Update `.env` with your public IP/domain:
   ```env
   TURN_EXTERNAL_IP=your.domain.com
   TURN_PASSWORD=<paste_generated_password>
   ```

3. Update `frontend/.env` with matching credentials:
   ```env
   VITE_TURN_SERVER=your.domain.com
   VITE_TURN_PASSWORD=<same_password>
   ```

4. Configure firewall to allow:
   - Ports 3478 (TCP/UDP) - TURN signaling
   - Ports 49152-65535 (UDP) - Media relay

5. Restart services:
   ```bash
   docker-compose up -d
   ```

For detailed instructions, see [TURN_SETUP.md](TURN_SETUP.md).

### Running the Application in Development

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

- **STUN**: Helps clients discover their public IP address (uses Google STUN as optional fallback)
- **TURN**: This project includes an integrated `coturn` TURN server that's fully configurable via environment variables
  - Automatically configured when you run `docker-compose up`
  - No hardcoded credentials - uses `.env` for configuration
  - Supports both TURN (port 3478) and TURNS with TLS (port 5349)
  - See [TURN_SETUP.md](TURN_SETUP.md) for production deployment guide

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

### TURN Server Configuration

Wabi includes an integrated coturn TURN server for reliable WebRTC connectivity.

**For local development:** The default `.env.example` configuration works out of the box.

**For production:** See [TURN_SETUP.md](TURN_SETUP.md) for:
- Configuring your public IP/domain
- Setting up SSL/TLS certificates (TURNS)
- Firewall configuration
- Testing connectivity
- Troubleshooting common issues

The TURN server is automatically configured from environment variables - no need to edit source code.

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
