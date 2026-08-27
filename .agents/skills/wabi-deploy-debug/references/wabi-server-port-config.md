# wabi-server Port Configuration

## Default Port
wabi-server defaults to port **3000** (see `core/crates/wabi-server/src/main.rs:126`):
```rust
#[arg(short, long, default_value = "3000")]
port: u16,
```

## Port Usage Contexts
| Context | Port | Notes |
|---|---|---|
| Production wabi-server | 3000 | Caddy reverse_proxy target |
| Local dev (manual start) | 3001 | Common dev convention, NOT default |
| Docker compose (Tim) | 3001 (host) → 3000 (container) | `WABI_PORT_OUT` env var |
| Caddy tunnel | 3000 | `reverse_proxy wabi-server:3000` |

## Critical: Caddy Expects Internal Port 3000
The Caddyfile.tunnel config:
```caddy
reverse_proxy wabi-server:3000 {
    header_up X-Forwarded-Proto https
}
```

This means:
- **Internal** wabi-server MUST bind to port 3000
- Caddy proxies `:8088 → wabi-server:3000`
- If you start wabi-server on 3001, Caddy gets connection refused

## Verification
```bash
# Check what port wabi-server is actually listening on
lsof -i :3000 -i :3001

# Check process command line
ps aux | grep wabi-server | grep -v grep

# Health check on expected port
curl -s http://localhost:3000/health  # Should be 200
curl -s http://localhost:3001/health  # May be 200 if on wrong port
```

## Common Mistake
Starting wabi-server manually with default port 3001:
```bash
# WRONG for Caddy integration
./wabi-server --port 3001

# CORRECT for Caddy integration  
./wabi-server --port 3000
```

Or using the hardcoded dev key:
```bash
WABIDB_ROOT_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  ./wabi-server --port 3000 --host 127.0.0.1 --data-dir ./data
```