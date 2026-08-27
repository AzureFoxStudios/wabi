---
name: wabi-cors-deployment
description: CORS configuration for WabiServer deployments, especially behind Cloudflare tunnels. Covers WABI_CORS_ORIGINS setup, header forwarding, and debugging CORS failures.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [cors, security, wabi, cloudflare, deployment]
    status: active
---

# Wabi CORS Deployment

## Overview

When deploying wabi-server behind Cloudflare or other reverse proxies, CORS headers must be explicitly configured and passed through. The default "mirror origin" approach fails when the proxy strips headers.

## Configuration

### Server-side CORS

Set `WABI_CORS_ORIGINS` environment variable explicitly:

```bash
WABI_CORS_ORIGINS="https://wabi.chat,http://localhost:3000,http://localhost:5173"
```

This tells the Rust `tower_http::cors` layer to:
1. Only allow specific origins (not mirror all)
2. Echo the `Access-Control-Allow-Origin` header for allowed origins
3. Include `Access-Control-Allow-Credentials: true` for credentialed requests

### Proxy Header Forwarding (Caddy)

For Caddy behind Cloudflare tunnel, add header forwarding to `Caddyfile.tunnel`:

```caddy
reverse_proxy wabi-server:3000 {
    header_up X-Forwarded-Proto https
    header_up X-Forwarded-Host {host}
    header_up X-Forwarded-For {http.request.remote.host}
    # Pass through CORS headers
    header_up Access-Control-Allow-Origin {upstream_response.header.Access-Control-Allow-Origin}
    header_up Access-Control-Allow-Credentials {upstream_response.header.Access-Control-Allow-Credentials}
    header_up Access-Control-Allow-Methods {upstream_response.header.Access-Control-Allow-Methods}
    header_up Access-Control-Allow-Headers {upstream_response.header.Access-Control-Allow-Headers}
}
```

### Cloudflare Named Tunnel

Named tunnels (using `--token`) have configuration stored in Cloudflare dashboard, not locally. Changes to local `Caddyfile.tunnel` require:
1. Updating the tunnel config in Cloudflare dashboard, OR
2. Restarting the tunnel service, OR
3. Using a quick tunnel (no token) which reads local Caddyfile

## Verification

### Test localhost CORS

```bash
curl -s -H "Origin: https://wabi.chat" -X OPTIONS http://localhost:3000/api/auth/login -D - 2>/dev/null | grep -i "access-control"
```

Expected output:
```
access-control-allow-credentials: true
access-control-allow-origin: https://wabi.chat
access-control-allow-methods: GET,POST,PUT,DELETE,OPTIONS,PATCH
access-control-allow-headers: authorization,content-type,accept,origin,x-requested-with
```

### Test production CORS

```bash
curl -s -H "Origin: https://wabi.chat" -X OPTIONS https://wabi.chat/api/auth/login -D - 2>/dev/null | grep -i "access-control"
```

**Note:** If `access-control-allow-origin` is missing, Cloudflare is stripping it. You must configure the tunnel to pass through these headers.

## Common Issues

### Issue: CORS headers missing from wabi.chat response

**Cause:** Cloudflare reverse proxy strips dynamic CORS headers.

**Fix:** 
1. Set `WABI_CORS_ORIGINS` on the server
2. Configure Caddy header forwarding
3. Update Cloudflare tunnel configuration OR use quick tunnel

### Issue: Frontend still uses old server URL after deploy

**Cause:** Browser cache or Cloudflare cache.

**Fix:**
1. Hard refresh (Ctrl+F5) in browser
2. Clear browser cache for the domain
3. Purge Cloudflare cache if needed

### Issue: `Access-Control-Allow-Origin` header missing on OPTIONS preflight

**Cause:** `AllowOrigin::predicate` doesn't echo the origin; `AllowOrigin::list` is required for credentials mode.

**Fix:** Ensure `WABI_CORS_ORIGINS` is set; the server uses `AllowOrigin::list(parsed)` when this env var is present.

## Related Skills

- `wabi-deploy` — Full deployment workflow
- `wabi-deploy-debug` — Debugging deployment issues
- `cloudflare-websocket-strip` — WebSocket issues through Cloudflare

## References

- `references/wabi-cors-troubleshooting.md` — Session-specific CORS debug notes