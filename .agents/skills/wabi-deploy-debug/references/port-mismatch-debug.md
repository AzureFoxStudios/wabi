# Port Mismatch Debug Guide

## Symptom
- `http://localhost:3000` not responding
- `http://localhost:3001/health` returns 200 OK
- `curl -s http://localhost:3000/health` returns "Failed to connect to host"

## Root Cause
The Caddy reverse proxy config (`Caddyfile.tunnel`) expects `wabi-server:3000`, but:
1. The wabi-server was started with `--port 3001` (default dev port)
2. Or the server crashed and was restarted without matching the Caddy expected port
3. Docker compose maps `host:3001→3000` internally, but Caddy proxies to internal port 3000

## Diagnosis Steps
```bash
# 1. Check what ports are listening
lsof -i :3000 -i :3001

# 2. Check process command line
ps aux | grep wabi-server | grep -v grep

# 3. Verify health on expected port
curl -s http://localhost:3000/health    # What Caddy expects
curl -s http://localhost:3001/health    # What might actually be running

# 4. Check Caddy config
grep -A5 "reverse_proxy" Caddyfile.tunnel
```

## Fix
Restart wabi-server on port 3000 (Caddy's expected internal port):
```bash
# Kill existing process
pkill -f "wabi-server.*--port 3001"

# Remove any stale locks
rm -f /home/Ronin/wabi/data/wabidb/.lock

# Start on correct port
cd /home/Ronin/wabi
WABIDB_ROOT_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  ./target/release/wabi-server \
  --port 3000 --host 127.0.0.1 --data-dir ./data \
  > /tmp/wabi-server.log 2>&1 &

# Verify
curl -s http://localhost:3000/health
```

## Prevention
- Always check `Caddyfile.tunnel` reverse_proxy target before starting server
- Default wabi-server port is 3000; dev often uses 3001
- Document port expectations in deployment README

## Related
- `wabi-deploy-debug` - main deployment debugging skill
- `Caddyfile.tunnel` - reverse_proxy configuration
- wabi-server port defaults to 3000, not 3001