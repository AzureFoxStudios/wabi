# 🧩 Plugin System

The chat app uses a modular plugin system that allows anyone to add features without modifying core code.

## 📦 Creating a Plugin

### 1. Create Plugin Directory

```
plugins/
└── your-plugin-name/
    ├── plugin.json          # Plugin manifest
    ├── backend/
    │   └── index.ts         # Backend logic
    └── frontend/
        └── index.ts         # Frontend UI
```

### 2. Define plugin.json

```json
{
  "id": "your-plugin-name",
  "name": "Your Plugin Name",
  "version": "1.0.0",
  "description": "What your plugin does",
  "author": "Your Name",
  "enabled": true,
  "permissions": ["channels:read"],
  "security": {
    "threatNotes": "Describe data exposure, privilege boundaries, and abuse cases."
  },
  "integrity": {
    "algorithm": "sha256",
    "checksum": "<sha256-package-checksum>",
    "signature": "<optional-signature>"
  },
  "signer": {
    "keyId": "ed25519:<short-fingerprint>",
    "publicKey": "<pem-public-key>",
    "algorithm": "ed25519"
  },
  "distribution": {
    "source": "local"
  },
  "capabilities": {
    "tier": "ui-only"
  },

  "backend": {
    "entry": "./backend/index.ts",
    "socketEvents": ["event:name"]
  },

  "frontend": {
    "entry": "./frontend/index.ts",
    "extensions": {
      "sidebar": {
        "icon": "📊",
        "label": "My Feature",
        "component": "./frontend/Panel.svelte"
      }
    }
  }
}
```

> `permissions` and `security.threatNotes` are required for all plugins.

### 3. Backend Plugin (backend/index.ts)

```typescript
import type { BackendPlugin } from '../../backend/src/plugins/types';

const plugin: BackendPlugin = {
  name: 'your-plugin-name',

  async onLoad(ctx) {
    ctx.logger.info('Plugin loaded');
  },

  socketHandlers: {
    'your:event': async (socket, data, ctx) => {
      // Handle socket event
      ctx.emit('response:event', { result: 'success' });
    }
  },

  // Hook into core events
  onMessage(channelId, message, ctx) {
    // React to messages
  }
};

export default plugin;
```

## 🔌 Available Hooks

### Backend Hooks

- `onLoad(ctx)` - Called when plugin loads
- `onConnection(socket, ctx)` - Called when user connects
- `onDisconnect(socket, ctx)` - Called when user disconnects
- `onMessage(channelId, message, ctx)` - Called on new message
- `onChannelCreate(channel, ctx)` - Called on channel creation
- `onUserJoin(user, ctx)` - Called when user joins
- `socketHandlers` - Custom socket event handlers

### Plugin Context

The `ctx` object provides:

```typescript
{
  io: Server,
  httpServer: HttpServer,
  channels: Map<string, any>,
  users: Map<string, any>,
  channelMessages: Map<...>,
  storage: PluginStorage,
  logger: PluginLogger,
  emit: (event, data) => void,
  emitToChannel: (...) => void
}
```

### Plugin Storage

```typescript
await ctx.storage.set('key', { your: 'data' });
const data = await ctx.storage.get('key');
await ctx.storage.delete('key');
const keys = await ctx.storage.list();
```

### HTTP Routes

Backend plugins can expose HTTP endpoints through `routes`.
Routes are mounted under:

`/api/plugins/runtime/:pluginId`

Example:

```typescript
const plugin: BackendPlugin = {
  name: 'my-plugin',
  routes: [
    {
      method: 'get',
      path: '/health',
      handler: async (req, res) => {
        res.json({
          ok: true,
          plugin: req.params.pluginId,
          query: req.query
        });
      }
    },
    {
      method: 'post',
      path: '/echo',
      handler: async (req, res) => {
        const body = await req.json();
        res.status(200).json({ body });
      }
    }
  ]
};
```

The plugin API surface provided to route handlers includes:
- `req.query`, `req.params`, `req.path`, `req.headers`, `req.method`
- `await req.json()`, `await req.text()`, `await req.buffer()`
- `res.status(code).json(payload)`, `res.send(payload)`, `res.set(name, value)`, `res.end()`

Request body size for plugin routes is capped by `PLUGIN_ROUTE_MAX_BODY_BYTES` (default: `2097152`).

## 🔒 Security Controls

- Plugin package checksums are validated before enabling backend plugins.
- Optional Ed25519 signatures are verified when signer metadata is present.
- Trusted signer allowlist is managed by server admins via `/api/plugins/signers`.
- Optional malware scanning can gate plugin load using `PLUGIN_SCAN_POLICY=off|warn|enforce`.
- Scanner integration is command-based via `PLUGIN_SCANNER_CMD` (for example: ClamAV).
- Plugin lifecycle actions write structured audit events with actor, plugin/version, action, result, timestamp, and reason.
- Plugin logs are namespaced as `plugin:<id>` and persisted for admin review.
- Safe mode startup can disable third-party plugins if crash loops are detected.

### Plugin Signing Tooling

Run from repo root:

```bash
npm run plugin:keygen -- --out-dir .wabi-keys
npm run plugin:sign -- --plugin plugins/your-plugin-name --private-key .wabi-keys/<key-id>.private.pem
npm run plugin:verify -- --plugin plugins/your-plugin-name --strict
```

Server admins can choose policy with `PLUGIN_SIGNATURE_POLICY`:
- `warn-allow` (default)
- `signed-only`
- `curated-only`

### ✅ Security Review Checklist (Required)

Each plugin PR/release must include:

- [ ] Least-privilege `permissions` list in `plugin.json`.
- [ ] `security.threatNotes` with abuse cases and mitigations.
- [ ] `integrity.checksum` (sha256) updated for the packaged plugin.
- [ ] Dependencies reviewed and pinned to known-safe versions.
- [ ] Input validation for every socket event and API entrypoint.
- [ ] Data-at-rest and data-in-transit handling documented.
- [ ] Logging avoids secrets/PII and supports incident review.
- [ ] Disable/uninstall behavior tested (plugin-off path).

## 🚀 Adding Your Plugin

1. Create your plugin folder in `plugins/`
2. Add `plugin.json` manifest
3. Implement backend/frontend
4. Restart server - it auto-loads!

### Quick install for test plugins

If a plugin lives under `TEST/<plugin-name>`, install it into `plugins/` first:

- Any OS: `npm run plugin:install:test`
- Optional plugin name: `npm run plugin:install:test -- <plugin-name>`

## 🔥 Pro Tips

- Keep plugins self-contained
- Use plugin storage for persistence
- Socket events should be namespaced (e.g., `task:create`)
- Test with plugin disabled to ensure core works
- Document your plugin's events and API

## 📝 Plugin Ideas

- Polls & surveys
- File sharing with preview
- Code snippet formatting
- Translation bot
- Game integration (chess, trivia)
- Calendar & events
- Music sharing
- Drawing board
- Code collaboration
- Crypto wallet integration

**The system is yours - build whatever you want!**
