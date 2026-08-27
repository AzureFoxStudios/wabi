# Cloudflare CORS Header Stripping

## Problem
Cloudflare's reverse proxy for named tunnels strips `Access-Control-Allow-Origin` headers from responses, even when the upstream server (wabi-server) correctly sets them.

## Symptoms
- `localhost:3000` CORS works: `Access-Control-Allow-Origin: https://wabi.chat` present
- `wabi.chat` CORS fails: `Access-Control-Allow-Origin` header missing
- Browser console: `Cross-Origin Request Blocked` even with correct origin

## Root Cause
Named tunnels use Cloudflare's edge infrastructure which doesn't automatically forward dynamic CORS headers from upstream responses.

## Solutions

### 1. Caddy Configuration (requires tunnel restart)
Add header forwarding to `Caddyfile.tunnel`:
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

### 2. Cloudflare Dashboard (named tunnel)
For named tunnels, the configuration is stored in Cloudflare's dashboard:
1. Go to Cloudflare dashboard → Zero Trust → Tunnels
2. Edit your tunnel's Caddy configuration
3. Add the `header_up` directives above
4. Save and restart the tunnel

### 3. Quick Tunnel Alternative
Use `cloudflared tunnel --url http://caddy-tunnel:8088` which reads the local `Caddyfile.tunnel` file automatically.

## Verification
```bash
# Test localhost
curl -s -H "Origin: https://wabi.chat" -X OPTIONS http://localhost:3000/api/auth/login -D - | grep "access-control-allow-origin"

# Test wabi.chat (should now show header)
curl -s -H "Origin: https://wabi.chat" -X OPTIONS https://wabi.chat/api/auth/login -D - | grep "access-control-allow-origin"
```

## Key Insight
The issue is at the **proxy layer**, not the application. wabi-server's CORS configuration is correct; Cloudflare needs explicit instructions to pass through the headers.