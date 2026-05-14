# Wabi Architecture — Multi-Server Model

**Date:** 2026-04-27  
**Verified:** Live on wabi.chat

## Core Principle

**Wabi is a TOOL, not a SERVICE.**

- Users run their own servers (wabi-node)
- Client connects to multiple independent servers
- No central coordination between servers
- Clean legal separation: "I publish software, you run your server"

## User Experience

### Adding a Server

1. Click server button (top-left corner)
2. Click "Add server"
3. Enter server URL (e.g., `https://friend-server.com` or `http://192.168.1.100:3000`)
4. Click "Open"
5. Client saves server to localStorage
6. User can switch between servers anytime

### Server Switcher Panel

Shows:
- List of saved servers (with favicons/logos)
- Recent servers
- Followed servers (future feature)
- Add/Remove server buttons
- Server folders (organize servers into groups)

### Multi-Server Client

**Tauri app (desktop/mobile):**
- Stores list of servers locally
- Connects to multiple servers simultaneously
- Shows server switcher (like Slack workspace switcher)
- Each server has independent auth (different accounts possible)
- Notifications per server

## Server Architecture (wabi-node)

**Single binary that:**
- Serves frontend (embedded static files)
- Handles HTTP API routes
- Manages Socket.IO connections
- Stores its own user database (SQLite or SpacetimeDB)
- Coordinates TURN for its own users
- Optionally coordinates SFU/media gateway
- Can run in relay mode (volunteer to help other servers)

**Independent:**
- Doesn't know about other wabi-node instances
- No federation required (optional future feature)
- Each server is an island
- Client is the bridge

## Legal Protection Model

**Like BitTorrent or Signal:**
- ✅ Publish open-source tool on GitHub
- ✅ Users run their own servers
- ✅ No central directory of servers
- ✅ No coordination between servers
- ✅ wabi.chat is a demo instance, not "the service"
- ✅ If served legal process: "I publish software. I don't operate your server."

## Current Implementation

**Frontend:**
- `frontend/src/lib/savedServers.ts` — localStorage management
- `frontend/src/lib/components/ServerSwitcherPanel.svelte` — UI for server management
- Server list stored in browser localStorage
- No backend API needed for server management

**Backend (TypeScript, being replaced by wabi-node):**
- Standalone Node.js server
- Serves frontend
- Handles auth, channels, messages, etc.
- Each instance is independent

**Future (wabi-node Rust server):**
- Single binary replacement for TypeScript backend
- Same independence model
- Better performance
- Easier deployment (no Node.js required)

## Deployment Models

### Kyle's Room (Simple)
```bash
# Kyle runs at home
./wabi-node serve
# Port forwards 3000
# Friends connect to Kyle's public IP:3000
```

### TAFKAT Art Server (Community)
```bash
# TAFKAT runs on VPS with Docker
docker compose up -d
# Has TURN, SFU, media gateway
# 500 users, many channels, whiteboards
```

### Alice's Client
```bash
# Alice runs Tauri app
# Connected to:
#   - Kyle's Room (gaming friends)
#   - Joey's Server (barebones)
#   - TAFKAT Art (community)
# Switches between them seamlessly
```

## Next Steps

1. **wabi-node development** — Rust server to replace TypeScript backend
2. **Tauri v2 migration** — Desktop + mobile from one codebase
3. **Relay mode** — Optional volunteer relay hosting
4. **QR code onboarding** — Scan to join server (easier than typing URL)
5. **LAN discovery** — Auto-find servers on same WiFi (optional)

## Parking Lot (Future Considerations)

- **Pretext integration** — Text layout optimization for Reader Mode / notes surfaces. Only add if users report scrolling lag or we build note-heavy features. Not needed for core chat. ([analysis](./PRETEXT_COMPARISON.md))

---

**Summary:** Wabi is a tool for running independent servers. The client aggregates multiple servers. No central coordination. Clean legal separation.
