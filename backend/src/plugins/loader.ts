import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

import fs from 'fs';
import path from 'path';
import type { Server, Socket } from 'socket.io';
import type { Server as HttpServer } from 'http';
import {
  PLUGIN_PERMISSIONS,
  type BackendPlugin,
  type PluginContext,
  type PluginManifest,
  type PluginPermission,
  type PluginStorage
} from './types';

const VALID_PLUGIN_PERMISSIONS = new Set<PluginPermission>(Object.values(PLUGIN_PERMISSIONS));

type LoadedPlugin = {
  plugin: BackendPlugin;
  manifest: PluginManifest;
  permissions: Set<PluginPermission>;
  status: 'active' | 'error';
  errors: string[];
};

export class PluginLoader {
  private plugins: Map<string, LoadedPlugin> = new Map();
  private pluginStatuses: Map<string, { id: string; name: string; version: string; description: string; status: 'active' | 'error'; errors: string[] }> = new Map();
  private pluginsDir: string;
  private storageDir: string;

  constructor(
    private io: Server,
    private httpServer: HttpServer,
    private context: any
  ) {
    // Use environment variables or defaults
    const dataDir = process.env.DATA_DIR || path.join(__dirname, '../../../data');
    const pluginsBaseDir = process.env.PLUGINS_DIR || path.join(__dirname, '../../../plugins');

    this.pluginsDir = pluginsBaseDir;
    this.storageDir = path.join(dataDir, '.plugin-storage');

    // Create storage directory if it doesn't exist
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  async loadAll() {
    console.log('🔌 Loading plugins from:', this.pluginsDir);

    if (!fs.existsSync(this.pluginsDir)) {
      console.log('📁 Creating plugins directory...');
      fs.mkdirSync(this.pluginsDir, { recursive: true });
      return;
    }

    const pluginDirs = fs.readdirSync(this.pluginsDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);

    console.log(`📦 Found ${pluginDirs.length} potential plugins:`, pluginDirs);

    for (const dir of pluginDirs) {
      await this.loadPlugin(dir);
    }

    console.log(`✅ Successfully loaded ${this.plugins.size} plugins`);
  }

  async loadPlugin(pluginId: string) {
    try {
      const pluginPath = path.join(this.pluginsDir, pluginId);
      const manifestPath = path.join(pluginPath, 'plugin.json');

      if (!fs.existsSync(manifestPath)) {
        console.warn(`⚠️  No plugin.json found for ${pluginId}`);
        return;
      }

      const manifest: PluginManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

      // Skip if disabled
      if (manifest.enabled === false) {
        console.log(`⏭️  Plugin ${manifest.name} is disabled, skipping`);
        return;
      }

      // Skip if no backend entry
      if (!manifest.backend?.entry) {
        console.log(`⏭️  Plugin ${manifest.name} has no backend component`);
        return;
      }

      const permissions = this.validateAndNormalizePermissions(manifest);
      const backendEntry = path.join(pluginPath, manifest.backend.entry);

      if (!fs.existsSync(backendEntry)) {
        console.warn(`⚠️  Backend entry not found: ${backendEntry}`);
        return;
      }

      // Dynamic import the plugin
      const pluginModule = await import(backendEntry);
      const plugin: BackendPlugin = pluginModule.default || pluginModule;

      const ctx = this.createContext(pluginId, permissions);

      // Initialize plugin
      await plugin.onLoad?.(ctx);

      const pluginErrors: string[] = [];

      // Register socket handlers
      this.io.on('connection', (socket: Socket) => {
        plugin.onConnection?.(socket, ctx);

        // Register custom socket events
        if (plugin.socketHandlers) {
          for (const [event, handler] of Object.entries(plugin.socketHandlers)) {
            const requiredPermissions = manifest.backend?.socketEventPermissions?.[event] ?? [];
            const missingPermission = requiredPermissions.find(permission => !permissions.has(permission));

            if (missingPermission) {
              const error = `Socket handler "${event}" denied: missing permission ${missingPermission}`;
              if (!pluginErrors.includes(error)) {
                pluginErrors.push(error);
                console.warn(`⚠️  Plugin ${pluginId}: ${error}`);
              }
              continue;
            }

            socket.on(event, (data: any) => {
              try {
                handler(socket, data, ctx);
              } catch (error) {
                console.error(`❌ Error in plugin ${pluginId} handling ${event}:`, error);
              }
            });
          }
        }

        socket.on('disconnect', () => {
          plugin.onDisconnect?.(socket, ctx);
        });
      });

      // Note: HTTP routes not supported with basic HTTP server
      // Upgrade to Express to enable plugin routes
      if (plugin.routes && plugin.routes.length > 0) {
        console.warn(`  ⚠️  Plugin ${manifest.name} defines routes but Express is not available`);
      }

      const status: LoadedPlugin = {
        plugin,
        manifest,
        permissions,
        status: pluginErrors.length > 0 ? 'error' : 'active',
        errors: pluginErrors
      };

      this.plugins.set(pluginId, status);
      this.setPluginStatus(pluginId, manifest, status.status, pluginErrors);

      console.log(`✅ Loaded plugin: ${manifest.name} v${manifest.version}`);

      // Log registered socket events
      if (manifest.backend.socketEvents && manifest.backend.socketEvents.length > 0) {
        console.log(`  🔌 Socket events: ${manifest.backend.socketEvents.join(', ')}`);
      }

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`❌ Failed to load plugin ${pluginId}:`, error);

      const fallbackManifest = this.readManifestBestEffort(pluginId);
      if (fallbackManifest) {
        this.setPluginStatus(pluginId, fallbackManifest, 'error', [message]);
      }
    }
  }

  handleNewConnection(socket: Socket) {
    for (const [pluginId, loaded] of this.plugins.entries()) {
      const { plugin, permissions, manifest, errors } = loaded;
      const ctx = this.createContext(pluginId, permissions);

      plugin.onConnection?.(socket, ctx);

      if (plugin.socketHandlers) {
        for (const [event, handler] of Object.entries(plugin.socketHandlers)) {
          const requiredPermissions = manifest.backend?.socketEventPermissions?.[event] ?? [];
          const missingPermission = requiredPermissions.find(permission => !permissions.has(permission));

          if (missingPermission) {
            const error = `Socket handler "${event}" denied: missing permission ${missingPermission}`;
            if (!errors.includes(error)) {
              errors.push(error);
            }
            continue;
          }

          socket.on(event, (data: any) => {
            try {
              handler(socket, data, ctx);
            } catch (error) {
              console.error(`❌ Error in plugin ${pluginId} handling ${event}:`, error);
            }
          });
        }
      }

      socket.on('disconnect', () => {
        plugin.onDisconnect?.(socket, ctx);
      });
    }
  }

  private createContext(pluginId: string, permissions: Set<PluginPermission>): PluginContext {
    const hasPermission = (permission: PluginPermission): boolean => permissions.has(permission);

    return {
      io: this.io,
      httpServer: this.httpServer,
      users: hasPermission(PLUGIN_PERMISSIONS.USERS_READ)
        ? {
          list: () => Array.from(this.context.users.values()),
          getBySocketId: (socketId: string) => this.context.users.get(socketId) || null
        }
        : undefined,
      channels: hasPermission(PLUGIN_PERMISSIONS.CHANNELS_READ) || hasPermission(PLUGIN_PERMISSIONS.CHANNELS_MANAGE)
        ? {
          list: () => Array.from(this.context.channels.values()),
          getById: (channelId: string) => this.context.channels.get(channelId) || null
        }
        : undefined,
      messages: hasPermission(PLUGIN_PERMISSIONS.MESSAGES_READ)
        ? {
          listByChannel: (channelId: string) => this.context.channelMessages.get(channelId) || []
        }
        : undefined,
      storage: this.createPluginStorage(pluginId),
      emit: hasPermission(PLUGIN_PERMISSIONS.EVENTS_EMIT)
        ? (event: string, data: any) => this.io.emit(event, data)
        : undefined,
      emitToChannel: hasPermission(PLUGIN_PERMISSIONS.EVENTS_EMIT)
        ? (channelId: string, event: string, data: any) => {
          this.context.emitToChannel(channelId, event, data);
        }
        : undefined,
      hasPermission
    };
  }

  private validateAndNormalizePermissions(manifest: PluginManifest): Set<PluginPermission> {
    const requestedPermissions = manifest.permissions ?? [];
    const invalidPermissions = requestedPermissions.filter((permission: unknown) => {
      if (typeof permission !== 'string') {
        return true;
      }

      if (!/^[a-z]+\.[a-z]+$/.test(permission)) {
        return true;
      }

      return !VALID_PLUGIN_PERMISSIONS.has(permission as PluginPermission);
    });

    if (invalidPermissions.length > 0) {
      throw new Error(`Plugin ${manifest.id} requested unknown or unsafe permissions: ${invalidPermissions.join(', ')}`);
    }

    const socketEventPermissions = manifest.backend?.socketEventPermissions ?? {};
    for (const [event, permissions] of Object.entries(socketEventPermissions)) {
      if (!Array.isArray(permissions)) {
        throw new Error(`Plugin ${manifest.id} has invalid permission mapping for socket event "${event}"`);
      }

      const invalidEventPermissions = permissions.filter(permission => !VALID_PLUGIN_PERMISSIONS.has(permission));
      if (invalidEventPermissions.length > 0) {
        throw new Error(`Plugin ${manifest.id} requested unknown or unsafe socket event permissions on "${event}": ${invalidEventPermissions.join(', ')}`);
      }
    }

    return new Set(requestedPermissions);
  }

  private readManifestBestEffort(pluginId: string): PluginManifest | null {
    try {
      const pluginPath = path.join(this.pluginsDir, pluginId);
      const manifestPath = path.join(pluginPath, 'plugin.json');
      if (!fs.existsSync(manifestPath)) {
        return null;
      }
      return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PluginManifest;
    } catch {
      return null;
    }
  }

  private setPluginStatus(
    id: string,
    manifest: PluginManifest,
    status: 'active' | 'error',
    errors: string[]
  ) {
    this.pluginStatuses.set(id, {
      id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      status,
      errors
    });
  }

  private createPluginStorage(pluginId: string): PluginStorage {
    const pluginStorageDir = path.join(this.storageDir, pluginId);

    if (!fs.existsSync(pluginStorageDir)) {
      fs.mkdirSync(pluginStorageDir, { recursive: true });
    }

    return {
      get: async (key: string) => {
        const filePath = path.join(pluginStorageDir, `${key}.json`);
        if (fs.existsSync(filePath)) {
          return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        }
        return null;
      },

      set: async (key: string, value: any) => {
        const filePath = path.join(pluginStorageDir, `${key}.json`);
        fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
      },

      delete: async (key: string) => {
        const filePath = path.join(pluginStorageDir, `${key}.json`);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      },

      list: async () => {
        return fs.readdirSync(pluginStorageDir)
          .filter(f => f.endsWith('.json'))
          .map(f => f.replace('.json', ''));
      }
    };
  }

  // Hook methods for core to call
  async triggerOnMessage(channelId: string, message: any) {
    for (const [pluginId, { plugin, permissions }] of this.plugins.entries()) {
      try {
        await plugin.onMessage?.(channelId, message, this.createContext(pluginId, permissions));
      } catch (error) {
        console.error(`Error in plugin ${plugin.name} onMessage:`, error);
      }
    }
  }

  async triggerOnChannelCreate(channel: any) {
    for (const [pluginId, { plugin, permissions }] of this.plugins.entries()) {
      try {
        await plugin.onChannelCreate?.(channel, this.createContext(pluginId, permissions));
      } catch (error) {
        console.error(`Error in plugin ${plugin.name} onChannelCreate:`, error);
      }
    }
  }

  async triggerOnUserJoin(user: any) {
    for (const [pluginId, { plugin, permissions }] of this.plugins.entries()) {
      try {
        await plugin.onUserJoin?.(user, this.createContext(pluginId, permissions));
      } catch (error) {
        console.error(`Error in plugin ${plugin.name} onUserJoin:`, error);
      }
    }
  }

  async triggerOnUserLeave(userId: string) {
    for (const [pluginId, { plugin, permissions }] of this.plugins.entries()) {
      try {
        await plugin.onUserLeave?.(userId, this.createContext(pluginId, permissions));
      } catch (error) {
        console.error(`Error in plugin ${plugin.name} onUserLeave:`, error);
      }
    }
  }

  getLoadedPlugins() {
    return Array.from(this.pluginStatuses.values());
  }
}
