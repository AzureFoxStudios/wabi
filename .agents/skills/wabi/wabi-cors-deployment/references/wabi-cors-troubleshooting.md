# Wabi CORS Troubleshooting

## Session 2026-07-27 CORS Debug Log

### Problem
After frontend rebuild with `VITE_SOCKET_URL="https://wabi.chat"`, the browser console showed:
```
[ServerUrl] Resolved: http://100.87.255.66:3001 (source: dev_vite)
Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource at http://100.87.255.66:3001/api/public/frontend-app-metadata
```

### Root Cause Analysis

1. **Frontend was still in dev mode** - The `dev_vite` source indicates the frontend thinks it's running from a Vite dev server on port 5173, not as a production build.

2. **Environment variable not persisted** - The `VITE_SOCKET_URL` env var was passed during build but the browser had cached the old JavaScript.

3. **Cloudflare stripping CORS headers** - Even after setting `WABI_CORS_ORIGINS`, the `Access-Control-Allow-Origin` header was missing from wabi.chat responses.

### Solutions Applied

1. **Rebuilt frontend with explicit env var:**
   ```bash
   cd frontend && rm -rf build .svelte-kit
   VITE_SOCKET_URL="https://wabi.chat" STATIC_BUILD=1 bun run build
   ```

2. **Rebuilt wabi-server to embed new frontend:**
   ```bash
   cargo build --release -p wabi-server
   ```

3. **Restarted server with CORS origins:**
   ```bash
   WABI_CORS_ORIGINS="https://wabi.chat,http://localhost:3000,http://localhost:5173" ./target/release/wabi-server ...
   ```

4. **Updated Caddyfile.tunnel for header forwarding:**
   ```caddy
   header_up Access-Control-Allow-Origin {upstream_response.header.Access-Control-Allow-Origin}
   header_up Access-Control-Allow-Credentials {upstream_response.header.Access-Control-Allow-Credentials}
   header_up Access-Control-Allow-Methods {upstream_response.header.Access-Control-Allow-Methods}
   header_up Access-Control-Allow-Headers {upstream_response.header.Access-Control-Allow-Headers}
   ```

### Remaining Issue

Cloudflare named tunnel requires dashboard configuration to pass through CORS headers. Local Caddyfile changes are not effective until the tunnel is reconfigured.

### Verification Commands

Check localhost CORS:
```bash
curl -s -H "Origin: https://wabi.chat" -X OPTIONS http://localhost:3000/api/auth/login -D - | grep -i "access-control"
```

Check production CORS:
```bash
curl -s -H "Origin: https://wabi.chat" -X OPTIONS https://wabi.chat/api/auth/login -D - | grep -i "access-control"
```

### Key Insight

The `AllowOrigin::predicate` approach in the Rust CORS layer does NOT echo the origin back - it only checks if the origin is allowed. For CORS with credentials to work (which wabi uses), you MUST use `AllowOrigin::list` with explicit origins, which requires setting `WABI_CORS_ORIGINS`.