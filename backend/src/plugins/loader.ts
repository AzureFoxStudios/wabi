import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';
import type { Server, Socket } from 'socket.io';
import type { Server as HttpServer } from 'http';
import { pluginRepository } from '../db/repositories/pluginRepository.js';
import type { BackendPlugin, LoadedPlugin, PluginContext, PluginHookRegistration, PluginLifecycleMetadata, PluginManifest, PluginStorage } from './types';

const __dirname = dirname(fileURLToPath(import.meta.url));

type InstallSource = string;

export class PluginManager {
  private plugins = new Map<string, LoadedPlugin>();
  private pluginsDir: string;
  private storageDir: string;

  constructor(
    private io: Server,
    private httpServer: HttpServer,
    private context: any
  ) {
    const dataDir = process.env.DATA_DIR || path.join(__dirname, '../../../data');
    this.pluginsDir = process.env.PLUGINS_DIR || path.join(__dirname, '../../../plugins');
    this.storageDir = path.join(dataDir, '.plugin-storage');

    if (!fs.existsSync(this.pluginsDir)) fs.mkdirSync(this.pluginsDir, { recursive: true });
    if (!fs.existsSync(this.storageDir)) fs.mkdirSync(this.storageDir, { recursive: true });
  }

  async loadAll() {
    const pluginDirs = fs.readdirSync(this.pluginsDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);

    for (const pluginId of pluginDirs) {
      const manifestPath = path.join(this.pluginsDir, pluginId, 'plugin.json');
      await this.installPlugin(manifestPath);
    }
  }

  async installPlugin(manifestPathOrSource: InstallSource): Promise<void> {
    const { manifestPath, installSource } = this.resolveInstallSource(manifestPathOrSource);

    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Plugin manifest not found: ${manifestPath}`);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PluginManifest;
    const pluginPath = path.dirname(manifestPath);

    const checksum = this.calculateChecksum(manifestPath);
    const alreadyPersisted = pluginRepository.findById(manifest.id);
    const enabledFromManifest = manifest.enabled !== false;
    const enabled = alreadyPersisted ? alreadyPersisted.enabled === 1 : enabledFromManifest;

    pluginRepository.upsertInstallation({
      plugin_id: manifest.id,
      version: manifest.version,
      enabled,
      install_source: installSource,
      checksum,
    });

    if (enabled) {
      await this.enablePlugin(manifest.id, { manifest, pluginPath });
    } else {
      this.plugins.delete(manifest.id);
    }
  }

  async enablePlugin(pluginId: string, preloaded?: { manifest: PluginManifest; pluginPath: string }): Promise<void> {
    try {
      const loaded = preloaded ?? this.readManifestByPluginId(pluginId);
      const { manifest, pluginPath } = loaded;

      if (!manifest.backend?.entry) {
        throw new Error(`Plugin ${pluginId} has no backend entry`);
      }

      const backendEntry = path.join(pluginPath, manifest.backend.entry);
      if (!fs.existsSync(backendEntry)) {
        throw new Error(`Backend entry not found: ${backendEntry}`);
      }

      const pluginModule = await import(pathToFileURL(backendEntry).href + `?t=${Date.now()}`);
      const plugin = (pluginModule.default || pluginModule) as BackendPlugin;
      const ctx = this.createContext(pluginId);

      await plugin.onLoad?.(ctx);

      const metadata: PluginLifecycleMetadata = {
        status: 'enabled',
        socketListenerHandles: [],
        hookRegistrations: this.buildHookRegistrations(plugin),
        lastLoadedAt: Date.now(),
        lastEnabledAt: Date.now(),
        logs: [],
      };

      const loadedPlugin: LoadedPlugin = {
        plugin,
        manifest,
        metadata,
        context: ctx,
        pluginPath,
        backendEntry,
      };

      this.plugins.set(pluginId, loadedPlugin);

      for (const socket of this.io.sockets.sockets.values()) {
        this.attachPluginToSocket(pluginId, socket);
      }

      this.log(pluginId, 'info', `Enabled plugin ${manifest.name} v${manifest.version}`);
      pluginRepository.setEnabled(pluginId, true);
      pluginRepository.setLifecycleInfo(pluginId, { last_error: null, health_status: 'healthy', health_updated_at: Date.now() });
    } catch (error) {
      this.recordError(pluginId, error);
      pluginRepository.setEnabled(pluginId, false);
      throw error;
    }
  }

  async disablePlugin(pluginId: string): Promise<void> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) {
      pluginRepository.setEnabled(pluginId, false);
      return;
    }

    this.detachSocketListeners(pluginId);
    loaded.metadata.status = 'disabled';
    loaded.metadata.lastDisabledAt = Date.now();
    this.log(pluginId, 'info', 'Disabled plugin');
    pluginRepository.setEnabled(pluginId, false);
  }

  async unloadPlugin(pluginId: string): Promise<void> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) {
      return;
    }

    try {
      await loaded.plugin.onUnload?.(loaded.context);
    } catch (error) {
      this.recordError(pluginId, error);
    }

    this.detachSocketListeners(pluginId);
    loaded.metadata.hookRegistrations = [];
    loaded.metadata.status = 'loaded';
    this.log(pluginId, 'info', 'Unloaded plugin runtime');
    this.plugins.delete(pluginId);
  }

  async reloadPlugin(pluginId: string): Promise<void> {
    const previousState = pluginRepository.findById(pluginId);
    await this.unloadPlugin(pluginId);
    await this.enablePlugin(pluginId);
    if (previousState && previousState.enabled === 0) {
      await this.disablePlugin(pluginId);
    }
  }

  async uninstallPlugin(pluginId: string): Promise<void> {
    await this.unloadPlugin(pluginId);
    const pluginPath = path.join(this.pluginsDir, pluginId);
    if (fs.existsSync(pluginPath)) {
      fs.rmSync(pluginPath, { recursive: true, force: true });
    }
    pluginRepository.deleteInstallation(pluginId);
  }

  handleConnection(socket: Socket): void {
    for (const [pluginId, loaded] of this.plugins.entries()) {
      if (loaded.metadata.status === 'enabled') {
        this.attachPluginToSocket(pluginId, socket);
      }
    }
  }

  async triggerOnMessage(channelId: string, message: any) {
    await this.runHook('onMessage', (plugin, ctx) => plugin.onMessage?.(channelId, message, ctx));
  }

  async triggerOnChannelCreate(channel: any) {
    await this.runHook('onChannelCreate', (plugin, ctx) => plugin.onChannelCreate?.(channel, ctx));
  }

  async triggerOnUserJoin(user: any) {
    await this.runHook('onUserJoin', (plugin, ctx) => plugin.onUserJoin?.(user, ctx));
  }

  async triggerOnUserLeave(userId: string) {
    await this.runHook('onUserLeave', (plugin, ctx) => plugin.onUserLeave?.(userId, ctx));
  }

  getInstalledPlugins() {
    const persisted = pluginRepository.listInstallations();
    return persisted.map((row) => {
      const runtime = this.plugins.get(row.plugin_id);
      const manifestPath = path.join(this.pluginsDir, row.plugin_id, 'plugin.json');
      const manifest = fs.existsSync(manifestPath)
        ? (JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PluginManifest)
        : null;

      return {
        id: row.plugin_id,
        name: manifest?.name ?? row.plugin_id,
        description: manifest?.description ?? null,
        version: row.version,
        enabled: row.enabled === 1,
        installSource: row.install_source,
        checksum: row.checksum,
        installedAt: row.installed_at,
        updatedAt: row.updated_at,
        status: runtime?.metadata.status ?? (row.enabled === 1 ? 'loaded' : 'disabled'),
        health: runtime?.metadata.health ?? (row.health_status ? { status: row.health_status as any, checkedAt: row.health_updated_at ?? undefined } : undefined),
        lastError: runtime?.metadata.lastError ?? row.last_error ?? undefined,
      };
    });
  }

  getLifecycle(pluginId: string) {
    const runtime = this.plugins.get(pluginId);
    const persisted = pluginRepository.findById(pluginId);
    return {
      pluginId,
      status: runtime?.metadata.status ?? (persisted?.enabled ? 'loaded' : 'disabled'),
      logs: runtime?.metadata.logs ?? [],
      lastError: runtime?.metadata.lastError ?? persisted?.last_error ?? null,
      health: runtime?.metadata.health ?? (persisted?.health_status ? { status: persisted.health_status, checkedAt: persisted.health_updated_at } : null),
    };
  }

  private async runHook(hook: PluginHookRegistration['hook'], fn: (plugin: BackendPlugin, ctx: PluginContext) => void | Promise<void>) {
    for (const [pluginId, loaded] of this.plugins.entries()) {
      if (loaded.metadata.status !== 'enabled') continue;
      if (!loaded.metadata.hookRegistrations.some((entry) => entry.hook === hook)) continue;

      try {
        await fn(loaded.plugin, loaded.context);
      } catch (error) {
        this.recordError(pluginId, error);
      }
    }
  }

  private attachPluginToSocket(pluginId: string, socket: Socket) {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) return;

    const { plugin, context } = loaded;

    const disconnectHandler = () => {
      try {
        plugin.onDisconnect?.(socket, context);
      } catch (error) {
        this.recordError(pluginId, error);
      }
    };
    socket.on('disconnect', disconnectHandler);
    loaded.metadata.socketListenerHandles.push({ socketId: socket.id, event: 'disconnect', handler: disconnectHandler });

    try {
      plugin.onConnection?.(socket, context);
    } catch (error) {
      this.recordError(pluginId, error);
    }

    if (!plugin.socketHandlers) return;

    for (const [event, handler] of Object.entries(plugin.socketHandlers)) {
      const wrapped = (data: any) => {
        try {
          handler(socket, data, context);
        } catch (error) {
          this.recordError(pluginId, error);
        }
      };

      socket.on(event, wrapped);
      loaded.metadata.socketListenerHandles.push({ socketId: socket.id, event, handler: wrapped });
    }
  }

  private detachSocketListeners(pluginId: string) {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) return;

    for (const handle of loaded.metadata.socketListenerHandles) {
      const socket = this.io.sockets.sockets.get(handle.socketId);
      if (socket) socket.off(handle.event, handle.handler);
    }

    loaded.metadata.socketListenerHandles = [];
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
      emitToChannel: (channelId: string, event: string, data: any) => this.context.emitToChannel(channelId, event, data),
    };
  }

  private createPluginStorage(pluginId: string): PluginStorage {
    const pluginStorageDir = path.join(this.storageDir, pluginId);
    if (!fs.existsSync(pluginStorageDir)) fs.mkdirSync(pluginStorageDir, { recursive: true });

    return {
      get: async (key: string) => {
        const filePath = path.join(pluginStorageDir, `${key}.json`);
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      },
      set: async (key: string, value: any) => {
        fs.writeFileSync(path.join(pluginStorageDir, `${key}.json`), JSON.stringify(value, null, 2));
      },
      delete: async (key: string) => {
        const filePath = path.join(pluginStorageDir, `${key}.json`);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      },
      list: async () => fs.readdirSync(pluginStorageDir).filter((name) => name.endsWith('.json')).map((name) => name.replace('.json', '')),
    };
  }

  private buildHookRegistrations(plugin: BackendPlugin): PluginHookRegistration[] {
    const hooks: PluginHookRegistration[] = [];
    if (plugin.onMessage) hooks.push({ hook: 'onMessage' });
    if (plugin.onChannelCreate) hooks.push({ hook: 'onChannelCreate' });
    if (plugin.onUserJoin) hooks.push({ hook: 'onUserJoin' });
    if (plugin.onUserLeave) hooks.push({ hook: 'onUserLeave' });
    return hooks;
  }

  private resolveInstallSource(source: string): { manifestPath: string; installSource: string } {
    if (source.startsWith('http://') || source.startsWith('https://') || source.startsWith('npm:')) {
      throw new Error('Remote plugin installation source is not supported in this runtime');
    }

    const resolved = path.isAbsolute(source) ? source : path.resolve(source);
    const stat = fs.existsSync(resolved) ? fs.statSync(resolved) : null;

    if (!stat) {
      return {
        manifestPath: path.join(this.pluginsDir, source, 'plugin.json'),
        installSource: `local:${source}`,
      };
    }

    if (stat.isDirectory()) {
      return { manifestPath: path.join(resolved, 'plugin.json'), installSource: `dir:${resolved}` };
    }

    return { manifestPath: resolved, installSource: `file:${resolved}` };
  }

  private readManifestByPluginId(pluginId: string): { manifest: PluginManifest; pluginPath: string } {
    const manifestPath = path.join(this.pluginsDir, pluginId, 'plugin.json');
    if (!fs.existsSync(manifestPath)) throw new Error(`Plugin ${pluginId} is not installed`);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PluginManifest;
    return { manifest, pluginPath: path.dirname(manifestPath) };
  }

  private calculateChecksum(filePath: string): string {
    const hash = createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
  }

  private log(pluginId: string, level: 'info' | 'error', message: string) {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) return;

    loaded.metadata.logs.push({ level, message, timestamp: Date.now() });
  }

  private recordError(pluginId: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const loaded = this.plugins.get(pluginId);

    if (loaded) {
      loaded.metadata.status = 'failed';
      loaded.metadata.lastError = message;
      loaded.metadata.lastErrorAt = Date.now();
      loaded.metadata.health = { status: 'unhealthy', checkedAt: Date.now() };
      loaded.metadata.logs.push({ level: 'error', message, timestamp: Date.now() });
    }

    pluginRepository.setLifecycleInfo(pluginId, {
      last_error: message,
      health_status: 'unhealthy',
      health_updated_at: Date.now(),
    });

    console.error(`[Plugins] ${pluginId}:`, error);
  }
}

export class PluginLoader extends PluginManager {}
