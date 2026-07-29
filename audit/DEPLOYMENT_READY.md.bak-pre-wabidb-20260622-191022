# Deployment Readiness Checklist
**Date:** April 28, 2026
**Status:** ✅ READY FOR TESTING

---

## What's Changed

### ✅ Completed
- wabi-node built (14MB Rust binary)
- SpacetimeDB integration complete (no mocks)
- All API endpoints query real STDB tables
- Installation documentation written
- Deployment scripts created

### 📁 New Files Created

| File | Purpose |
|------|---------|
| `INSTALL.md` | Complete installation guide (3 methods) |
| `wabi-serve` | Single-command launcher (native install) |
| `wabi-serve.sh` | Alternative launcher script |
| `docker-compose-wabi-node.yml` | Docker Compose for wabi-node |
| `PROJECT_DOCS/PHASE_1_COMPLETE.md` | Full technical report |

---

## Deployment Methods

### Method 1: Docker (Easiest)
```bash
docker-compose -f docker-compose-wabi-node.yml up -d
```
**Pros:** One command, includes everything  
**Cons:** Requires Docker

### Method 2: Native Install (No Docker)
```bash
./wabi-serve --port 3000
```
**Pros:** Just binaries, no container overhead  
**Cons:** Requires SpacetimeDB installed first

### Method 3: Manual (Most Control)
```bash
# Install SpacetimeDB
curl -sSf https://install.spacetimedb.com | sh

# Start SpacetimeDB
spacetimedb start

# Publish module
spacetimedb publish --module-path spacetimedb/wabi_state_bridge wabi-state-benchmark-v2

# Run wabi-node
./target/release/wabi-node --port 3000
```

---

## Testing Checklist

### ✅ Local Testing (DO THIS FIRST)

```bash
# 1. Start with Docker
docker-compose -f docker-compose-wabi-node.yml up -d

# 2. Check health
curl http://localhost:3000/health

# 3. Test registration
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"test","password":"test123"}'

# 4. Test channels
curl http://localhost:3000/api/channels

# 5. Test messages
curl http://localhost:3000/api/messages/1

# 6. Check logs
docker logs wabi-node
```

**Expected Results:**
- ✅ Health endpoint returns JSON with status "ok"
- ✅ Registration creates user in SpacetimeDB
- ✅ Channels list returns real data from STDB
- ✅ Messages return real data from STDB
- ✅ No errors in logs

### ⏳ Iyoku Testing (Staging - AFTER Local Passes)

```bash
# 1. SSH to Iyoku
ssh ronin@100.104.166.42

# 2. Install SpacetimeDB (if not already)
curl -sSf https://install.spacetimedb.com | sh

# 3. Start SpacetimeDB
spacetimedb start &

# 4. Copy wabi-node binary
scp target/release/wabi-node ronin@100.104.166.42:~/wabi/bin/

# 5. Publish module
spacetimedb publish --module-path ~/wabi/spacetimedb/wabi_state_bridge wabi-state-benchmark-v2

# 6. Run wabi-node
cd ~/wabi/bin
./wabi-node --port 3001 &

# 7. Test from your machine
curl http://100.104.166.42:3001/health
```

**Expected Results:**
- ✅ Accessible from external network
- ✅ Same API responses as local
- ✅ Stable over 24-48 hours
- ✅ No memory leaks, no crashes

### ⏸️ Tim Testing (Production - WAIT UNTIL IYOKU PROVEN)

**DO NOT DEPLOY TO TIM YET.** Wait until:
- [ ] Local testing passes completely
- [ ] Iyoku deployment stable for 48+ hours
- [ ] No bugs discovered in real-world usage
- [ ] Frontend tested and working with wabi-node

---

## Configuration

### Environment Variables

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `WABI_PORT` | `3000` | No | Server port |
| `WABI_HOST` | `0.0.0.0` | No | Server host |
| `WABI_STDB_SERVER` | `http://localhost:3100` | No | STDB proxy URL |
| `WABI_STDB_DATABASE` | `wabi-state-benchmark-v2` | No | Database name |
| `WABI_STDB_TOKEN` | (none) | No | STDB auth token |
| `JWT_SECRET` | (random) | Yes | JWT signing secret |

### Production Values (Tim)

```bash
# .env for Tim
WABI_PORT=3001
WABI_HOST=0.0.0.0
WABI_STDB_SERVER=http://127.0.0.1:3100
WABI_STDB_DATABASE=wabi-state-benchmark-v2
JWT_SECRET=<generate-strong-random-secret>
```

---

## Rollback Plan

If wabi-node has issues on Tim:

```bash
# 1. Stop wabi-node
pkill -f wabi-node

# 2. Restart TypeScript backend
cd ~/wabi
docker-compose up -d backend

# 3. Verify backend is working
curl http://100.96.11.45:8080/health
```

**Downtime:** ~30 seconds  
**Data Loss:** None (all data in SpacetimeDB)

---

## Success Criteria

Before marking Phase 1 complete:

- [x] wabi-node compiles and runs
- [x] All API endpoints work with real STDB
- [ ] Local testing passes (Docker method)
- [ ] Local testing passes (Native method)
- [ ] Iyoku deployment stable 48+ hours
- [ ] Frontend connects successfully
- [ ] No memory leaks or crashes
- [ ] Documentation complete
- [ ] Rollback plan tested

**Current Progress:** 2/9 complete  
**Next Step:** Local testing

---

## Files to Review

1. `INSTALL.md` - Installation guide
2. `wabi-serve` - Deployment script
3. `docker-compose-wabi-node.yml` - Docker configuration
4. `PROJECT_DOCS/PHASE_1_COMPLETE.md` - Technical details

---

*Do not deploy to Tim until all checkboxes complete.*
