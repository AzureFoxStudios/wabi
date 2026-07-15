# Wabi Installation Guide

## Requirements

- **SpacetimeDB 2.0+** (the database server)
- **wabi-node** (the application server, 14MB binary)

---

## Option 1: Docker (Recommended)

One command, everything included:

```bash
docker-compose up -d
```

This starts:
- SpacetimeDB server
- SpacetimeDB proxy (Caddy)
- wabi-node server
- Module publisher (auto-deploys your schema)

**Access:** `http://localhost:3000`

---

## Option 2: Native Install (No Docker)

### Step 1: Install SpacetimeDB

```bash
# Linux/macOS
curl -sSf https://install.spacetimedb.com | sh

# Windows PowerShell
iwr https://windows.spacetimedb.com -useb | iex
```

### Step 2: Start SpacetimeDB

```bash
spacetimedb start
```

Keep this terminal open, or run as a service.

### Step 3: Publish Your Module

```bash
cd ~/wabi
spacetimedb publish --module-path spacetimedb/wabi_state_bridge wabi-state-benchmark-v2
```

### Step 4: Run wabi-node

```bash
cd ~/wabi
./target/release/wabi-node --port 3000
```

**Access:** `http://localhost:3000`

---

## Option 3: Single Script (Best of Both)

Create `wabi-serve.sh`:

```bash
#!/bin/bash
set -e

# Check if SpacetimeDB is installed
if ! command -v spacetimedb &> /dev/null; then
    echo "Installing SpacetimeDB..."
    curl -sSf https://install.spacetimedb.com | sh
fi

# Start SpacetimeDB if not running
if ! pgrep -f "spacetimedb" > /dev/null; then
    echo "Starting SpacetimeDB..."
    spacetimedb start &
    sleep 3
fi

# Publish module (idempotent)
echo "Publishing module..."
spacetimedb publish --module-path spacetimedb/wabi_state_bridge wabi-state-benchmark-v2 --yes

# Start wabi-node
echo "Starting wabi-node..."
exec ./target/release/wabi-node "$@"
```

Usage:
```bash
chmod +x wabi-serve.sh
./wabi-serve.sh --port 3000
```

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WABI_PORT` | `3000` | Server port |
| `WABI_HOST` | `0.0.0.0` | Server host |
| `WABI_DATA_DIR` | `./data` | Data directory |
| `WABI_STDB_SERVER` | `http://localhost:3100` | SpacetimeDB proxy URL |
| `WABI_STDB_DATABASE` | `wabi-state-benchmark-v2` | Database name |
| `WABI_STDB_TOKEN` | (none) | Auth token (if required) |

### Example `.env` File

```bash
WABI_PORT=3000
WABI_STDB_SERVER=http://localhost:3100
WABI_STDB_DATABASE=wabi-state-benchmark-v2
```

---

## Testing

### Health Check

```bash
curl http://localhost:3000/health
```

Expected:
```json
{"service":"wabi-node","status":"ok","timestamp":"...","version":"0.1.0"}
```

### Test Login

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"test","password":"test123"}'
```

### Test Channels

```bash
curl http://localhost:3000/api/channels
```

---

## Troubleshooting

### "Connection refused" to SpacetimeDB

1. Check STDB is running: `pgrep -f spacetimedb`
2. Check proxy is running: `curl http://localhost:3100/v1/ping`
3. Restart STDB: `pkill spacetimedb && spacetimedb start`

### "Module not found"

```bash
spacetimedb publish --module-path spacetimedb/wabi_state_bridge wabi-state-benchmark-v2
```

### Port already in use

```bash
./wabi-node --port 3001  # Use different port
```

---

## Next Steps

1. Test locally with this guide
2. Deploy to Iyoku (staging) using native install
3. Verify everything works
4. Update Tim (production) using same process

---

*Keep this guide updated as deployment evolves.*
