# TURN Server Setup Guide

This guide will help you set up and configure the integrated coturn TURN server for production voice/video calling in Wabi.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start (Local Development)](#quick-start-local-development)
- [Production Deployment](#production-deployment)
- [SSL/TLS Setup](#ssltls-setup)
- [Firewall Configuration](#firewall-configuration)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

## Prerequisites

- Docker and Docker Compose installed
- A public IP address or domain name (for production)
- SSL/TLS certificates (recommended for production)
- Firewall access to configure ports

## Quick Start (Local Development)

For local testing, you can use the default configuration:

1. **Copy environment files:**
   ```bash
   cp .env.example .env
   cp frontend/.env.example frontend/.env
   ```

2. **Start all services:**
   ```bash
   docker-compose up -d
   ```

3. **Verify TURN server is running:**
   ```bash
   docker logs wabi-coturn
   ```

   You should see output indicating the server started successfully.

The default configuration uses `127.0.0.1` as the external IP, which works for local testing but **will not work** for calls between different networks.

## Production Deployment

For production deployment with internet-facing voice/video calling:

### 1. Generate Secure Credentials

Generate a strong password for TURN authentication:

```bash
openssl rand -base64 32
```

Copy the generated password for use in the next step.

### 2. Configure Root Environment

Edit `.env` in the project root:

```env
# TURN Server Configuration
TURN_EXTERNAL_IP=your.domain.com       # Your public domain or IP
TURN_REALM=your.domain.com             # Your domain (can match EXTERNAL_IP)
TURN_USERNAME=wabi_turn_user           # Any username you prefer
TURN_PASSWORD=<paste_generated_password_here>

# Backend Configuration
BACKEND_PORT=8080
NODE_ENV=production
JWT_SECRET=<generate_another_secure_token>

# Frontend Configuration
FRONTEND_PORT=3000
```

**Important:** Replace:
- `your.domain.com` with your actual domain or public IP address
- `<paste_generated_password_here>` with the password from step 1
- `<generate_another_secure_token>` with another secure token (run `openssl rand -base64 64`)

### 3. Configure Frontend Environment

Edit `frontend/.env`:

```env
# TURN Server Configuration
VITE_TURN_SERVER=your.domain.com       # Must match TURN_EXTERNAL_IP
VITE_TURN_PORT=3478                    # 3478 for TURN, 5349 for TURNS
VITE_TURN_USERNAME=wabi_turn_user      # Must match TURN_USERNAME
VITE_TURN_PASSWORD=<same_password_as_above>
VITE_USE_TURNS=false                   # Set to true if using SSL (port 5349)

# Optional: Disable Google STUN for full independence
VITE_ENABLE_GOOGLE_STUN=false
```

**Important:** The credentials must match exactly between `.env` and `frontend/.env`.

### 4. Start Services

```bash
docker-compose up -d
```

### 5. Verify Configuration

Check that the TURN server loaded your configuration:

```bash
docker logs wabi-coturn
```

Look for output like:
```
=== Coturn Configuration Generated ===
External IP: your.domain.com
Realm: your.domain.com
Username: wabi_turn_user
======================================
```

## SSL/TLS Setup

For production security, enable TURNS (TURN over TLS) using SSL certificates.

### 1. Obtain SSL Certificates

Get a free SSL certificate from Let's Encrypt:

```bash
# Install certbot
sudo apt-get install certbot

# Obtain certificate for your domain
sudo certbot certonly --standalone -d your.domain.com
```

This creates certificates in `/etc/letsencrypt/live/your.domain.com/`:
- `cert.pem` - The certificate
- `privkey.pem` - The private key

### 2. Copy Certificates

Copy the certificates to the TURN server directory:

```bash
mkdir -p turn-server/certs
sudo cp /etc/letsencrypt/live/your.domain.com/cert.pem turn-server/certs/
sudo cp /etc/letsencrypt/live/your.domain.com/privkey.pem turn-server/certs/
sudo chmod 644 turn-server/certs/*
```

### 3. Enable TLS in Configuration

Edit `turn-server/turnserver.conf.template` and uncomment the TLS lines:

```conf
# TLS/TURNS SUPPORT
cert=/etc/coturn/certs/cert.pem
pkey=/etc/coturn/certs/privkey.pem
tls-listening-port=5349
```

### 4. Update Frontend Configuration

Edit `frontend/.env`:

```env
VITE_TURN_PORT=5349
VITE_USE_TURNS=true
```

### 5. Restart Services

```bash
docker-compose restart coturn
docker-compose restart frontend
```

### 6. Certificate Renewal

Let's Encrypt certificates expire after 90 days. Set up automatic renewal:

```bash
# Add renewal cron job
sudo crontab -e

# Add this line (runs renewal check daily at 2am)
0 2 * * * certbot renew --quiet && cp /etc/letsencrypt/live/your.domain.com/*.pem /path/to/wabi/turn-server/certs/ && docker-compose -f /path/to/wabi/docker-compose.yml restart coturn
```

## Firewall Configuration

Your server firewall must allow the following ports:

### Required Ports

```bash
# TURN/STUN signaling (UDP and TCP)
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp

# TURNS (if using TLS)
sudo ufw allow 5349/udp
sudo ufw allow 5349/tcp

# Media relay port range (UDP)
sudo ufw allow 49152:65535/udp
```

### AWS Security Groups

If using AWS, add these inbound rules:

| Type        | Protocol | Port Range    | Source    |
|-------------|----------|---------------|-----------|
| Custom UDP  | UDP      | 3478          | 0.0.0.0/0 |
| Custom TCP  | TCP      | 3478          | 0.0.0.0/0 |
| Custom UDP  | UDP      | 5349          | 0.0.0.0/0 |
| Custom TCP  | TCP      | 5349          | 0.0.0.0/0 |
| Custom UDP  | UDP      | 49152-65535   | 0.0.0.0/0 |

### Google Cloud Firewall

```bash
# TURN/STUN
gcloud compute firewall-rules create turn-server \
  --allow udp:3478,tcp:3478,udp:5349,tcp:5349

# Media relay
gcloud compute firewall-rules create turn-media \
  --allow udp:49152-65535
```

## Testing

### 1. Verify TURN Server is Running

```bash
docker logs wabi-coturn
```

Expected output:
```
0: : INFO: ....
0: : INFO: coturn server started
```

### 2. Test TURN Connectivity

Use the [Trickle ICE](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/) test:

1. Go to https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/
2. Remove the default servers
3. Add your TURN server:
   ```
   turn:your.domain.com:3478
   ```
4. Enter your username and password
5. Click "Gather candidates"

**Expected results:**
- You should see `relay` candidates (indicates TURN is working)
- You should see `srflx` candidates (indicates STUN is working)
- You should NOT see errors about authentication

### 3. Test WebRTC in Browser

1. Open your Wabi app in a browser
2. Open browser DevTools (F12) → Console
3. Initiate a voice or video call
4. Check the console for:
   ```
   [TURN Config] Using configured TURN server
   ```

5. To see ICE candidates, run this in the console while in a call:
   ```javascript
   // This will show the connection stats
   console.log(pc.getStats())
   ```

   Look for candidates with `type: "relay"` (means TURN is being used).

### 4. Test Across Networks

The ultimate test: Make a call between two devices on different networks (e.g., one on WiFi, one on mobile data).

If the call works, your TURN server is properly configured!

## Troubleshooting

### Issue: "TURN server not configured" warning

**Cause:** Environment variables not loaded in frontend.

**Solution:**
1. Ensure `frontend/.env` exists and has correct values
2. Rebuild frontend: `docker-compose build frontend`
3. Restart: `docker-compose up -d`

### Issue: Calls fail between different networks

**Cause:** Firewall blocking TURN ports or incorrect external IP.

**Solution:**
1. Verify `TURN_EXTERNAL_IP` matches your public IP/domain
2. Check firewall allows ports 3478 and 49152-65535
3. Test with Trickle ICE (see Testing section)
4. Check coturn logs: `docker logs wabi-coturn`

### Issue: Authentication errors in Trickle ICE

**Cause:** Username/password mismatch.

**Solution:**
1. Verify credentials match in `.env` and `frontend/.env`
2. Check coturn logs for "user not found" errors
3. Restart coturn: `docker-compose restart coturn`

### Issue: "Permission denied" for certificates

**Cause:** Certificate files not readable by Docker.

**Solution:**
```bash
sudo chmod 644 turn-server/certs/*
```

### Issue: Coturn container crashes on startup

**Cause:** Invalid configuration or environment variable.

**Solution:**
1. Check logs: `docker logs wabi-coturn`
2. Verify environment variables in `.env`
3. Ensure `turnserver.conf.template` has valid syntax
4. Test config generation manually:
   ```bash
   docker-compose run --rm coturn cat /etc/coturn/turnserver.conf
   ```

### Issue: High CPU/memory usage

**Cause:** Too many concurrent connections or media relays.

**Solution:**
1. Limit port range in `turnserver.conf.template`:
   ```conf
   min-port=50000
   max-port=50100
   ```
2. Consider deploying multiple TURN servers
3. Monitor with: `docker stats wabi-coturn`

### Issue: Calls work locally but not in production

**Cause:** Network configuration or NAT issues.

**Solution:**
1. Verify your server has a public IP
2. Check NAT configuration (if behind NAT, use `external-ip=public-ip/local-ip`)
3. Ensure Docker network mode is `host` for coturn
4. Test with online tools like Trickle ICE

## Advanced Configuration

### Using Multiple TURN Servers

For high availability, you can configure multiple TURN servers in `frontend/src/lib/turnConfig.ts`:

```typescript
// Add multiple servers
const turnServers = [
	getTurnConfig('VITE_TURN_SERVER_1', 'VITE_TURN_USERNAME_1', 'VITE_TURN_PASSWORD_1'),
	getTurnConfig('VITE_TURN_SERVER_2', 'VITE_TURN_USERNAME_2', 'VITE_TURN_PASSWORD_2')
].filter(Boolean);
```

### Dynamic Credentials (REST API)

For better security, implement a backend endpoint that generates time-limited credentials:

1. Install `coturn` utilities
2. Implement `/api/turn-credentials` endpoint
3. Generate credentials with expiration
4. Update frontend to fetch credentials before calls

See [coturn REST API documentation](https://github.com/coturn/coturn/wiki/turnserver#turn-rest-api) for details.

## Additional Resources

- [Coturn Documentation](https://github.com/coturn/coturn/wiki/turnserver)
- [WebRTC Trickle ICE Tool](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/)
- [Let's Encrypt Documentation](https://letsencrypt.org/getting-started/)
- [WebRTC Standards](https://webrtc.org/)

## Support

If you encounter issues not covered in this guide:

1. Check Docker logs: `docker-compose logs`
2. Review coturn logs: `docker logs wabi-coturn`
3. Test with Trickle ICE to isolate the issue
4. Check firewall rules: `sudo ufw status`
5. Open an issue on GitHub with logs and configuration (redact credentials!)
