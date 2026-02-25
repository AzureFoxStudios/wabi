import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import AdmZip from 'adm-zip';
import type { Server, Socket } from 'socket.io';
import type { Server as HttpServer } from 'http';
import type { BackendPlugin, PluginContext, PluginLogger, PluginManifest, PluginStorage } from './types';

interface PluginRecord {
  id: string;
  version: string;
  checksum?: string;
  signature?: string;
  signerKeyId?: string;
  signatureStatus?: 'verified' | 'invalid' | 'unsigned' | 'skipped';
  signerTrust?: 'trusted' | 'unknown' | 'n/a';
  scanStatus?: 'clean' | 'suspicious' | 'error' | 'skipped';
  scanReason?: string;
  lastScannedAt?: string;
  lastVerificationResult: 'pass' | 'fail' | 'skipped';
  lastVerifiedAt: string;
}

interface PluginAuditEvent {
  actor: string;
  pluginId: string;
  version: string;
  action: 'discover' | 'verify' | 'scan' | 'load' | 'enable' | 'disable' | 'unload';
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
type PluginSignaturePolicy = 'warn-allow' | 'signed-only' | 'curated-only';
type PluginScanPolicy = 'off' | 'warn' | 'enforce';
const PLUGIN_HTTP_ROUTE_PREFIX = '/api/plugins/runtime';
const DEFAULT_PLUGIN_ROUTE_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const DEFAULT_PLUGIN_SCAN_TIMEOUT_MS = 120_000;

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return fallback;
}

interface PluginScanResult {
  passed: boolean;
  status: PluginRecord['scanStatus'];
  reason: string;
}

interface TrustedSignerRecord {
  keyId: string;
  publicKey: string;
  trustedAt: string;
  trustedBy: string;
  note?: string;
}

interface RegisteredPluginRoute {
  pluginId: string;
  method: 'get' | 'post' | 'put' | 'delete';
  path: string;
  handler: (req: any, res: any) => void | Promise<void>;
}

export class PluginLoader {
  private plugins: Map<string, { plugin: BackendPlugin; manifest: PluginManifest }> = new Map();
  private pluginRoutes: RegisteredPluginRoute[] = [];
  private pluginsDir: string;
  private storageDir: string;
  private pluginRecordsFile: string;
  private trustedSignersFile: string;
  private auditLogFile: string;
  private crashStateFile: string;
  private pluginLogDir: string;
  private safeModeEnabled = false;
  private pluginsEnabled: boolean;
  private pluginInstallEnabled: boolean;

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
    this.trustedSignersFile = path.join(this.storageDir, 'trusted-signers.json');
    this.auditLogFile = path.join(this.storageDir, 'plugin-audit.jsonl');
    this.crashStateFile = path.join(this.storageDir, 'plugin-crash-state.json');
    this.pluginLogDir = path.join(this.storageDir, 'logs');
    this.pluginsEnabled = boolFromEnv(process.env.PLUGINS_ENABLED, false);
    this.pluginInstallEnabled = boolFromEnv(process.env.PLUGINS_ALLOW_INSTALL, false);

    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }

    if (!fs.existsSync(this.pluginLogDir)) {
      fs.mkdirSync(this.pluginLogDir, { recursive: true });
    }
  }

  private stripUtf8Bom(raw: string): string {
    return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  }

  private readJsonFile<T>(filePath: string): T {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(this.stripUtf8Bom(raw)) as T;
  }

  isSystemEnabled(): boolean {
    return this.pluginsEnabled;
  }

  isInstallEnabled(): boolean {
    return this.pluginInstallEnabled;
  }

  async loadAll() {
    if (!this.pluginsEnabled) {
      console.log('[Plugins] Plugin system disabled (PLUGINS_ENABLED=false); skipping plugin load.');
      return;
    }

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
    if (!this.pluginsEnabled) {
      return;
    }

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

      const manifest = this.readJsonFile<PluginManifest>(manifestPath);

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
      const signature = this.verifyPluginSignature(manifest, integrity.calculatedChecksum);
      const combinedVerificationPassed = integrity.passed && signature.passed;
      const combinedVerificationReason = integrity.passed
        ? signature.reason
        : `${integrity.reason}; ${signature.reason}`;
      this.writeAuditEvent({
        actor: 'system',
        pluginId,
        version: manifest.version,
        action: 'verify',
        result: combinedVerificationPassed ? 'success' : 'failure',
        reason: combinedVerificationReason
      });

      if (!combinedVerificationPassed) {
        this.upsertPluginRecord(
          manifest,
          'fail',
          integrity.calculatedChecksum,
          signature
        );
        console.error(`❌ Plugin verification failed for ${pluginId}: ${combinedVerificationReason}`);
        this.recordCrash(pluginId);
        return;
      }

      const scanResult = this.scanPluginPackage(pluginPath, pluginId);
      this.writeAuditEvent({
        actor: 'system',
        pluginId,
        version: manifest.version,
        action: 'scan',
        result: scanResult.status === 'skipped' ? 'skipped' : (scanResult.passed ? 'success' : 'failure'),
        reason: scanResult.reason
      });

      if (!scanResult.passed) {
        this.upsertPluginRecord(
          manifest,
          'fail',
          integrity.calculatedChecksum,
          signature,
          scanResult
        );
        console.error(`❌ Plugin scanner gate failed for ${pluginId}: ${scanResult.reason}`);
        this.recordCrash(pluginId);
        return;
      }

      this.upsertPluginRecord(
        manifest,
        'pass',
        integrity.calculatedChecksum,
        signature,
        scanResult
      );

      const backendEntryUrl = pathToFileURL(backendEntry).href;
      const pluginModule = await import(backendEntryUrl);
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

      this.registerPluginRoutes(pluginId, manifest.name, plugin.routes);
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

  async installPluginFromArchive(
    archiveBuffer: Buffer,
    options: { uploadedBy?: string; fileName?: string } = {}
  ): Promise<{ pluginId: string; name: string; version: string }> {
    if (!this.pluginsEnabled) {
      throw new Error('Plugin system is disabled by operator configuration');
    }
    if (!this.pluginInstallEnabled) {
      throw new Error('Plugin installation is disabled by operator configuration');
    }

    const actor = options.uploadedBy || 'system';
    const fileName = options.fileName || 'plugin.zip';
    const installTempRoot = path.join(this.storageDir, 'install-tmp');
    const installTempDir = path.join(
      installTempRoot,
      `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`
    );
    const extractDir = path.join(installTempDir, 'extract');

    fs.mkdirSync(extractDir, { recursive: true });

    try {
      const zip = new AdmZip(archiveBuffer);
      const entries = zip.getEntries();
      if (entries.length === 0) {
        throw new Error('Archive is empty');
      }

      for (const entry of entries) {
        const normalizedEntryName = entry.entryName.replace(/\\/g, '/');
        if (!normalizedEntryName || normalizedEntryName.startsWith('/') || normalizedEntryName.includes('..')) {
          throw new Error(`Unsafe archive path detected: ${entry.entryName}`);
        }

        const outputPath = path.join(extractDir, normalizedEntryName);
        const resolvedOutputPath = path.resolve(outputPath);
        const resolvedExtractDir = path.resolve(extractDir);
        if (!resolvedOutputPath.startsWith(`${resolvedExtractDir}${path.sep}`) && resolvedOutputPath !== resolvedExtractDir) {
          throw new Error(`Unsafe archive extraction target: ${entry.entryName}`);
        }

        if (entry.isDirectory) {
          fs.mkdirSync(outputPath, { recursive: true });
          continue;
        }

        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, entry.getData());
      }

      const manifestCandidates = this.findPluginManifestCandidates(extractDir);
      if (manifestCandidates.length === 0) {
        throw new Error('No plugin.json found in archive');
      }

      manifestCandidates.sort((a, b) => a.length - b.length);
      const manifestPath = manifestCandidates[0];
      const pluginRoot = path.dirname(manifestPath);

      const manifest = this.readJsonFile<PluginManifest>(manifestPath);
      const pluginId = typeof manifest.id === 'string' ? manifest.id.trim() : '';
      if (!pluginId) {
        throw new Error('Plugin manifest is missing a valid id');
      }
      if (!/^[a-z0-9][a-z0-9-_]{0,63}$/i.test(pluginId)) {
        throw new Error('Plugin id must be alphanumeric and may include hyphens/underscores (max 64 chars)');
      }

      const pluginTargetDir = path.join(this.pluginsDir, pluginId);
      if (fs.existsSync(pluginTargetDir)) {
        throw new Error(`Plugin '${pluginId}' is already installed`);
      }

      fs.mkdirSync(this.pluginsDir, { recursive: true });
      fs.cpSync(pluginRoot, pluginTargetDir, { recursive: true, errorOnExist: true, force: false });

      this.writeAuditEvent({
        actor,
        pluginId,
        version: manifest.version || 'unknown',
        action: 'discover',
        result: 'success',
        reason: `Plugin archive uploaded (${fileName})`
      });

      await this.loadPlugin(pluginId);
      if (!this.plugins.has(pluginId)) {
        throw new Error(`Plugin '${pluginId}' was copied but failed to load; check backend logs`);
      }

      return {
        pluginId,
        name: manifest.name || pluginId,
        version: manifest.version || 'unknown'
      };
    } finally {
      if (fs.existsSync(installTempDir)) {
        fs.rmSync(installTempDir, { recursive: true, force: true });
      }
    }
  }

  private findPluginManifestCandidates(rootDir: string): string[] {
    const found: string[] = [];
    const walk = (currentDir: string): void => {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
          continue;
        }
        if (entry.isFile() && entry.name.toLowerCase() === 'plugin.json') {
          found.push(fullPath);
        }
      }
    };
    walk(rootDir);
    return found;
  }

  private registerPluginRoutes(
    pluginId: string,
    pluginName: string,
    routes: BackendPlugin['routes'] | undefined
  ): void {
    if (!routes || routes.length === 0) return;

    for (const route of routes) {
      if (!route?.path || typeof route.path !== 'string' || typeof route.handler !== 'function') {
        console.warn(`  ⚠️  Plugin ${pluginName} has an invalid route declaration and it was skipped`);
        continue;
      }

      const method = (route.method || 'get').toLowerCase() as RegisteredPluginRoute['method'];
      if (!['get', 'post', 'put', 'delete'].includes(method)) {
        console.warn(`  ⚠️  Plugin ${pluginName} route ${route.path} uses unsupported method ${route.method}`);
        continue;
      }

      const normalizedPath = route.path.startsWith('/') ? route.path : `/${route.path}`;
      this.pluginRoutes.push({
        pluginId,
        method,
        path: normalizedPath,
        handler: route.handler
      });
    }

    console.log(`  🌐 Plugin HTTP routes mounted at ${PLUGIN_HTTP_ROUTE_PREFIX}/${pluginId}/*`);
  }

  async handleHttpRoute(req: any, res: any, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith(`${PLUGIN_HTTP_ROUTE_PREFIX}/`)) {
      return false;
    }

    if (!this.pluginsEnabled) {
      this.writeJson(res, 503, { success: false, error: 'Plugin system is disabled' });
      return true;
    }

    const suffix = url.pathname.slice(`${PLUGIN_HTTP_ROUTE_PREFIX}/`.length);
    const slashIndex = suffix.indexOf('/');
    const pluginId = decodeURIComponent((slashIndex >= 0 ? suffix.slice(0, slashIndex) : suffix).trim());
    const routePath = slashIndex >= 0 ? suffix.slice(slashIndex) : '/';
    const method = (req.method || 'GET').toLowerCase();

    if (!pluginId) {
      this.writeJson(res, 400, { success: false, error: 'Plugin id is required' });
      return true;
    }

    if (!this.plugins.has(pluginId)) {
      this.writeJson(res, 404, { success: false, error: `Plugin '${pluginId}' is not loaded` });
      return true;
    }

    const route = this.pluginRoutes.find((candidate) =>
      candidate.pluginId === pluginId &&
      candidate.method === method &&
      this.matchesPluginRoute(routePath, candidate.path)
    );

    if (!route) {
      this.writeJson(res, 404, { success: false, error: 'Plugin route not found' });
      return true;
    }

    try {
      const bodyReaders = this.createRequestBodyReaders(req);
      const pluginReq = {
        raw: req,
        method: req.method || 'GET',
        headers: req.headers,
        url: req.url || '',
        path: routePath,
        query: Object.fromEntries(url.searchParams.entries()),
        params: { pluginId, path: routePath },
        json: bodyReaders.json,
        text: bodyReaders.text,
        buffer: bodyReaders.buffer
      };
      const pluginRes = this.createPluginResponse(res);

      await route.handler(pluginReq, pluginRes);
    } catch (error) {
      console.error(`[Plugins] Route handler failed for ${pluginId} ${method.toUpperCase()} ${routePath}:`, error);
      if (!res.headersSent && !res.writableEnded) {
        this.writeJson(res, 500, { success: false, error: 'Plugin route handler failed' });
      }
    }

    return true;
  }

  private matchesPluginRoute(actualPath: string, routePath: string): boolean {
    if (routePath === actualPath) return true;
    if (routePath === '*' || routePath === '/*') return true;

    if (routePath.endsWith('/*')) {
      const base = routePath.slice(0, -1);
      return actualPath === base.slice(0, -1) || actualPath.startsWith(base);
    }

    return false;
  }

  private createRequestBodyReaders(req: any): {
    json: () => Promise<any>;
    text: () => Promise<string>;
    buffer: () => Promise<Buffer>;
  } {
    let bodyPromise: Promise<Buffer> | null = null;
    const maxBytes = Number(process.env.PLUGIN_ROUTE_MAX_BODY_BYTES || DEFAULT_PLUGIN_ROUTE_BODY_LIMIT_BYTES);

    const getBody = (): Promise<Buffer> => {
      if (bodyPromise) return bodyPromise;

      bodyPromise = new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;

        req.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            reject(new Error(`Plugin route body exceeded ${maxBytes} bytes`));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', (error: Error) => reject(error));
      });

      return bodyPromise;
    };

    return {
      buffer: async () => getBody(),
      text: async () => (await getBody()).toString('utf-8'),
      json: async () => {
        const raw = this.stripUtf8Bom((await getBody()).toString('utf-8')).trim();
        if (!raw) return {};
        return JSON.parse(raw);
      }
    };
  }

  private createPluginResponse(res: any): any {
    const pluginRes: any = {
      raw: res,
      status: (code: number) => {
        res.statusCode = code;
        return pluginRes;
      },
      setHeader: (name: string, value: string) => {
        res.setHeader(name, value);
        return pluginRes;
      },
      set: (name: string, value: string) => {
        res.setHeader(name, value);
        return pluginRes;
      },
      json: (payload: any) => {
        if (!res.headersSent) {
          res.setHeader('Content-Type', 'application/json');
        }
        res.end(JSON.stringify(payload));
      },
      send: (payload: any) => {
        if (Buffer.isBuffer(payload) || typeof payload === 'string') {
          res.end(payload);
          return;
        }
        if (!res.headersSent) {
          res.setHeader('Content-Type', 'application/json');
        }
        res.end(JSON.stringify(payload));
      },
      end: (payload?: any) => {
        res.end(payload);
      }
    };

    return pluginRes;
  }

  private writeJson(res: any, statusCode: number, payload: any): void {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
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
          return this.readJsonFile(filePath);
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

  private getSignaturePolicy(): PluginSignaturePolicy {
    const raw = (process.env.PLUGIN_SIGNATURE_POLICY || 'warn-allow').trim().toLowerCase();
    if (raw === 'signed-only' || raw === 'curated-only') return raw;
    return 'warn-allow';
  }

  private getScanPolicy(): PluginScanPolicy {
    const raw = (process.env.PLUGIN_SCAN_POLICY || 'warn').trim().toLowerCase();
    if (raw === 'off' || raw === 'enforce') return raw;
    return 'warn';
  }

  private scanPluginPackage(pluginPath: string, pluginId: string): PluginScanResult {
    const policy = this.getScanPolicy();
    if (policy === 'off') {
      return { passed: true, status: 'skipped', reason: 'Plugin scanning disabled (policy=off)' };
    }

    const scannerTemplate = (process.env.PLUGIN_SCANNER_CMD || '').trim();
    if (!scannerTemplate) {
      const reason = 'PLUGIN_SCANNER_CMD not configured';
      if (policy === 'enforce') {
        return { passed: false, status: 'error', reason: `${reason}; enforce policy blocks plugin load` };
      }
      return { passed: true, status: 'skipped', reason: `${reason}; warn policy allows plugin load` };
    }

    const quotedPath = `"${pluginPath.replace(/"/g, '\\"')}"`;
    const quotedPluginId = `"${pluginId.replace(/"/g, '\\"')}"`;
    let command = scannerTemplate
      .replaceAll('{{pluginPath}}', quotedPath)
      .replaceAll('{{pluginId}}', quotedPluginId);
    if (!scannerTemplate.includes('{{pluginPath}}')) {
      command = `${command} ${quotedPath}`;
    }

    const timeoutMs = Number(process.env.PLUGIN_SCANNER_TIMEOUT_MS || DEFAULT_PLUGIN_SCAN_TIMEOUT_MS);
    const result = spawnSync(command, {
      shell: true,
      encoding: 'utf-8',
      timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : DEFAULT_PLUGIN_SCAN_TIMEOUT_MS
    });

    if (result.error) {
      const reason = `Scanner execution error: ${result.error.message}`;
      if (policy === 'enforce') {
        return { passed: false, status: 'error', reason };
      }
      return { passed: true, status: 'error', reason: `${reason}; warn policy allows plugin load` };
    }

    const exitCode = typeof result.status === 'number' ? result.status : -1;
    if (exitCode === 0) {
      return { passed: true, status: 'clean', reason: `Scanner command passed (exit code ${exitCode})` };
    }

    const stderr = (result.stderr || '').toString().trim();
    const stdout = (result.stdout || '').toString().trim();
    const detail = stderr || stdout || 'no scanner output';
    const reason = `Scanner reported suspicious result (exit code ${exitCode}): ${detail}`;
    if (policy === 'enforce') {
      return { passed: false, status: 'suspicious', reason };
    }

    return { passed: true, status: 'suspicious', reason: `${reason}; warn policy allows plugin load` };
  }

  private verifyPluginSignature(
    manifest: PluginManifest,
    calculatedChecksum: string
  ): { passed: boolean; reason: string; status: PluginRecord['signatureStatus']; signerTrust: PluginRecord['signerTrust'] } {
    const policy = this.getSignaturePolicy();
    const isCurated = manifest.firstParty === true;
    const rawSignature = manifest.integrity?.signature;
    const signature = rawSignature && rawSignature !== 'unsigned-local-dev' ? rawSignature : undefined;
    const publicKeyPem = manifest.signer?.publicKey;
    const keyId = manifest.signer?.keyId;
    const trustedSigners = this.readTrustedSigners();
    const trustedByKeyId = keyId ? trustedSigners.find((entry) => entry.keyId === keyId) : null;
    const trustedByPublicKey = publicKeyPem ? trustedSigners.find((entry) => entry.publicKey === publicKeyPem) : null;
    const trustedSigner = trustedByKeyId || trustedByPublicKey;

    if (policy === 'curated-only' && !isCurated) {
      return {
        passed: false,
        reason: 'Signature policy requires curated/first-party plugins only',
        status: 'skipped',
        signerTrust: 'n/a'
      };
    }

    if (!signature) {
      if (policy === 'signed-only') {
        return {
          passed: false,
          reason: 'Missing signature under signed-only policy',
          status: 'unsigned',
          signerTrust: 'n/a'
        };
      }
      return {
        passed: true,
        reason: 'Unsigned plugin allowed under warn-allow policy',
        status: 'unsigned',
        signerTrust: 'n/a'
      };
    }

    if (!publicKeyPem) {
      if (policy === 'warn-allow') {
        return {
          passed: true,
          reason: 'Signer public key missing; treating plugin as unsigned under warn-allow policy',
          status: 'unsigned',
          signerTrust: 'n/a'
        };
      }
      return {
        passed: false,
        reason: 'Signature present but signer.publicKey is missing',
        status: 'invalid',
        signerTrust: 'unknown'
      };
    }

    try {
      const publicKey = crypto.createPublicKey(publicKeyPem);
      const verified = crypto.verify(
        null,
        Buffer.from(calculatedChecksum, 'utf-8'),
        publicKey,
        Buffer.from(signature, 'base64')
      );
      if (!verified) {
        return {
          passed: false,
          reason: 'Signature verification failed',
          status: 'invalid',
          signerTrust: trustedSigner ? 'trusted' : 'unknown'
        };
      }
    } catch (error) {
      return {
        passed: false,
        reason: `Signature verification error: ${error instanceof Error ? error.message : String(error)}`,
        status: 'invalid',
        signerTrust: trustedSigner ? 'trusted' : 'unknown'
      };
    }

    if (policy === 'signed-only' && !trustedSigner && !isCurated) {
      return {
        passed: false,
        reason: 'Signer is not trusted under signed-only policy',
        status: 'verified',
        signerTrust: 'unknown'
      };
    }

    return {
      passed: true,
      reason: trustedSigner ? 'Signature verified with trusted signer' : 'Signature verified (unknown signer)',
      status: 'verified',
      signerTrust: trustedSigner ? 'trusted' : 'unknown'
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

  private upsertPluginRecord(
    manifest: PluginManifest,
    result: PluginRecord['lastVerificationResult'],
    calculatedChecksum: string,
    signature?: { status: PluginRecord['signatureStatus']; signerTrust: PluginRecord['signerTrust'] },
    scan?: PluginScanResult
  ) {
    const records = this.readPluginRecords();
    records[manifest.id] = {
      id: manifest.id,
      version: manifest.version,
      checksum: manifest.integrity?.checksum || calculatedChecksum || undefined,
      signature: manifest.integrity?.signature,
      signerKeyId: manifest.signer?.keyId,
      signatureStatus: signature?.status,
      signerTrust: signature?.signerTrust,
      scanStatus: scan?.status,
      scanReason: scan?.reason,
      lastScannedAt: scan ? new Date().toISOString() : records[manifest.id]?.lastScannedAt,
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
      return this.readJsonFile(this.pluginRecordsFile);
    } catch {
      return {};
    }
  }

  private readTrustedSigners(): TrustedSignerRecord[] {
    if (!fs.existsSync(this.trustedSignersFile)) {
      return [];
    }

    try {
      const parsed = this.readJsonFile<any>(this.trustedSignersFile);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry: any) =>
        entry && typeof entry.keyId === 'string' && typeof entry.publicKey === 'string'
      );
    } catch {
      return [];
    }
  }

  private writeTrustedSigners(signers: TrustedSignerRecord[]): void {
    fs.writeFileSync(this.trustedSignersFile, JSON.stringify(signers, null, 2));
  }

  getTrustedSigners(): TrustedSignerRecord[] {
    return this.readTrustedSigners();
  }

  trustSigner(input: { keyId: string; publicKey: string; trustedBy?: string; note?: string }): void {
    const signers = this.readTrustedSigners();
    const existingIndex = signers.findIndex((entry) => entry.keyId === input.keyId || entry.publicKey === input.publicKey);
    const nextRecord: TrustedSignerRecord = {
      keyId: input.keyId,
      publicKey: input.publicKey,
      trustedAt: new Date().toISOString(),
      trustedBy: input.trustedBy || 'system',
      note: input.note
    };
    if (existingIndex >= 0) {
      signers[existingIndex] = nextRecord;
    } else {
      signers.push(nextRecord);
    }
    this.writeTrustedSigners(signers);
  }

  untrustSigner(keyId: string): void {
    const signers = this.readTrustedSigners().filter((entry) => entry.keyId !== keyId);
    this.writeTrustedSigners(signers);
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
      return this.readJsonFile(this.crashStateFile);
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
      const manifest = this.readJsonFile<PluginManifest>(manifestPath);
      return manifest.version;
    } catch {
      return 'unknown';
    }
  }

  getLoadedPlugins() {
    const records = this.readPluginRecords();
    return Array.from(this.plugins.entries()).map(([id, { manifest }]) => ({
      id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      frontendEntry: manifest.frontend?.entry || null,
      backendEntry: manifest.backend?.entry || null,
      hasFrontend: Boolean(manifest.frontend?.entry),
      hasBackend: Boolean(manifest.backend?.entry),
      signerKeyId: manifest.signer?.keyId || null,
      signatureStatus: records[id]?.signatureStatus || 'skipped',
      signerTrust: records[id]?.signerTrust || 'n/a',
      scanStatus: records[id]?.scanStatus || 'skipped'
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
