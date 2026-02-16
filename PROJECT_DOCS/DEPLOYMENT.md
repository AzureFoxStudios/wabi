# Wabi Chat - Deployment Guide

## Overview

Wabi Chat is designed to be self-deployable on bare-metal Linux. This guide covers setup with Docker Compose and Caddy reverse proxy.

## Prerequisites

- Docker & Docker Compose
- Caddy (as reverse proxy)
- Linux server with domain name

## Quick Start

### 1. Clone & Configure

```bash
git clone https://github.com/AzureFoxStudios/wabi.git
cd wabi
cp .env.example .env
```

### 2. Edit `.env` for Your Domain

```bash
# .env
FRONTEND_URL=https://wabi.chat
PUBLIC_URL=https://wabi.chat
ALLOWED_ORIGINS=https://wabi.chat
NODE_ENV=production
```

Replace `wabi.chat` with your actual domain.

### 3. Start Services

```bash
./scripts/deploy-clean.sh
```

Services:
- **Backend**: `http://localhost:8080` (internal)
- **Frontend**: `http://localhost:3000` (internal)
- **TURN server**: Optional, use `--profile turn` to enable

### 4. Configure Caddy Reverse Proxy

Caddy automatically handles WebSocket upgrades and SSL certificates. Create a `Caddyfile`:

```caddyfile
wabi.chat {
  # Serve frontend static files
  root * /var/www/wabi-frontend

  # Proxy /socket.io to backend (WebSocket)
  reverse_proxy /socket.io http://localhost:8080 {
    header_uri -X-Forwarded-Prefix /socket.io
  }

  # Proxy /api and other endpoints to backend
  reverse_proxy /api http://localhost:8080
  reverse_proxy /uploads http://localhost:8080
  reverse_proxy /emotes http://localhost:8080
  reverse_proxy /health http://localhost:8080

  # Serve frontend app for all other routes (SPA)
  try_files {path} /index.html
}
```

Or use the auto-generated Caddyfile from your deployment script.

Start Caddy:
```bash
caddy run --config Caddyfile
```

Caddy will:
- Automatically obtain SSL certificate
- Forward `Upgrade` and `Connection` headers for WebSocket
- Proxy all traffic to Docker services

### 5. Verify Connection

Visit: `https://wabi.chat`

Check diagnostics page:
```bash
curl https://wabi.chat/health/cors
```

Expected output:
```json
{
  "allowedOrigins": ["https://wabi.chat"],
  "isAllowed": true,
  "requestOrigin": "https://wabi.chat",
  "nodeEnv": "production"
}
```

## Environment Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `FRONTEND_URL` | Frontend domain (CORS origin) | `https://wabi.chat` |
| `PUBLIC_URL` | File upload base URL | `https://wabi.chat` |
| `ALLOWED_ORIGINS` | Explicit CORS whitelist (optional) | `https://wabi.chat` |
| `NODE_ENV` | Node environment | `production` |
| `PORT` | Backend listen port | `8080` |
| `TURN_*` | WebRTC TURN server config | See `.env.example` |

## Troubleshooting

### WebSocket Connection Fails

**Symptom**: Client shows `connect_error` in console

**Check**:
1. Verify `FRONTEND_URL` matches your domain:
   ```bash
   docker compose exec backend curl http://localhost:8080/health/cors
   ```

2. Check Caddy is forwarding WebSocket headers:
   ```bash
   curl -i -N \
     -H "Connection: Upgrade" \
     -H "Upgrade: websocket" \
     -H "Origin: https://wabi.chat" \
     "https://wabi.chat/socket.io/?EIO=4&transport=websocket"
   # Should return: HTTP/1.1 101 Switching Protocols
   ```

3. Check browser console for specific error messages

### CORS Rejected

**Symptom**: Logs show `[CORS] Rejected origin: ...`

**Fix**: Ensure `.env` has correct domain:
```bash
# .env
FRONTEND_URL=https://your.domain
PUBLIC_URL=https://your.domain
```

Restart backend:
```bash
docker compose restart backend
```

### Caddy SSL Issues

**Issue**: Caddy can't obtain certificate

**Cause**:
- Domain DNS not pointing to server
- Port 80/443 blocked by firewall
- Caddy not running with `--agree-tos`

**Fix**:
```bash
# Test DNS resolution
nslookup wabi.chat

# Ensure ports open
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Restart Caddy with verbose logging
caddy run --config Caddyfile --debug
```

## Production Checklist

- [ ] Domain pointing to server IP
- [ ] Firewall allows ports 80, 443, 8080, 3000
- [ ] `.env` configured with production domain
- [ ] `TURN_SHARED_SECRET` is long, random, and not reused
- [ ] Backups configured for `/app/data` volume
- [ ] Caddy running under systemd/supervisor
- [ ] Log rotation configured for Docker containers

## Systemd Service (Optional)

Create `/etc/systemd/system/wabi-docker.service`:

```ini
[Unit]
Description=Wabi Chat Docker Services
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=/root/wabi
ExecStart=/root/wabi/scripts/deploy-clean.sh
ExecStop=/usr/bin/docker compose -f /root/wabi/docker-compose.yml stop
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable wabi-docker
sudo systemctl start wabi-docker
```

## Support

- Check `/app/data/chat.db` for database issues
- Docker logs: `docker compose logs -f backend`
- Test page: `https://wabi.chat/test`

---

**Last updated**: 2026-01-26
**Tested on**: Ubuntu 22.04 LTS with Docker Compose 2.x and Caddy 2.7.x
