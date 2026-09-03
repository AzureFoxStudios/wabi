# Wabi Iyoku Deployment Investigation

## Goal
Deploy wabi-node (Rust server) to Iyoku and verify it works with SpacetimeDB.

## Current Situation
- wabi-node binary is at `~/wabi/bin/wabi-node` on Iyoku
- Iyoku is at `100.104.166.42` (Tailscale)
- Need to find where SpacetimeDB is running
- wabi-node needs `WABI_STDB_SERVER` env var set correctly

## Tasks

### 1. Investigate Iyoku's SpacetimeDB Setup
SSH to Iyoku and find:
```bash
ssh Iyoku@100.104.166.42

# Check what's running
podman ps -a
netstat -tlnp | grep LISTEN
ls -la ~/wabi/
cat ~/wabi/docker-compose.yml 2>/dev/null
cat ~/wabi/.env 2>/dev/null | grep -i stdb
```

### 2. Start wabi-node with Correct Config
Once you find the STDB URL:
```bash
ssh Iyoku@100.104.166.42

# Kill old process
pkill -9 wabi-node

# Start with correct env vars (replace <ACTUAL_URL> with what you find)
cd ~/wabi/bin
WABI_STDB_SERVER=http://localhost:<PORT> WABI_STDB_DATABASE=wabi-state-benchmark-v2 nohup ./wabi-node --port 3001 > wabi-node.log 2>&1 &

# Verify
sleep 3
curl http://localhost:3001/health | jq .
curl http://localhost:3001/api/channels | jq .
```

### 3. Test from Local Machine
```bash
curl http://100.104.166.42:3001/health | jq .
```

### 4. Test wabi.chat
- Open browser to wabi.chat
- Point API endpoint to `http://100.104.166.42:3001`
- Try login/register
- Send a message
- Verify it appears in SpacetimeDB

## Success Criteria
- [ ] wabi-node runs on Iyoku port 3001
- [ ] Health endpoint returns `{"status":"ok"}`
- [ ] API endpoints work (channels, auth, messages)
- [ ] Can login and send message from wabi.chat
- [ ] Mesh with Tim works (if Tim is still running old backend)

## Notes
- Username on Iyoku is `Iyoku` (capital I)
- Use Tailscale SSH: `ssh Iyoku@100.104.166.42`
- wabi-node supports env vars: `WABI_STDB_SERVER`, `WABI_STDB_DATABASE`, `WABI_STDB_TOKEN`
- Default STDB port is usually 3030 (direct) or 3100 (via proxy)
