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
  io: Server,                    // Socket.IO server
  app: Express,                  // Express app
  channels: Map<string, any>,    // All channels
  users: Map<string, any>,       // All users
  channelMessages: Map<...>,     // All messages
  storage: PluginStorage,        // Persistent storage
  emit: (event, data) => void,   // Broadcast to all
  emitToChannel: (...) => void   // Emit to specific channel
}
```

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

## 📊 Example Plugins

### Agile Tools
Located in `plugins/agile-tools/`
- Task management
- Sprint planning
- Burndown charts

## 🎯 Performance Impact

### Base App (No Plugins)
- Bundle: ~130KB
- Memory: ~20-30MB
- Features: Chat, channels, DMs

### With All Plugins
- Bundle: +150KB
- Memory: +100MB
- Features: Everything above + calls + tools

**Users only load plugins they enable!**

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

## 🎨 UI Extensions

Plugins can extend:
- **Sidebar panels** - Add new sidebar items
- **Channel views** - Custom channel types
- **Commands** - Slash commands like `/task`
- **Modals** - Pop-up interfaces


## ⚙️ Plugin Path Environment Variables

In production, set explicit plugin paths so plugin loading does not depend on the process launch directory:

- `APP_ROOT` (default: `process.cwd()`)
- `PLUGINS_DIR`
- `PLUGIN_STORAGE_DIR`
- `PLUGIN_INSTALL_CACHE_DIR`
- `PLUGIN_CONFIG_FILE` (optional JSON file, default: `config/plugins.json` relative to `APP_ROOT`)

Resolution precedence is: **environment variables → config file → repo-relative fallback**.

Example:

```bash
APP_ROOT=/app
PLUGINS_DIR=/app/plugins
PLUGIN_STORAGE_DIR=/app/data/.plugin-storage
PLUGIN_INSTALL_CACHE_DIR=/app/data/.plugin-install-cache
```

At startup, Wabi validates these directories and exits if any path is invalid or not writable. Use `/health/plugins` to inspect resolved paths and writability.

## 🔒 Security Notes

- Plugins run in the same process (no sandboxing yet)
- Trust plugins you install
- Review plugin code before enabling
- Disable with `"enabled": false` in plugin.json

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
