# Community Chat

A self-hosted, ephemeral chat system with screen sharing for 10-50 users. Built with privacy, simplicity, and easy deployment in mind.

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

- **Frontend**: SvelteKit with TypeScript
- **Backend**: Bun runtime with Socket.IO
- **Real-time**: Socket.IO for chat, WebRTC for screen sharing
- **Drawing**: Excalidraw
- **GIFs**: Giphy API
- **Deployment**: Single binary executable + Docker

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.0 or higher
- Modern web browser with WebRTC support

### Development

1. Clone the repository:
```bash
git clone <your-repo-url>
cd community-chat
```

2. Install dependencies:
```bash
bun install
cd frontend && bun install && cd ..
cd backend && bun install && cd ..
```

3. Set up environment variables:

Backend (create `backend/.env`):
```env
PORT=3000
FRONTEND_URL=http://localhost:5173
ENABLE_LOGGING=false  # Set to 'true' to enable activity logging
```

Frontend (create `frontend/.env`):
```env
VITE_SOCKET_URL=http://localhost:3000
VITE_GIPHY_API_KEY=your_giphy_api_key_here
```

4. Start development servers:
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

### Backend (Bun + Socket.IO)

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

### Frontend (SvelteKit)

```
src/
├── lib/
│   ├── components/
│   │   ├── Chat.svelte           # Main chat interface
│   │   ├── DrawingBoard.svelte   # Excalidraw integration
│   │   ├── ScreenShareViewer.svelte
│   │   ├── GiphyPicker.svelte
│   │   ├── Sidebar.svelte
│   │   └── ...
│   ├── socket.ts                 # Socket.IO client store
│   └── webrtc.ts                 # WebRTC utilities
└── routes/
    └── +page.svelte              # Main app entry
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

Contributions welcome! This is an MVP - there's lots of room for improvement:

- [ ] Add authentication
- [ ] Persist messages to optional database
- [ ] Add message reactions
- [ ] File sharing
- [ ] Voice/video chat
- [ ] Custom themes
- [ ] Admin controls
- [ ] Message threading

## License

MIT License - feel free to use for any purpose.

## Credits

Built with:
- [Bun](https://bun.sh)
- [SvelteKit](https://kit.svelte.dev)
- [Socket.IO](https://socket.io)
- [Excalidraw](https://excalidraw.com)
- [Giphy](https://giphy.com)
