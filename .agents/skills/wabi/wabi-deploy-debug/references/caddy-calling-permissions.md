# Caddy calling Permissions-Policy / CSP (Tim)

## File
`/home/tim/Desktop/Wabi/Caddyfile.tunnel` (also keep local `Caddyfile.tunnel` in repo in sync).

## Bad defaults (block getUserMedia / getDisplayMedia)
```
Permissions-Policy "camera=(), microphone=(), geolocation=()"
Content-Security-Policy "... connect-src 'self' wss:; ..."  # no https:/ws, thin media-src
```

## Calling-friendly values
```
X-Frame-Options "SAMEORIGIN"
Permissions-Policy "camera=(self), microphone=(self), display-capture=(self), geolocation=()"
Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self' https: wss: ws:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
```

## Apply
```bash
# after editing Caddyfile.tunnel on Tim
cd /home/tim/Desktop/Wabi
docker compose restart caddy-tunnel   # container name may be wabi-tunnel-caddy
curl -sI http://127.0.0.1:8088/health | grep -i permissions
# expect camera=(self), microphone=(self)
```

## Note
If CF edge injects a second CSP, both may appear. Ensure **no** response line forces `camera=()` without self.
