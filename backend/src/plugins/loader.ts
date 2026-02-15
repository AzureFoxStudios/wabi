import fs from 'fs';
import path from 'path';
import type { PluginPathConfig } from '../config/pluginConfig.js';
import type { Server, Socket } from 'socket.io';
import type { Server as HttpServer } from 'http';
import type { BackendPlugin, PluginContext, PluginManifest, PluginStorage } from './types';

export class PluginLoader {
  private plugins: Map<string, { plugin: BackendPlugin; manifest: PluginManifest }> = new Map();
  private pluginsDir: string;
  private storageDir: string;

  constructor(
    private io: Server,
    private httpServer: HttpServer,
    private context: any,
    pluginPathConfig: PluginPathConfig
  ) {
    this.pluginsDir = pluginPathConfig.pluginsDir;
    this.storageDir = pluginPathConfig.pluginStorageDir;
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

      const backendEntry = path.join(pluginPath, manifest.backend.entry);

      if (!fs.existsSync(backendEntry)) {
        console.warn(`⚠️  Backend entry not found: ${backendEntry}`);
        return;
      }

      // Dynamic import the plugin
      const pluginModule = await import(backendEntry);
      const plugin: BackendPlugin = pluginModule.default || pluginModule;

      const ctx = this.createContext(pluginId);

      // Initialize plugin
      await plugin.onLoad?.(ctx);

      // Register socket handlers
      this.io.on('connection', (socket: Socket) => {
        plugin.onConnection?.(socket, ctx);

        // Register custom socket events
        if (plugin.socketHandlers) {
          for (const [event, handler] of Object.entries(plugin.socketHandlers)) {
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

      this.plugins.set(pluginId, { plugin, manifest });
      console.log(`✅ Loaded plugin: ${manifest.name} v${manifest.version}`);

      // Log registered socket events
      if (manifest.backend.socketEvents && manifest.backend.socketEvents.length > 0) {
        console.log(`  🔌 Socket events: ${manifest.backend.socketEvents.join(', ')}`);
      }

    } catch (error) {
      console.error(`❌ Failed to load plugin ${pluginId}:`, error);
    }
  }

  handleNewConnection(socket: Socket) {
    for (const [pluginId, { plugin }] of this.plugins.entries()) {
        const ctx = this.createContext(pluginId);

        plugin.onConnection?.(socket, ctx);

        if (plugin.socketHandlers) {
            for (const [event, handler] of Object.entries(plugin.socketHandlers)) {
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


  private createContext(pluginId: string): PluginContext {
    return {
      io: this.io,
      httpServer: this.httpServer,
      channels: this.context.channels,
      users: this.context.users,
      channelMessages: this.context.channelMessages,
      storage: this.createPluginStorage(pluginId),
      emit: (event: string, data: any) => this.io.emit(event, data),
      emitToChannel: (channelId: string, event: string, data: any) => {
        this.context.emitToChannel(channelId, event, data);
      }
    };
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
    for (const [pluginId, { plugin }] of this.plugins.entries()) {
      try {
        await plugin.onMessage?.(channelId, message, this.createContext(pluginId));
      } catch (error) {
        console.error(`Error in plugin ${plugin.name} onMessage:`, error);
      }
    }
  }

  async triggerOnChannelCreate(channel: any) {
    for (const [pluginId, { plugin }] of this.plugins.entries()) {
      try {
        await plugin.onChannelCreate?.(channel, this.createContext(pluginId));
      } catch (error) {
        console.error(`Error in plugin ${plugin.name} onChannelCreate:`, error);
      }
    }
  }

  async triggerOnUserJoin(user: any) {
    for (const [pluginId, { plugin }] of this.plugins.entries()) {
      try {
        await plugin.onUserJoin?.(user, this.createContext(pluginId));
      } catch (error) {
        console.error(`Error in plugin ${plugin.name} onUserJoin:`, error);
      }
    }
  }

  async triggerOnUserLeave(userId: string) {
    for (const [pluginId, { plugin }] of this.plugins.entries()) {
      try {
        await plugin.onUserLeave?.(userId, this.createContext(pluginId));
      } catch (error) {
        console.error(`Error in plugin ${plugin.name} onUserLeave:`, error);
      }
    }
  }

  getLoadedPlugins() {
    return Array.from(this.plugins.entries()).map(([id, { manifest }]) => ({
      id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description
    }));
  }
}
