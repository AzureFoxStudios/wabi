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

  "backend": {
    "entry": "./backend/index.ts",
    "socketEvents": ["your:event"],
    "socketEventPermissions": {
      "your:event": ["events.emit"]
    }
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
  },

  "permissions": ["events.emit", "users.read"]
}
```

### 3. Backend Plugin (backend/index.ts)

```typescript
import type { BackendPlugin } from '../../backend/src/plugins/types';

const plugin: BackendPlugin = {
  name: 'your-plugin-name',

  async onLoad(ctx) {
    console.log('Plugin loaded!');
  },

  socketHandlers: {
    'your:event': async (socket, data, ctx) => {
      // Handle socket event
      ctx.emit?.('response:event', { result: 'success' });
    }
  },

  // Hook into core events
  onMessage(channelId, message, ctx) {
    // React to messages
  }
};

export default plugin;
```

## 🔐 Permission Model

Plugins are now capability-gated. The backend only exposes context methods/data when the plugin declares matching permissions.

### Available permissions

- `messages.read` — read channel messages through `ctx.messages`.
- `messages.write` — reserved for future message mutation APIs.
- `users.read` — read user data through `ctx.users`.
- `channels.read` — read channel data through `ctx.channels`.
- `channels.manage` — reserved for future channel mutation APIs.
- `events.emit` — broadcast events through `ctx.emit` and `ctx.emitToChannel`.

### Context services (permission-gated)

Instead of direct mutable maps, plugins receive narrow service wrappers:

- `ctx.users?.list()`
- `ctx.users?.getBySocketId(socketId)`
- `ctx.channels?.list()`
- `ctx.channels?.getById(channelId)`
- `ctx.messages?.listByChannel(channelId)`
- `ctx.emit?.(...)`
- `ctx.emitToChannel?.(...)`
- `ctx.hasPermission(permission)`

### Validation and safety

- Unknown permissions are rejected at load time.
- Unsafe permission formats are rejected at load time.
- `backend.socketEventPermissions` is validated; unknown entries fail plugin load.
- If a socket handler requires permissions the plugin did not request, handler registration is denied and surfaced in plugin status/admin APIs.

## 🔌 Available Hooks

### Backend Hooks

- `onLoad(ctx)` - Called when plugin loads
- `onConnection(socket, ctx)` - Called when user connects
- `onDisconnect(socket, ctx)` - Called when user disconnects
- `onMessage(channelId, message, ctx)` - Called on new message
- `onChannelCreate(channel, ctx)` - Called on channel creation
- `onUserJoin(user, ctx)` - Called when user joins
- `socketHandlers` - Custom socket event handlers

### Plugin Storage

```typescript
// Save data
await ctx.storage.set('key', { your: 'data' });

// Load data
const data = await ctx.storage.get('key');

// Delete data
await ctx.storage.delete('key');

// List all keys
const keys = await ctx.storage.list();
```

## 🔁 Migration Guide for Existing Plugins

If your plugin predates permission gating, migrate as follows:

1. **Update permission naming** to dot notation (`users.read`, not `users:read`).
2. **Declare required permissions** in `plugin.json > permissions`.
3. **Add per-socket-handler requirements** in `backend.socketEventPermissions`.
4. **Replace direct map access**:
   - `ctx.users.get(id)` → `ctx.users?.getBySocketId(id)`
   - `ctx.channels.get(id)` → `ctx.channels?.getById(id)`
   - `ctx.channelMessages.get(id)` → `ctx.messages?.listByChannel(id)`
5. **Guard emits**:
   - `ctx.emit(...)` → `ctx.emit?.(...)`
   - `ctx.emitToChannel(...)` → `ctx.emitToChannel?.(...)`
6. **Optional safety checks** with `ctx.hasPermission(...)` before using gated APIs.

## 📊 Example Plugins

### Agile Tools
Located in `plugins/agile-tools/`
- Task management
- Sprint planning
- Burndown charts

## 🚀 Adding Your Plugin

1. Create your plugin folder in `plugins/`
2. Add `plugin.json` manifest
3. Implement backend/frontend
4. Restart server - it auto-loads!

## 🔥 Pro Tips

- Keep plugins self-contained
- Use plugin storage for persistence
- Socket events should be namespaced (e.g., `task:create`)
- Test with plugin disabled to ensure core works
- Document your plugin's events and API

## 🔒 Security Notes

- Plugins run in the same process (no sandboxing yet)
- Trust plugins you install
- Review plugin code before enabling
- Denied permission errors are surfaced in plugin status/admin APIs
- Disable with `"enabled": false` in plugin.json

**The system is yours - build whatever you want!**
