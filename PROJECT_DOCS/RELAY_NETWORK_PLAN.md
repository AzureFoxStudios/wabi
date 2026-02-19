# Wabi Self-Hosted Relay Network Plan
**Last Updated**: 2026-02-05
**Status**: Phase 1 in progress (file relay network implementation underway; SRT remains Phase 2)
**Goal**: Improve file download speeds for US users through community-hosted relay network

---

## Problem Statement

**Current Situation**:
- Origin server located in Singapore (DigitalOcean droplet at 188.166.209.20)
- US users (California) experience 2-5 second download latency
- Geographic distance: ~8,500 miles
- No CDN or geographic distribution
- Inefficient file serving: blocking `readFileSync()`, no streaming, no compression

**Impact**:
- Poor user experience for US-based users
- High bandwidth load on origin server
- No fault tolerance (single point of failure)

---

## Recommended Solution: Self-Hosted Community Relay Network

### Philosophy Alignment

✅ **Self-hosted**: No dependence on corporate CDNs (Cloudflare, BunnyCDN, etc.)
✅ **Privacy-first**: No third-party tracking, community-owned infrastructure
✅ **Community-driven**: Volunteers donate $5 VPS to help wabi
✅ **Open source**: Full transparency, auditable, modifiable
✅ **No bloat**: Simple architecture, minimal dependencies

### Why NOT Commercial CDN

**Rejected Approaches**:
- ❌ **Cloudflare**: Against wabi philosophy, barbaric content policies
- ❌ **BunnyCDN/CloudFront**: Corporate dependency, recurring costs
- ❌ **Google Cloud CDN**: Against self-reliant principles

**Decision**: Build our own relay network that community members can host

---

## Architecture Overview

### Three-Tier Hybrid System

```
┌─────────────────────────────────────────────────────────────────┐
│  Tier 1: Direct P2P (WebRTC Data Channels)                     │
│  User A ←──WebRTC Direct Transfer──→ User B (both online)      │
│  • Zero server storage needed                                   │
│  • Leverages existing wabi WebRTC infrastructure               │
│  • Instant transfers, no latency                                │
└─────────────────────────────────────────────────────────────────┘
                          ↓ (User offline or P2P fails)
┌─────────────────────────────────────────────────────────────────┐
│  Tier 2: Community Relay Servers                               │
│  User A → Upload → Relay 1 (US West)                          │
│                    Relay 2 (US East)                           │
│                    Relay 3 (EU)                                │
│  • Nginx caching + Node.js sync service                        │
│  • Runs on $5 VPS or community-donated servers                │
│  • Client auto-selects nearest relay via latency test         │
└─────────────────────────────────────────────────────────────────┘
                          ↓ (Relay sync)
┌─────────────────────────────────────────────────────────────────┐
│  Tier 3: Relay Synchronization                                 │
│  Origin (Singapore) ←→ Syncthing ←→ All Relays                │
│  • Automatic file sync between origin and relays               │
│  • Real-time propagation of new uploads                        │
│  • Handles conflicts and deletions automatically               │
└─────────────────────────────────────────────────────────────────┘
```

### Key Technologies

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Origin Server** | Node.js + Fastify | Main wabi server (existing) |
| **Relay Server** | Nginx | Caching proxy for file serving |
| **File Sync** | Syncthing | P2P automatic sync between servers |
| **P2P Transfer** | WebRTC | Browser-to-browser direct file transfer |
| **Relay Registry** | SQLite | Track active relays, health status |
| **Routing** | Client-side latency measurement | Select fastest relay |

---

## Repository Architecture

### Main Repository: `wabi` (this repo)

**Changes Required**:
1. Backend optimization (streaming, cache headers)
2. Relay registry API endpoints
3. Frontend relay selection logic
4. WebRTC P2P file transfer
5. Database schema for relay tracking

### New Repository: `wabi-relay` (to be created)

**Purpose**: Community-deployable relay server

**Contents**:
- Nginx caching proxy configuration
- Node.js sync + health reporter
- Syncthing Docker setup
- One-command installation script
- Community contribution docs

**Why Separate**:
- Community members clone just relay code (not full wabi codebase)
- Independent versioning
- Clearer separation of concerns
- Easier distribution

---

## Implementation Plan

### MVP Timeline: 10 Days

**Days 1-2: Backend Optimization**
- Replace `readFileSync()` with `createReadStream()` for efficient streaming
- Add HTTP range request support (enables video seeking, download resume)
- Add cache-friendly headers (Cache-Control, ETag, Last-Modified)
- Add gzip compression for compressible files

**Day 3: Relay Registry System**
- Add relay management endpoints:
  - `GET /api/relays` - Returns list of active relays
  - `POST /api/relay/register` - Register a new relay
  - `POST /api/relay/health` - Health check from relay
- Create `relays` table in SQLite database
- Implement health monitoring (remove dead relays after 5 min timeout)

**Days 4-6: Relay Server Application (wabi-relay repo)**
- Create new repository: `wabi-relay`
- Nginx caching proxy configuration
- Node.js sync service and health reporter
- Docker Compose for one-command deployment
- One-command installation script for VPS

**Days 7-8: WebRTC P2P File Transfer**
- Leverage existing WebRTC infrastructure from screen sharing
- Add P2P file transfer UI in chat
- File chunking and transfer (64kB chunks)
- Fallback to relay when recipient offline
- Reuse signaling from `backend/src/handlers/webrtc.ts`

**Day 9: Syncthing Setup**
- Install Syncthing on origin server
- Configure automatic file sync to relay
- Test file sync and deletion propagation
- Document Syncthing setup for community relays

**Day 10: Testing & Community Docs**
- Deploy first community relay (US West)
- Create comprehensive `RELAY_SETUP.md` for community contributors
- Performance testing and verification
- Document troubleshooting and support

### Week 2-3: Network Expansion

**Goals**:
- Community members deploy 2-3 additional relays
- Geographic coverage across US East, EU, Asia
- Public relay registry dashboard
- Advanced monitoring and health alerts

---

## Files to Create/Modify

### In Main `wabi` Repository

#### Backend Changes

1. **`backend/src/server.ts`** (MODIFY)
   - Lines 1291-1331: Replace file serving with streaming
   - Add relay registry endpoints

2. **`backend/src/api/relayRoutes.ts`** (CREATE)
   - Relay registration and health check logic
   - Relay list API with geographic metadata

3. **`backend/src/db/schema.sql`** (MODIFY)
   - Add `relays` table with id, url, location, region, api_key, health status

#### Frontend Changes

4. **`frontend/src/lib/relaySelector.ts`** (CREATE)
   - Fetch relay list from origin
   - Measure latency to each relay
   - Select fastest relay with fallback

5. **`frontend/src/lib/p2pFileTransfer.ts`** (CREATE)
   - WebRTC data channel setup
   - File chunking and transfer
   - Progress tracking

6. **`frontend/src/lib/components/Chat.svelte`** (MODIFY)
   - Add P2P file transfer option
   - Relay-aware URL construction

7. **`frontend/src/lib/components/MessageList.svelte`** (MODIFY)
   - Use relay URLs for downloads instead of origin

#### Documentation

8. **`RELAY_NETWORK.md`** (CREATE)
   - Architecture overview
   - Community contribution model

9. **`.env.example`** (MODIFY)
   - Add relay network configuration

10. **`DEPLOYMENT.md`** (MODIFY)
    - Add relay network section

---

### In New `wabi-relay` Repository

1. **`README.md`** - Quick start guide
2. **`docker-compose.yml`** - Nginx + Syncthing + health reporter
3. **`nginx/nginx.conf`** - Caching proxy config
4. **`sync/health-reporter.js`** - Reports to origin every 60s
5. **`sync/register.js`** - Registers relay on startup
6. **`syncthing/`** - Syncthing configuration
7. **`.env.example`** - Relay configuration template
8. **`install.sh`** - One-command installation
9. **`CONTRIBUTING.md`** - Community guidelines

---

## Performance Impact

**Expected Results**:
- **US West Coast**: 50-200ms (vs 2000-5000ms) = **40-100x faster**
- **US East Coast**: 100-300ms (vs 2000-5000ms) = **20-50x faster**
- **EU**: 200-500ms (if EU relay deployed)
- **Origin bandwidth**: Reduced by 80-90%
- **Cache hit rate**: 90-95% after sync

**Before Relay Network**:
```
California User → Singapore Server (8,500 miles)
RTT: 150-250ms + transfer time = 2-5 seconds total
```

**After Relay Network**:
```
California User → US West Relay (local VPS)
RTT: 10-50ms + cached delivery = 50-200ms total
```

**With P2P**:
```
User A ←→ WebRTC Direct Transfer ←→ User B
RTT: 0ms (direct browser-to-browser)
```

---

## Cost Analysis

### Community-Hosted Model (FREE)

**Model**: Community volunteers donate $5 VPS to help wabi
- **Your Cost**: $0 (community-funded)
- **Community Cost**: $5-10/month per volunteer
- **Example**: 5 volunteers = 5 relays worldwide = excellent coverage

**Precedent**: Mastodon (15,000+ instances), PeerTube (1,000+ servers), Matrix, Tor

### You Host 2-3 Strategic Relays

**VPS Requirements**:
- 1GB RAM, 20GB storage, 1TB bandwidth
- Providers: DigitalOcean ($6/mo), Linode ($5/mo), Vultr ($5/mo), Hetzner (€4.51/mo)

**Strategic Locations**:
- US West (San Francisco): $5/month
- US East (New York): $5/month
- EU (Frankfurt): $5/month (optional)

**Total**: $10-15/month for 2-3 relays

### Comparison vs Commercial CDN

| Solution | Monthly Cost | Control | Privacy | Community |
|----------|-------------|---------|---------|-----------|
| BunnyCDN | $0.50-$5 | Low | Medium | No |
| Cloudflare | $0 (free) | None | Low | No |
| **Self-Hosted** | **$0-15** | **Full** | **High** | **Yes** |

---

## Technology Deep Dive

### Why Syncthing?

**Advantages**:
- ✅ Zero-config P2P sync between servers
- ✅ Minimal resources (works on $5 VPS)
- ✅ Automatic conflict resolution
- ✅ Handles file deletions automatically
- ✅ Works behind NAT/firewalls
- ✅ Battle-tested and reliable
- ✅ Open source (MPL 2.0)

**Alternatives Considered**:
- **MinIO**: Too heavy (8-16GB RAM), complex clustering
- **SeaweedFS**: Better (2-4GB RAM), but cross-DC replication needs enterprise license
- **lsyncd + rsync**: Simpler but one-way only, manual setup
- **Webhook + HTTP pull**: More complex, requires custom implementation

**Decision**: Syncthing for MVP, can migrate to SeaweedFS if S3 API needed later

### Why WebRTC P2P?

**Advantages**:
- ✅ Wabi already has WebRTC for screen sharing
- ✅ Reuse existing signaling infrastructure
- ✅ Zero server storage for online-to-online transfers
- ✅ Direct browser-to-browser, maximum speed
- ✅ Reduces load on relays and origin

**Implementation**:
- Use WebRTC data channels (same as screen share)
- File chunked into 64kB pieces
- Progress tracking and resumable transfers
- Falls back to relay if recipient offline

### Why Nginx for Relay?

**Advantages**:
- ✅ Industry-standard caching proxy
- ✅ Battle-tested, high performance (300,000 req/sec)
- ✅ Simple configuration
- ✅ Low resource usage
- ✅ Excellent documentation

**Alternatives Considered**:
- **Varnish**: Faster but more complex, memory-only
- **Squid**: Outdated, single-threaded, worse performance
- **Apache Traffic Control**: Full CDN solution but too complex for MVP

---

## Security & Privacy

### Self-Hosted Advantages

1. **No Third-Party Tracking**: Relays don't add analytics
2. **Community Trust**: Relay operators are wabi community members
3. **Transparent Code**: All relay code open source, auditable
4. **No Vendor Lock-in**: Can switch technologies anytime
5. **Censorship Resistant**: Distributed relays harder to block

### Security Measures

1. **Relay Authentication**: Relays register with API key
2. **Health Monitoring**: Dead/malicious relays auto-removed after 5min
3. **Path Traversal Protection**: Already implemented in origin
4. **Rate Limiting**: Add to prevent relay abuse (future)
5. **Optional E2E Encryption**: Files encrypted before upload (future)

### Trust Model

**Current Plan**: Open relay network (anyone can deploy)
- Pro: Maximum coverage, community-driven
- Con: Need to trust relay operators

**Alternative** (if privacy critical):
- Require relay registration approval
- Whitelist known community members
- Add relay signing/verification

---

## Community Contribution Model

### How to Contribute a Relay

**Requirements**:
- VPS with 1GB RAM, 20GB storage, public IP
- Docker installed
- Basic Linux knowledge (optional - install script handles most)

**Steps**:
1. Clone `wabi-relay` repository
2. Run installation script: `./install.sh`
3. Configure origin URL, location, API key
4. Docker Compose handles the rest
5. Relay auto-registers with origin

**Maintenance**:
- Minimal - Docker handles updates
- Health reporter pings origin automatically
- Syncthing syncs files automatically

### Geographic Coverage

**Priority Regions**:
1. **US West** (California) - HIGH PRIORITY (current user base)
2. **US East** (New York) - High priority
3. **EU** (Frankfurt/London) - Medium priority
4. **Asia** (already covered by origin in Singapore)
5. **South America** - Low priority (future)

### Community Dashboard (Future)

**Ideas**:
- Public map showing relay locations
- Real-time health status
- Bandwidth/storage stats
- "Help fill coverage gaps" gamification
- Community leaderboard

---

## Rollback Plan

### If Relay Network Has Issues

**Immediate Rollback** (no code changes):
- Clients automatically fall back to origin if all relays fail
- No configuration change needed
- Zero data loss

**Disable Relay Selection** (5 minutes):
```bash
# Update frontend .env
VITE_ENABLE_RELAYS=false

# Rebuild frontend
docker-compose build frontend
docker-compose up -d
```

**Remove Relay Servers**:
- Simply shut down relay VPS instances
- Origin continues serving files normally

---

## Success Metrics

### Performance Goals

- [ ] US West Coast users: <200ms download time
- [ ] US East Coast users: <300ms download time
- [ ] Origin bandwidth reduced by 80%+
- [ ] Cache hit rate: 90%+ on relays
- [ ] P2P transfer success rate: 70%+ (when both users online)

### Reliability Goals

- [ ] 99% uptime for origin server
- [ ] Graceful degradation if all relays fail
- [ ] File sync latency: <30 seconds (upload → relay has file)
- [ ] Zero data loss during relay failures

### Community Goals

- [ ] 3+ community-hosted relays within 3 months
- [ ] Simple enough for non-DevOps users to deploy
- [ ] Public relay registry with coverage map
- [ ] Active community contribution

---

## Next Steps

### To Begin Implementation

1. **Review this plan** with team/community
2. **Create `wabi-relay` repository** on GitHub
3. **Start with backend optimization** (Days 1-2)
4. **Build relay registry system** (Day 3)
5. **Develop relay server application** (Days 4-6)
6. **Add WebRTC P2P** (Days 7-8)
7. **Set up Syncthing** (Day 9)
8. **Test with first community relay** (Day 10)

### Open Questions

- [ ] API key generation for relay registration?
- [ ] How to handle relay approval (open vs whitelist)?
- [ ] Monitoring/alerting for relay health?
- [ ] Public dashboard for relay status?
- [ ] Geographic load balancing vs client-side selection?

---

## References

### Research Sources

**Peer-to-Peer Systems**:
- BitTorrent DHT: Faster than IPFS (800ms vs 2.9s for content retrieval)
- IPFS: More resource-intensive, 3x slower than BitTorrent
- WebTorrent: Browser-based P2P via WebRTC

**Relay/CDN Architectures**:
- Apache Traffic Control: Full open-source CDN (complex)
- Nginx caching: Industry standard, simple setup
- Varnish: High performance but memory-only

**Sync Technologies**:
- Syncthing: Zero-config P2P sync, minimal resources
- MinIO: S3-compatible but heavy (8-16GB RAM)
- SeaweedFS: Lighter (2-4GB) but enterprise license for cross-DC
- lsyncd + rsync: Simple but one-way only

**Community Examples**:
- Mastodon: 15,000+ federated instances
- PeerTube: 1,000+ community servers
- Matrix: Hundreds of homeservers
- Tor: 6,000+ volunteer relays

---

## Summary

**Recommended Approach**: Self-hosted community relay network with Syncthing + WebRTC P2P

**Timeline**: MVP in 10 days, full network in 2-3 weeks

**Cost**: $0 (community-hosted) to $15/month (3 relays you host)

**Performance**: 40-100x faster downloads for US users

**Philosophy**: ✅ Self-hosted, ✅ Privacy-first, ✅ Community-driven, ✅ No corporate dependencies

**Risk**: Low (easy rollback, no data migration, no vendor lock-in)

This plan provides maximum performance improvement while preserving wabi's independence, privacy, and community values.
