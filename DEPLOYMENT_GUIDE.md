# Zero-Downtime Deployment Guide

This guide explains how to deploy updates to Wabi without interrupting active users.

## Overview

Wabi now supports **zero-downtime deployments** using a two-layer update strategy:

1. **Docker Layer**: Rolling updates with health checks (blue-green deployment)
2. **UI Layer**: SvelteKit update notifications for graceful client-side refreshes

---

## Prerequisites

### Install docker-rollout

[docker-rollout](https://github.com/wowu/docker-rollout) is a CLI plugin that enables rolling updates for Docker Compose services.

**Installation:**

```bash
# Linux/macOS
curl -fsSL https://raw.githubusercontent.com/wowu/docker-rollout/master/install.sh | sh

# Or with Homebrew
brew install wowu/tap/docker-rollout

# Windows (with WSL or Git Bash)
curl -fsSL https://raw.githubusercontent.com/wowu/docker-rollout/master/install.sh | sh
```

**Verify installation:**
```bash
docker rollout --version
```

---

## How It Works

### 1. Health Checks

Both frontend and backend services have health checks configured in `docker-compose.yml`:

**Backend Health Check:**
- Endpoint: `http://localhost:8080/health`
- Checks: Server is running, can accept connections
- Interval: Every 10 seconds
- Start period: 30 seconds (grace period for startup)

**Frontend Health Check:**
- Endpoint: `http://localhost:8080/` (SvelteKit app)
- Checks: App is serving content
- Interval: Every 10 seconds
- Start period: 30 seconds

### 2. Service Dependencies

The frontend service waits for the backend to be **healthy** before starting:

```yaml
depends_on:
  backend:
    condition: service_healthy
```

This ensures the backend is fully operational before the frontend tries to connect.

### 3. Rolling Update Process

When you run `docker rollout`, it:

1. Builds a new "Green" container while the "Blue" (current) one runs
2. Waits for the new container's health check to pass
3. Switches traffic to the Green container
4. Gracefully shuts down the Blue container

**Result**: Users stay connected to the old version until the new one is fully ready.

### 4. SvelteKit Update Detection

The frontend polls for new versions every 60 seconds. When a new deployment is detected:

- The `updated` store in SvelteKit becomes `true`
- A notification appears in the bottom-right corner
- Users can click "Update Now" to refresh, or "Later" to continue

---

## Deployment Workflow

### Standard Update (Zero Downtime)

1. **Make your code changes** (edit frontend/backend files)

2. **Rebuild and rollout the services:**

```bash
# Update backend
docker-compose build backend
docker rollout wabi-backend

# Update frontend
docker-compose build frontend
docker rollout wabi-frontend

# Or update both at once
docker-compose build
docker rollout wabi-backend wabi-frontend
```

3. **Monitor the rollout:**

The rollout command will show you:
- When the new container starts
- Health check status
- When traffic switches over
- When the old container is removed

4. **Verify the update:**

```bash
# Check service status
docker-compose ps

# View logs
docker-compose logs -f backend
docker-compose logs -f frontend
```

### Quick Deploy Script

Create a `deploy.sh` script in your project root:

```bash
#!/bin/bash
set -e

echo "🚀 Starting zero-downtime deployment..."

# Pull latest code (if using git)
git pull origin main

# Build new images
echo "📦 Building Docker images..."
docker-compose build

# Rollout backend first
echo "🔄 Rolling out backend..."
docker rollout wabi-backend

# Wait a moment for backend to stabilize
sleep 5

# Rollout frontend
echo "🔄 Rolling out frontend..."
docker rollout wabi-frontend

echo "✅ Deployment complete!"
echo "Users will see an update notification within 60 seconds."
```

Make it executable:
```bash
chmod +x deploy.sh
```

Use it:
```bash
./deploy.sh
```

---

## User Experience During Deployment

### What Users See

1. **During deployment** (0-30 seconds):
   - No interruption - still connected to old version
   - Chat continues working normally
   - WebSocket connections maintained

2. **After deployment** (within 60 seconds):
   - Update notification appears in bottom-right
   - Message: "New Version Available! A new version of Wabi is ready. Refresh to update."
   - Two buttons: "Update Now" or "Later"

3. **If user clicks "Update Now"**:
   - Page reloads
   - Reconnects to new version
   - Session persists (if logged in)

4. **If user clicks "Later"**:
   - Notification dismisses
   - User continues on old version
   - Will see notification again if they navigate or after next poll (60s)

### Handling Chunk Load Errors

SvelteKit generates versioned JavaScript chunks. If a user is on the old version and tries to navigate after a deployment, they might encounter a `ChunkLoadError` (old chunks are gone).

**Our solution:**
- The `updated` store detects version mismatches
- Users get a notification **before** navigating
- Encourages refresh before errors occur

**Future enhancement** (optional):
You can preserve old assets for one deployment cycle using shared volumes. See "Advanced Configuration" below.

---

## Advanced Configuration

### Adjust Health Check Timing

Edit `docker-compose.yml` if your app needs different timing:

```yaml
healthcheck:
  interval: 10s      # How often to check
  timeout: 5s        # Max time to wait for response
  retries: 3         # Failed attempts before unhealthy
  start_period: 30s  # Grace period during startup
```

### Adjust SvelteKit Poll Interval

Edit `frontend/svelte.config.js`:

```javascript
version: {
  pollInterval: 60000 // milliseconds (60s default)
}
```

Shorter = faster detection, more network requests
Longer = less network traffic, slower detection

### Preserve Old Assets (Advanced)

To prevent chunk load errors for users who haven't refreshed:

1. Use a shared volume for built assets
2. Copy new build to versioned folder
3. Configure your reverse proxy to fall back to previous version

**Example docker-compose.yml modification:**

```yaml
services:
  frontend:
    volumes:
      - ./frontend-builds:/app/builds
```

**Deployment script enhancement:**

```bash
VERSION=$(date +%Y%m%d-%H%M%S)
docker-compose build frontend
docker cp wabi-frontend:/app/build ./frontend-builds/$VERSION
# Keep last 2 versions
ls -t ./frontend-builds | tail -n +3 | xargs rm -rf
docker rollout wabi-frontend
```

---

## Monitoring & Troubleshooting

### Check Health Status

```bash
# Check if services are healthy
docker-compose ps

# Inspect health check logs
docker inspect wabi-backend | grep -A 20 Health
docker inspect wabi-frontend | grep -A 20 Health
```

### Manual Health Check Test

```bash
# Test backend health endpoint
curl http://localhost:8080/health

# Should return:
# {"status":"ok","users":3,"uptime":1234.56}

# Test frontend (should return HTML)
curl http://localhost:3000/
```

### Rollback a Failed Deployment

If a deployment fails health checks:

```bash
# docker-rollout automatically keeps the old container running
# Just fix the issue and try again

# Or manually rollback by rebuilding from a previous commit
git checkout HEAD~1
docker-compose build
docker rollout wabi-backend wabi-frontend
```

### View Rollout Logs

```bash
# docker-rollout outputs real-time status
# You'll see:
# - "Starting new container..."
# - "Waiting for health check..."
# - "Health check passed"
# - "Switching traffic..."
# - "Removing old container..."
```

---

## Comparison: Old vs New Workflow

| Aspect | Old Workflow | New Workflow |
|--------|-------------|--------------|
| **Command** | `docker-compose down && docker-compose up -d` | `docker rollout wabi-backend wabi-frontend` |
| **Downtime** | 10-30 seconds | 0 seconds |
| **User Impact** | Connection lost, page breaks | Seamless, optional update |
| **Risk** | If new version fails, site is down | Old version keeps running until new one is healthy |
| **User Notification** | None (hard refresh required) | Toast notification with update button |
| **WebSocket Connections** | Dropped | Maintained during swap |

---

## CI/CD Integration

### GitHub Actions Example

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Production

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v3

      - name: Install docker-rollout
        run: |
          curl -fsSL https://raw.githubusercontent.com/wowu/docker-rollout/master/install.sh | sh

      - name: Build images
        run: docker-compose build

      - name: Deploy with zero downtime
        run: |
          docker rollout wabi-backend
          sleep 5
          docker rollout wabi-frontend

      - name: Verify deployment
        run: |
          curl -f http://localhost:8080/health
          curl -f http://localhost:3000/
```

---

## Best Practices

1. **Always deploy backend before frontend** - ensures API compatibility
2. **Monitor health check logs** during first rollout to verify timing
3. **Test in staging first** - use the same rollout process in staging environment
4. **Keep deployment atomic** - if backend + frontend changes are tightly coupled, deploy them together
5. **Communicate updates** - let users know new features are available via the update notification

---

## FAQ

**Q: What happens if health check never passes?**
A: docker-rollout will timeout after 5 minutes and keep the old container running. Fix the issue and try again.

**Q: Can users opt out of update notifications?**
A: Currently no, but you could add a "Don't show again" option in `+layout.svelte` that sets a localStorage flag.

**Q: Does this work with the Tauri desktop app?**
A: The SvelteKit update detection works, but desktop apps would need to bundle the new version. Consider implementing auto-update with Tauri's updater plugin.

**Q: What if I want instant updates without user action?**
A: You can auto-reload by changing the update handler in `+layout.svelte`:

```typescript
$: if ($updated) {
  window.location.reload(); // Auto-reload instead of showing notification
}
```

**Q: How do I disable update polling?**
A: Remove or comment out the `version.pollInterval` in `svelte.config.js`.

---

## Summary

You've now implemented a production-grade deployment system for Wabi:

✅ Zero-downtime Docker updates with health checks
✅ Graceful frontend update notifications
✅ User-controlled refresh timing
✅ Automatic version detection

**Next Steps:**
1. Test the deployment workflow in your environment
2. Customize the update notification styling if desired
3. Set up automated deployments with CI/CD
4. Monitor user adoption of updates

Happy deploying! 🚀
