# TURN/STUN Architecture Documentation

This document describes the TURN/STUN infrastructure in the Wabi repository, identifies critical files and environment variables, and explains the rationale behind the configuration choices.

## Table of Contents

1. [Overview](#overview)
2. [Architecture Diagram](#architecture-diagram)
3. [Critical Files](#critical-files)
4. [Environment Variables](#environment-variables)
5. [Configuration Explanations](#configuration-explanations)
6. [How It All Connects](#how-it-all-connects)
7. [Why These Settings](#why-these-settings)

---

## Overview

Wabi uses TURN (Traversal Using Relays around NAT) and STUN (Session Traversal Utilities for NAT) servers to enable WebRTC-based voice calls, video calls, and screen sharing between users, even when they're behind restrictive NATs or firewalls.

**Key components:**
- **Coturn** - Self-hosted TURN/STUN server running in Docker
- **Frontend turnConfig.ts** - Centralized configuration module for WebRTC
- **Environment-based configuration** - Credentials injected at build/runtime, never hardcoded

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              WABI TURN/STUN FLOW                            │
└─────────────────────────────────────────────────────────────────────────────┘

                              ┌──────────────────┐
                              │   .env (root)    │
                              │  TURN_EXTERNAL_IP│
                              │  TURN_REALM      │
                              │  TURN_USERNAME   │
                              │  TURN_PASSWORD   │
                              └────────┬─────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
              ▼                        ▼                        ▼
    ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
    │  frontend/.env  │     │docker-compose.yml│    │    Coturn       │
    │  VITE_TURN_*    │     │  environment:    │    │    Container    │
    └────────┬────────┘     │  TURN_*          │    └────────┬────────┘
             │              └────────┬─────────┘             │
             │                       │                       │
             ▼                       ▼                       ▼
    ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
    │  Vite Build     │     │docker-entrypoint│     │turnserver.conf  │
    │  (injects vars) │     │  (envsubst)     │     │  (generated)    │
    └────────┬────────┘     └────────┬────────┘     └────────┬────────┘
             │                       │                       │
             ▼                       └───────────────────────┘
    ┌─────────────────┐                      │
    │  turnConfig.ts  │                      │
    │  buildRTCConfig │                      │
    └────────┬────────┘                      │
             │                               │
             ▼                               ▼
    ┌─────────────────┐             ┌─────────────────┐
    │  calling.ts     │             │  TURN Server    │
    │  webrtc.ts      │◄────────────│  Port 3478      │
    │  (WebRTC calls) │   Media     │  Ports 49152-   │
    └─────────────────┘   Relay     │       65535     │
                                    └─────────────────┘
```

---

## Critical Files

> **DO NOT DELETE** these files. Removing any of them will break voice/video calling functionality.

### Frontend Files

| File | Purpose | Impact if Deleted |
|------|---------|-------------------|
| `frontend/src/lib/turnConfig.ts` | Centralized TURN/STUN configuration builder. Exports `getTurnConfig()`, `getStunServers()`, and `buildRTCConfig()` | **All WebRTC calls fail** - no ICE servers configured |
| `frontend/src/lib/calling.ts` | Voice/video calling implementation. Uses `buildRTCConfig()` at line 30 | Voice and video calls broken |
| `frontend/src/lib/webrtc.ts` | Screen sharing implementation. Uses `buildRTCConfig()` at line 18 | Screen sharing broken |
| `frontend/.env` | Contains `VITE_TURN_*` variables for frontend build | Frontend cannot connect to TURN server |

### TURN Server Files

| File | Purpose | Impact if Deleted |
|------|---------|-------------------|
| `turn-server/turnserver.conf.template` | Coturn configuration template with `${VARIABLE}` placeholders | TURN server won't start - no config |
| `turn-server/docker-entrypoint.sh` | Startup script that runs `envsubst` to generate config | Container exits immediately |
| `turn-server/Dockerfile` | Docker image definition with gettext for envsubst | Cannot build TURN container |

### Root Configuration Files

| File | Purpose | Impact if Deleted |
|------|---------|-------------------|
| `.env` | Contains TURN server credentials and external IP | TURN server uses broken defaults (127.0.0.1) |
| `docker-compose.yml` | Defines coturn service with environment variables and volumes | TURN server won't run |

---

## Environment Variables

### Root `.env` Variables

These are passed to the Coturn Docker container:

```env
TURN_EXTERNAL_IP=<your-public-ip>    # Required: Server's public IP or domain
TURN_REALM=<your-domain>             # Required: Authentication realm (usually your domain)
TURN_USERNAME=<username>             # Required: TURN authentication username
TURN_PASSWORD=<secure-password>      # Required: TURN authentication password
```

### Frontend `.env` Variables

These are injected at build time by Vite:

```env
VITE_TURN_SERVER=<your-public-ip>    # Must match TURN_EXTERNAL_IP
VITE_TURN_PORT=3478                  # Standard TURN port (5349 for TLS)
VITE_TURN_USERNAME=<username>        # Must match TURN_USERNAME
VITE_TURN_PASSWORD=<password>        # Must match TURN_PASSWORD
VITE_USE_TURNS=false                 # Set true for TLS-encrypted TURN
VITE_ENABLE_GOOGLE_STUN=true         # Enable Google STUN fallback servers
```

### Variable Synchronization

**Critical:** These values MUST match between root `.env` and `frontend/.env`:

| Root `.env` | Frontend `.env` |
|-------------|-----------------|
| `TURN_EXTERNAL_IP` | `VITE_TURN_SERVER` |
| `TURN_USERNAME` | `VITE_TURN_USERNAME` |
| `TURN_PASSWORD` | `VITE_TURN_PASSWORD` |

If these don't match, TURN authentication will fail silently.

---

## Configuration Explanations

### turnserver.conf.template

#### Networking Settings

```conf
external-ip=${TURN_EXTERNAL_IP}
```
**Why:** TURN must advertise its public IP to clients. ICE candidates contain this IP for NAT traversal. Using `127.0.0.1` breaks external connections.

```conf
listening-port=3478
```
**Why:** IANA standard port for TURN/STUN. Universally supported by WebRTC clients.

```conf
min-port=49152
max-port=65535
```
**Why:** RTP/RTCP media relay port range. Coturn allocates ports from this range for actual audio/video streams. Your firewall must allow this entire UDP range.

#### Authentication Settings

```conf
lt-cred-mech
```
**Why:** "Long-term credential mechanism" per RFC 5766. Clients authenticate with username:password. This is the standard for production TURN servers.

```conf
user=${TURN_USERNAME}:${TURN_PASSWORD}
```
**Why:** Static credentials injected at runtime. Not hardcoded in the image for security.

```conf
realm=${TURN_REALM}
```
**Why:** Realm scopes the credentials. Typically set to your domain for consistency.

#### Security Hardening

```conf
fingerprint
```
**Why:** Enables STUN message integrity checking. Detects tampering with signaling. Minimal overhead, significant security gain.

```conf
no-cli
```
**Why:** Disables telnet admin interface. Prevents unauthorized remote administration and potential SSRF attacks.

```conf
denied-peer-ip=127.0.0.1
denied-peer-ip=::1
```
**Why:** Prevents TURN from relaying traffic to localhost. Blocks SSRF attacks where an attacker could probe internal services through the TURN relay.

#### TLS/TURNS (Commented by Default)

```conf
# cert=/etc/coturn/certs/cert.pem
# pkey=/etc/coturn/certs/privkey.pem
# tls-listening-port=5349
```
**Why commented:** TLS requires valid certificates. Uncomment and provide certs for production deployments requiring encrypted signaling.

### docker-compose.yml Coturn Service

```yaml
profiles:
  - turn
```
**Why:** Makes TURN server optional. Start with `docker compose --profile turn up`. Some deployments may use external TURN providers.

```yaml
network_mode: "host"
```
**Why:** Container uses host networking directly. Required for TURN to work because:
1. Media ports (49152-65535) would require complex port mapping
2. NAT traversal needs the container to see real network interfaces
3. ICE candidates must reflect actual host IP

```yaml
volumes:
  - ./turn-server/turnserver.conf.template:/etc/coturn/turnserver.conf.template:ro
```
**Why:** Template mounted read-only. Config generated at runtime by entrypoint script using `envsubst`.

### docker-entrypoint.sh

```bash
envsubst < /etc/coturn/turnserver.conf.template > /etc/coturn/turnserver.conf
```
**Why:** Replaces `${VARIABLE}` placeholders with actual environment values. This pattern:
- Keeps credentials out of the Docker image
- Allows different configs for different environments
- Follows 12-factor app principles

### turnConfig.ts

#### getTurnConfig()

```typescript
const urls = [
  `${protocol}:${server}:${port}`,
  `${protocol}:${server}:${port}?transport=udp`,
  `${protocol}:${server}:${port}?transport=tcp`
];
```
**Why three URLs:**
1. Default - browser auto-selects transport
2. Explicit UDP - for networks that block TCP
3. Explicit TCP - for networks that block UDP (corporate firewalls)

#### getStunServers()

```typescript
if (enableGoogleStun) {
  stunServers.push(
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  );
}
```
**Why Google fallback:** Redundancy. If self-hosted STUN fails, Google's servers ensure NAT discovery still works. Can be disabled with `VITE_ENABLE_GOOGLE_STUN=false` for full independence.

---

## How It All Connects

### Build Time Flow

```
1. Developer sets up .env and frontend/.env with matching credentials

2. docker compose build
   ├── Frontend build:
   │   └── Vite reads VITE_* vars → injects into JavaScript bundle
   │
   └── TURN server build:
       └── Installs gettext-base package (provides envsubst)
```

### Runtime Flow

```
3. docker compose up --profile turn
   ├── Coturn container starts:
   │   ├── Entrypoint runs: envsubst < template > turnserver.conf
   │   ├── Variables like ${TURN_EXTERNAL_IP} replaced with actual values
   │   └── Coturn process starts with generated config
   │
   └── Frontend serves bundle with embedded VITE_* values

4. User initiates a call:
   ├── calling.ts calls buildRTCConfig()
   │   ├── getStunServers() returns self-hosted + Google STUN
   │   └── getTurnConfig() returns TURN URLs + credentials
   │
   ├── Browser creates RTCPeerConnection with iceServers config
   │
   └── ICE gathering begins:
       ├── STUN queries discover public IP
       ├── TURN allocations request relay addresses
       └── Best path selected (P2P if possible, TURN relay if needed)
```

### Media Flow

```
If P2P possible:
  User A ←──────── Direct ──────────→ User B

If NAT blocks P2P:
  User A ←───→ TURN Server ←───→ User B
              (ports 49152-65535)
```

---

## Why These Settings

| Setting | Choice | Rationale |
|---------|--------|-----------|
| `lt-cred-mech` | Long-term credentials | RFC 5766 standard, widely supported |
| `fingerprint` | Enabled | Message integrity with minimal overhead |
| `no-cli` | Disabled | Security - prevents unauthorized admin access |
| `denied-peer-ip=127.0.0.1` | Blocked | Prevents SSRF attacks through TURN relay |
| `network_mode: host` | Host networking | Required for NAT traversal to work |
| `profiles: [turn]` | Optional | Not all deployments need self-hosted TURN |
| Port 3478 | Standard | Universal client support |
| Ports 49152-65535 | Full range | Supports maximum concurrent streams |
| Google STUN fallback | Enabled | Redundancy for NAT discovery |
| Environment variables | Runtime injection | 12-factor app, no hardcoded secrets |

---

## Quick Reference

### Start TURN Server
```bash
docker compose --profile turn up -d
```

### Check TURN Server Logs
```bash
docker logs wabi-coturn
```

### Test TURN Connectivity
Use https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/
- Add: `turn:your-server:3478`
- Enter username and password
- Look for "relay" candidates

### Required Firewall Ports
- **3478/UDP+TCP** - TURN/STUN signaling
- **5349/UDP+TCP** - TURNS (TLS) if enabled
- **49152-65535/UDP** - Media relay range
