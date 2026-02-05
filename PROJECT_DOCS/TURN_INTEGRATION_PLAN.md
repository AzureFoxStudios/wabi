# TURN Server Integration Plan for Wabi

## Objective
Integrate the existing coturn TURN server into wabi for production voice/video calling, making it fully self-hostable with user-configurable credentials.

## User Requirements
- **Self-Hostable**: Anyone should be able to download and configure with their own credentials
- **Production-Ready**: Internet-facing deployment with SSL/TLS support
- **Independent**: Self-hosted coturn as primary, Google STUN as optional fallback only

## Current State
- Voice/video calling is implemented but uses placeholder Metered.ca TURN servers
- Coturn TURN server exists in `turn-server/` but runs separately
- Credentials are hardcoded instead of using environment variables
- No integration between main docker-compose and TURN server

## Implementation Plan

### Phase 1: Docker Integration

#### 1.1 Create Custom Coturn Dockerfile
**File**: `turn-server/Dockerfile` (NEW)
- Base image: `coturn/coturn:latest`
- Install `gettext` for environment variable substitution
- Copy configuration template and entrypoint script
- Set entrypoint to handle runtime config generation

#### 1.2 Create Entrypoint Script
**File**: `turn-server/docker-entrypoint.sh` (NEW)
- Use `envsubst` to substitute environment variables in config template
- Generate final `turnserver.conf` at container startup
- Start coturn with generated configuration
- Make script executable (`chmod +x`)

#### 1.3 Convert Config to Template
**File**: `turn-server/turnserver.conf` → `turn-server/turnserver.conf.template`
- Replace hardcoded values with environment variable placeholders:
  - `external-ip=${TURN_EXTERNAL_IP}`
  - `user=${TURN_USERNAME}:${TURN_PASSWORD}`
  - `realm=${TURN_REALM}`
- Add production security settings:
  - `fingerprint` for STUN message integrity
  - `no-cli` to disable telnet (security)
  - `denied-peer-ip=127.0.0.1` and `denied-peer-ip=::1` (prevent loopback)
- Add TLS/TURNS support:
  - `cert=/etc/coturn/certs/cert.pem`
  - `pkey=/etc/coturn/certs/privkey.pem`
  - `tls-listening-port=5349`

#### 1.4 Integrate into Main Docker Compose
**File**: `docker-compose.yml`
- Add `coturn` service:
  - Build from `turn-server/Dockerfile`
  - Use `network_mode: host` for NAT traversal simplicity
  - Mount `turnserver.conf.template` as read-only
  - Mount volume for SSL certificates: `./turn-server/certs:/etc/coturn/certs:ro`
  - Pass environment variables from `.env` file
  - Add restart policy: `restart: unless-stopped`
- Add healthcheck to verify coturn is running

### Phase 2: Environment Configuration

#### 2.1 Create Root Environment Template
**File**: `.env.example` (UPDATE or CREATE)
```env
# TURN Server Configuration
TURN_EXTERNAL_IP=your.domain.com  # Or public IP address
TURN_REALM=your.domain.com
TURN_USERNAME=wabi_turn_user
TURN_PASSWORD=CHANGE_THIS_TO_SECURE_PASSWORD  # Generate with: openssl rand -base64 32

# Backend Configuration
BACKEND_PORT=8080
NODE_ENV=production
JWT_SECRET=your_jwt_secret_here

# Frontend Configuration
FRONTEND_PORT=3000
```

Add documentation comment explaining:
- Users must create `.env` from this template
- How to generate secure password
- How to set external IP (domain or public IP)

#### 2.2 Update Frontend Environment Template
**File**: `frontend/.env.example` (UPDATE or CREATE)
```env
# TURN Server Configuration
# These should match your TURN server settings
VITE_TURN_SERVER=your.domain.com  # Domain or IP (no protocol)
VITE_TURN_PORT=3478              # Standard TURN port (or 5349 for TURNS)
VITE_TURN_USERNAME=wabi_turn_user
VITE_TURN_PASSWORD=CHANGE_THIS_TO_SECURE_PASSWORD
VITE_USE_TURNS=false             # Set to true if using TLS (port 5349)

# Optional: Google STUN fallback (can be removed for full independence)
VITE_ENABLE_GOOGLE_STUN=true
```

### Phase 3: Frontend Integration

#### 3.1 Create Centralized TURN Configuration Module
**File**: `frontend/src/lib/turnConfig.ts` (NEW)

Create module with:
- `getTurnConfig()`: Builds TURN server configuration from environment variables
  - Supports both TURN (port 3478) and TURNS (port 5349)
  - Includes UDP and TCP transport variations
  - Returns null if credentials not configured (graceful degradation)
- `getStunServers()`: Returns STUN server list
  - Self-hosted coturn STUN as primary: `stun:${TURN_SERVER}:${TURN_PORT}`
  - Google STUN servers conditionally included based on `VITE_ENABLE_GOOGLE_STUN`
- `buildRTCConfig()`: Builds complete `RTCConfiguration` object
  - Combines STUN and TURN servers
  - Logs warning if TURN not configured (developer feedback)
  - Returns production-ready config

**Key Features**:
- Support for both `turn://` and `turns://` protocols
- Validate environment variables are set
- Console warnings for missing configuration
- Clean fallback to STUN-only if TURN unavailable

#### 3.2 Update Screen Sharing WebRTC
**File**: `frontend/src/lib/webrtc.ts`

**Changes**:
- Import: `import { buildRTCConfig } from './turnConfig';`
- Replace static `rtcConfig` object (lines 16-34) with: `const rtcConfig = buildRTCConfig();`
- Remove hardcoded Metered.ca configuration completely

#### 3.3 Update Voice/Video Calling WebRTC
**File**: `frontend/src/lib/calling.ts`

**Changes**:
- Import: `import { buildRTCConfig } from './turnConfig';`
- Replace static `rtcConfig` object (lines 28-46) with: `const rtcConfig = buildRTCConfig();`
- Remove hardcoded Metered.ca configuration completely

### Phase 4: Documentation

#### 4.1 Create TURN Setup Guide
**File**: `TURN_SETUP.md` (NEW)

Document:
1. **Prerequisites**: Docker, domain/public IP, SSL certificate
2. **Configuration Steps**:
   - Copy `.env.example` to `.env`
   - Generate secure TURN password: `openssl rand -base64 32`
   - Set `TURN_EXTERNAL_IP` to your domain or public IP
   - Configure frontend `.env` with matching credentials
3. **SSL/TLS Setup** (for production):
   - Obtain Let's Encrypt certificate
   - Place cert files in `turn-server/certs/`
   - Set `VITE_USE_TURNS=true` in frontend `.env`
4. **Firewall Configuration**:
   - Allow UDP/TCP port 3478 (TURN)
   - Allow UDP/TCP port 5349 (TURNS - if using TLS)
   - Allow UDP ports 49152-65535 (media relay range)
5. **Testing Instructions**:
   - How to verify coturn is running: `docker logs coturn`
   - How to test TURN connectivity (trickle ICE test)
   - How to check WebRTC stats in browser console
6. **Troubleshooting**:
   - Common firewall issues
   - NAT traversal failures
   - Certificate problems

#### 4.2 Update Main README
**File**: `README.md` (UPDATE)

Add sections:
- **TURN Server Setup**: Link to `TURN_SETUP.md`
- **Environment Configuration**: Required `.env` variables
- **Quick Start**: Simplified setup instructions
- **Production Deployment**: Security considerations

### Phase 5: Production Security Enhancements

#### 5.1 Add .gitignore Entries
**File**: `.gitignore` (UPDATE)

Ensure these are ignored:
```
.env
.env.local
.env.production
turn-server/certs/
turn-server/turnserver.conf
```

#### 5.2 Add Certificate Directory
**File**: `turn-server/certs/.gitkeep` (NEW)
- Create placeholder for certificates directory
- Add README explaining how to add SSL certificates

### Phase 6: Testing & Validation

#### 6.1 Local Testing
1. Build coturn image: `docker build -t wabi-coturn turn-server/`
2. Test environment substitution: Verify entrypoint script works
3. Start services: `docker-compose up -d`
4. Check coturn logs: `docker logs coturn` (verify config loaded correctly)
5. Check environment vars in frontend: Verify VITE_ variables are available

#### 6.2 WebRTC Connection Testing
1. Open browser DevTools → Console
2. Initiate voice/video call between two clients
3. Check ICE candidates being generated
4. Verify TURN server appears in RTCConfiguration
5. Monitor WebRTC stats to confirm relay candidates are used when needed

#### 6.3 Production NAT Traversal Test
1. Test from two different networks (not same LAN)
2. Simulate restricted NAT scenarios
3. Verify TURN relay is used when direct P2P fails
4. Check coturn logs for successful allocations

## Critical Files Summary

### Files to Create (7 new files)
1. `turn-server/Dockerfile` - Custom coturn image
2. `turn-server/docker-entrypoint.sh` - Runtime config generation
3. `frontend/src/lib/turnConfig.ts` - Centralized TURN configuration
4. `TURN_SETUP.md` - Setup documentation
5. `.env.example` - Root environment template
6. `frontend/.env.example` - Frontend environment template
7. `turn-server/certs/.gitkeep` - Certificate directory placeholder

### Files to Modify (5 files)
1. `turn-server/turnserver.conf` → Rename to `turnserver.conf.template` with env vars
2. `docker-compose.yml` - Add coturn service
3. `frontend/src/lib/webrtc.ts` - Use dynamic TURN config (lines 16-34)
4. `frontend/src/lib/calling.ts` - Use dynamic TURN config (lines 28-46)
5. `.gitignore` - Add .env and certificate files

### Files to Reference (context only)
1. `turn-server/docker-compose.yml` - Original coturn setup (reference only)
2. `backend/src/server.ts` - May need TURN health endpoint (future enhancement)

## Implementation Sequence

1. **Docker Setup** (Priority 1):
   - Create Dockerfile, entrypoint script, config template
   - Update main docker-compose.yml
   - Test coturn container builds and starts

2. **Environment Configuration** (Priority 2):
   - Create .env.example files
   - Document credential generation
   - Test environment variable substitution

3. **Frontend Integration** (Priority 3):
   - Create turnConfig.ts module
   - Update webrtc.ts and calling.ts
   - Test configuration loading

4. **Documentation** (Priority 4):
   - Create TURN_SETUP.md
   - Update README.md
   - Add troubleshooting guide

5. **Testing** (Priority 5):
   - Integration testing
   - WebRTC connection testing
   - Production NAT traversal testing

## Post-Implementation Considerations

### Optional Enhancements (Future)
1. **Dynamic Credentials**: Backend API endpoint for TURN credentials with expiration
2. **Monitoring**: Prometheus metrics for coturn server
3. **Load Balancing**: Multiple TURN servers for high availability
4. **Credential Rotation**: Automated password rotation script

### Security Hardening
1. Rate limiting on TURN allocations
2. IP allowlist for known clients (if applicable)
3. Regular security audits of coturn configuration
4. Automated SSL certificate renewal (certbot)

## Success Criteria
- [ ] Coturn container starts with environment-configured credentials
- [ ] Frontend loads TURN configuration from environment variables
- [ ] Voice/video calls successfully use TURN relay when needed
- [ ] Works across different networks (NAT traversal)
- [ ] Documentation enables anyone to self-host with their own credentials
- [ ] No hardcoded credentials anywhere in the codebase
- [ ] SSL/TLS support for production deployments
- [ ] Comprehensive setup documentation for users
