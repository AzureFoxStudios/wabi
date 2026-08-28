# Frontend ServerUrl Port Rewrite Issue

**Symptom:** When wabi-server serves the embedded frontend on port 3000, the frontend makes API calls to a different port (3001) causing CORS errors:
```
Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource at http://100.87.255.66:3001/api/public/frontend-app-metadata
```

## Root Cause

`frontend/src/lib/serverUrl.ts` has this logic:
```typescript
// 4. Direct container access: frontend on :3000, backend on :8080 on the same host.
// Keep localhost and LAN/IP access working without requiring a separate reverse proxy.
if (port === '3000') {
    return { url: `${protocol}//${hostname}:3001`, source: 'docker_port_rewrite' };
}
```

This was designed for a Docker setup where:
- Frontend served on port 3000
- Backend API on port 3001

But when using the **embedded-serve pattern** (rust_embed), both frontend and API are served from the same wabi-server binary on port 3000. The frontend incorrectly rewrites to port 3001, breaking same-origin policy.

## Fix

**Option 1: Build with VITE_SOCKET_URL (Recommended)**
```bash
VITE_SOCKET_URL="https://wabi.chat" STATIC_BUILD=1 npm run build
```
This bakes the production domain into the frontend, bypassing the port rewrite logic entirely.

**Option 2: Run wabi-server on port 3001**
The dev default port matches what the frontend expects when it sees port 3000 on the page.

## Verification
```bash
# Check what port the frontend is trying to connect to
curl -s https://wabi.chat | grep -o "serverUrl.*300[01]"

# Test API endpoint from browser console
fetch('/api/public/frontend-app-metadata').then(r => r.json()).then(console.log)
```

## Related
- `wabi-deploy-debug` - main deployment debugging skill
- `wabi-frontend-polish` - frontend polish workflow
- Caddyfile.tunnel - reverse_proxy to wabi-server:3000