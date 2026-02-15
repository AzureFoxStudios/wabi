import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Server, Socket } from 'socket.io';
import type { Server as HttpServer } from 'http';
import type { BackendPlugin, PluginContext, PluginLogger, PluginManifest, PluginStorage } from './types';

interface PluginRecord {
  id: string;
  version: string;
  checksum?: string;
  signature?: string;
  lastVerificationResult: 'pass' | 'fail' | 'skipped';
  lastVerifiedAt: string;
}

interface PluginAuditEvent {
  actor: string;
  pluginId: string;
  version: string;
  action: 'discover' | 'verify' | 'load' | 'enable' | 'disable' | 'unload';
  result: 'success' | 'failure' | 'skipped';
  timestamp: string;
  reason?: string;
}

interface PluginCrashState {
  failures: number;
  lastFailureAt: string;
}

interface PluginLogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  timestamp: string;
  namespace: string;
  meta?: Record<string, any>;
}

const CRASH_LOOP_THRESHOLD = 3;

export class PluginLoader {
  private plugins: Map<string, { plugin: BackendPlugin; manifest: PluginManifest }> = new Map();
  private pluginsDir: string;
  private storageDir: string;
  private pluginRecordsFile: string;
  private auditLogFile: string;
  private crashStateFile: string;
  private pluginLogDir: string;
  private safeModeEnabled = false;

  constructor(
    private io: Server,
    private httpServer: HttpServer,
    private context: any
  ) {
    const dataDir = process.env.DATA_DIR || path.join(__dirname, '../../../data');
    const pluginsBaseDir = process.env.PLUGINS_DIR || path.join(__dirname, '../../../plugins');

    this.pluginsDir = pluginsBaseDir;
    this.storageDir = path.join(dataDir, '.plugin-storage');
    this.pluginRecordsFile = path.join(this.storageDir, 'plugin-records.json');
    this.auditLogFile = path.join(this.storageDir, 'plugin-audit.jsonl');
    this.crashStateFile = path.join(this.storageDir, 'plugin-crash-state.json');
    this.pluginLogDir = path.join(this.storageDir, 'logs');

    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }

    if (!fs.existsSync(this.pluginLogDir)) {
      fs.mkdirSync(this.pluginLogDir, { recursive: true });
    }
  }

  async loadAll() {
    console.log('🔌 Loading plugins from:', this.pluginsDir);

    if (!fs.existsSync(this.pluginsDir)) {
      console.log('📁 Creating plugins directory...');
      fs.mkdirSync(this.pluginsDir, { recursive: true });
      return;
    }

    this.safeModeEnabled = this.shouldEnableSafeMode();
    if (this.safeModeEnabled) {
      console.warn('🛟 Plugin safe mode enabled. Third-party plugins are disabled for this boot.');
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
    const pluginPath = path.join(this.pluginsDir, pluginId);
    const manifestPath = path.join(pluginPath, 'plugin.json');

    this.writeAuditEvent({
      actor: 'system',
      pluginId,
      version: 'unknown',
      action: 'discover',
      result: 'success',
      reason: 'Plugin directory discovered during boot'
    });

    try {
      if (!fs.existsSync(manifestPath)) {
        this.writeAuditEvent({
          actor: 'system',
          pluginId,
          version: 'unknown',
          action: 'discover',
          result: 'failure',
          reason: 'No plugin.json found'
        });
        console.warn(`⚠️  No plugin.json found for ${pluginId}`);
        return;
      }

      const manifest: PluginManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

      if (this.safeModeEnabled && manifest.firstParty !== true) {
        this.writeAuditEvent({
          actor: 'system',
          pluginId,
          version: manifest.version,
          action: 'disable',
          result: 'success',
          reason: 'Safe mode is active after crash loop detection'
        });
        console.log(`🛟 Safe mode: skipping third-party plugin ${manifest.name}`);
        return;
      }

      if (manifest.enabled === false) {
        this.writeAuditEvent({
          actor: 'system',
          pluginId,
          version: manifest.version,
          action: 'disable',
          result: 'success',
          reason: 'Plugin manifest has enabled=false'
        });
        console.log(`⏭️  Plugin ${manifest.name} is disabled, skipping`);
        return;
      }

      if (!manifest.backend?.entry) {
        this.writeAuditEvent({
          actor: 'system',
          pluginId,
          version: manifest.version,
          action: 'load',
          result: 'skipped',
          reason: 'No backend entry defined'
        });
        console.log(`⏭️  Plugin ${manifest.name} has no backend component`);
        return;
      }

      const backendEntry = path.join(pluginPath, manifest.backend.entry);

      if (!fs.existsSync(backendEntry)) {
        this.writeAuditEvent({
          actor: 'system',
          pluginId,
          version: manifest.version,
          action: 'load',
          result: 'failure',
          reason: `Backend entry not found: ${manifest.backend.entry}`
        });
        console.warn(`⚠️  Backend entry not found: ${backendEntry}`);
        this.recordCrash(pluginId);
        return;
      }

      const manifestValidation = this.validateSecurityMetadata(manifest);
      if (!manifestValidation.passed) {
        this.writeAuditEvent({
          actor: 'system',
          pluginId,
          version: manifest.version,
          action: 'verify',
          result: 'failure',
          reason: manifestValidation.reason
        });
        this.upsertPluginRecord(manifest, 'fail', '');
        this.recordCrash(pluginId);
        console.error(`❌ Plugin security metadata validation failed for ${pluginId}: ${manifestValidation.reason}`);
        return;
      }

      const integrity = this.verifyPluginIntegrity(pluginId, pluginPath, manifest);
      this.writeAuditEvent({
        actor: 'system',
        pluginId,
        version: manifest.version,
        action: 'verify',
        result: integrity.passed ? 'success' : 'failure',
        reason: integrity.reason
      });
      this.upsertPluginRecord(manifest, integrity.passed ? 'pass' : 'fail', integrity.calculatedChecksum);

      if (!integrity.passed) {
        console.error(`❌ Plugin integrity check failed for ${pluginId}: ${integrity.reason}`);
        this.recordCrash(pluginId);
        return;
      }

      const pluginModule = await import(backendEntry);
      const plugin: BackendPlugin = pluginModule.default || pluginModule;
      const ctx = this.createContext(pluginId);

      await plugin.onLoad?.(ctx);

      this.io.on('connection', (socket: Socket) => {
        plugin.onConnection?.(socket, ctx);

        if (plugin.socketHandlers) {
          for (const [event, handler] of Object.entries(plugin.socketHandlers)) {
            socket.on(event, (data: any) => {
              try {
                handler(socket, data, ctx);
              } catch (error) {
                ctx.logger.error(`Error handling socket event ${event}`, {
                  error: error instanceof Error ? error.message : String(error)
                });
              }
            });
          }
        }

        socket.on('disconnect', () => {
          plugin.onDisconnect?.(socket, ctx);
        });
      });

      this.plugins.set(pluginId, { plugin, manifest });

      this.writeAuditEvent({
        actor: 'system',
        pluginId,
        version: manifest.version,
        action: 'enable',
        result: 'success',
        reason: 'Plugin enabled during boot'
      });
      this.writeAuditEvent({
        actor: 'system',
        pluginId,
        version: manifest.version,
        action: 'load',
        result: 'success',
        reason: 'Plugin loaded'
      });

      this.clearCrashState(pluginId);

      console.log(`✅ Loaded plugin: ${manifest.name} v${manifest.version}`);
      if (manifest.backend.socketEvents && manifest.backend.socketEvents.length > 0) {
        console.log(`  🔌 Socket events: ${manifest.backend.socketEvents.join(', ')}`);
      }

      if (plugin.routes && plugin.routes.length > 0) {
        console.warn(`  ⚠️  Plugin ${manifest.name} defines routes but Express is not available`);
      }
    } catch (error) {
      const version = this.readManifestVersion(manifestPath);
      this.writeAuditEvent({
        actor: 'system',
        pluginId,
        version,
        action: 'load',
        result: 'failure',
        reason: error instanceof Error ? error.message : 'Unknown load error'
      });
      this.recordCrash(pluginId);
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
              ctx.logger.error(`Error handling socket event ${event}`, {
                error: error instanceof Error ? error.message : String(error)
              });
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
      logger: this.createPluginLogger(pluginId),
      emit: (event: string, data: any) => this.io.emit(event, data),
      emitToChannel: (channelId: string, event: string, data: any) => {
        this.context.emitToChannel(channelId, event, data);
      }
    };
  }

  private createPluginLogger(pluginId: string): PluginLogger {
    const namespace = `plugin:${pluginId}`;

    const write = (level: PluginLogEntry['level'], message: string, meta?: Record<string, any>) => {
      const entry: PluginLogEntry = {
        level,
        message,
        timestamp: new Date().toISOString(),
        namespace,
        meta
      };

      const filePath = path.join(this.pluginLogDir, `${pluginId}.jsonl`);
      fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);

      const logger = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      logger(`[${namespace}] ${message}`, meta || '');
    };

    return {
      debug: (message, meta) => write('debug', message, meta),
      info: (message, meta) => write('info', message, meta),
      warn: (message, meta) => write('warn', message, meta),
      error: (message, meta) => write('error', message, meta)
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


  private validateSecurityMetadata(manifest: PluginManifest): { passed: boolean; reason: string } {
    if (!manifest.permissions || manifest.permissions.length === 0) {
      return { passed: false, reason: 'Missing required permissions declaration' };
    }

    if (!manifest.security?.threatNotes || manifest.security.threatNotes.trim().length === 0) {
      return { passed: false, reason: 'Missing required security.threatNotes declaration' };
    }

    return { passed: true, reason: 'Security metadata present' };
  }

  private verifyPluginIntegrity(pluginId: string, pluginPath: string, manifest: PluginManifest): { passed: boolean; reason: string; calculatedChecksum: string } {
    const calculatedChecksum = this.calculatePluginChecksum(pluginPath);
    const expectedChecksum = manifest.integrity?.checksum;

    if (!expectedChecksum) {
      return {
        passed: true,
        reason: 'No checksum configured; verification skipped',
        calculatedChecksum
      };
    }

    if (expectedChecksum !== calculatedChecksum) {
      return {
        passed: false,
        reason: 'Checksum mismatch',
        calculatedChecksum
      };
    }

    return {
      passed: true,
      reason: 'Checksum verified',
      calculatedChecksum
    };
  }

  private calculatePluginChecksum(pluginPath: string): string {
    const hash = crypto.createHash('sha256');
    const files = this.collectPluginFiles(pluginPath);

    for (const file of files) {
      hash.update(path.relative(pluginPath, file));
      hash.update(fs.readFileSync(file));
    }

    return hash.digest('hex');
  }

  private collectPluginFiles(root: string): string[] {
    const files: string[] = [];

    const walk = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '.DS_Store' || entry.name === 'node_modules' || entry.name === 'plugin.json') {
          continue;
        }

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else {
          files.push(fullPath);
        }
      }
    };

    walk(root);
    files.sort();
    return files;
  }

  private upsertPluginRecord(manifest: PluginManifest, result: PluginRecord['lastVerificationResult'], calculatedChecksum: string) {
    const records = this.readPluginRecords();
    records[manifest.id] = {
      id: manifest.id,
      version: manifest.version,
      checksum: manifest.integrity?.checksum || calculatedChecksum || undefined,
      signature: manifest.integrity?.signature,
      lastVerificationResult: result,
      lastVerifiedAt: new Date().toISOString()
    };
    fs.writeFileSync(this.pluginRecordsFile, JSON.stringify(records, null, 2));
  }

  private readPluginRecords(): Record<string, PluginRecord> {
    if (!fs.existsSync(this.pluginRecordsFile)) {
      return {};
    }

    try {
      return JSON.parse(fs.readFileSync(this.pluginRecordsFile, 'utf-8'));
    } catch {
      return {};
    }
  }

  private writeAuditEvent(event: Omit<PluginAuditEvent, 'timestamp'>) {
    const logEvent: PluginAuditEvent = {
      ...event,
      timestamp: new Date().toISOString()
    };
    fs.appendFileSync(this.auditLogFile, `${JSON.stringify(logEvent)}\n`);
  }

  private shouldEnableSafeMode(): boolean {
    const config = process.env.PLUGIN_SAFE_MODE?.toLowerCase() || 'auto';
    if (config === 'on') {
      return true;
    }

    if (config === 'off') {
      return false;
    }

    const crashState = this.readCrashState();
    return Object.values(crashState).some(state => state.failures >= CRASH_LOOP_THRESHOLD);
  }

  private readCrashState(): Record<string, PluginCrashState> {
    if (!fs.existsSync(this.crashStateFile)) {
      return {};
    }

    try {
      return JSON.parse(fs.readFileSync(this.crashStateFile, 'utf-8'));
    } catch {
      return {};
    }
  }

  private recordCrash(pluginId: string) {
    const state = this.readCrashState();
    const existing = state[pluginId] || { failures: 0, lastFailureAt: '' };
    state[pluginId] = {
      failures: existing.failures + 1,
      lastFailureAt: new Date().toISOString()
    };
    fs.writeFileSync(this.crashStateFile, JSON.stringify(state, null, 2));
  }

  private clearCrashState(pluginId: string) {
    const state = this.readCrashState();
    if (!state[pluginId]) {
      return;
    }

    delete state[pluginId];
    fs.writeFileSync(this.crashStateFile, JSON.stringify(state, null, 2));
  }

  private readManifestVersion(manifestPath: string): string {
    try {
      if (!fs.existsSync(manifestPath)) {
        return 'unknown';
      }
      const manifest: PluginManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      return manifest.version;
    } catch {
      return 'unknown';
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

  getAuditEvents(limit = 200): PluginAuditEvent[] {
    if (!fs.existsSync(this.auditLogFile)) {
      return [];
    }

    const rows = fs.readFileSync(this.auditLogFile, 'utf-8').trim().split('\n').filter(Boolean);
    return rows.slice(-limit).map((line) => JSON.parse(line) as PluginAuditEvent);
  }

  getPluginLogHistory(pluginId: string, limit = 200): PluginLogEntry[] {
    const logPath = path.join(this.pluginLogDir, `${pluginId}.jsonl`);
    if (!fs.existsSync(logPath)) {
      return [];
    }

    const rows = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
    return rows.slice(-limit).map((line) => JSON.parse(line) as PluginLogEntry);
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
}
