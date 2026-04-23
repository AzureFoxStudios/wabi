import type { IncomingMessage, ServerResponse } from 'http';
import type {
  AdminCompressionConfig,
  RuntimeGuardrailsSnapshot,
  RuntimeTuningConfig
} from '../../../shared/runtimeAdminContracts.js';

import {
  isInvalidJsonBodyError,
  isRequestBodyTooLargeError,
  readJsonObjectBody,
  readMultipartSingleFile,
  readRequestBuffer
} from '../utils/requestBodies.js';

interface RuntimeAdminPluginSummary extends Record<string, unknown> {
  id: string;
  name: string;
  version: string;
  description?: string;
  hasFrontend?: boolean;
  hasBackend?: boolean;
}

interface RuntimeAdminDependencies {
  pluginLoader: {
    isSystemEnabled: () => boolean;
    isInstallEnabled: () => boolean;
    getLoadedPlugins: () => RuntimeAdminPluginSummary[];
    getAuditEvents: (limit: number) => unknown;
    getTrustedSigners: () => unknown;
    trustSigner: (input: { keyId: string; publicKey: string; trustedBy: string; note?: string }) => void;
    installPluginFromArchive: (
      archive: Buffer,
      options: { uploadedBy: string; fileName: string }
    ) => Promise<unknown>;
    untrustSigner: (keyId: string) => void;
  };
  getAuthenticatedUserId: (req: IncomingMessage) => number | null;
  isPluginAdmin: (userId: number | null) => boolean;
  isKnownPolicyKey: (value: string) => boolean;
  getPolicyValue: <TValue>(key: string) => TValue;
  getPolicyDefaults: <TValue>(key: string) => TValue;
  savePolicyValue: <TValue>(key: string, rawInput: unknown) => TValue;
  runtimePolicyKey: string;
  uploadLimitsPolicyKey: string;
  getCompressionMetricsSnapshot: () => unknown;
  compressionConfig: AdminCompressionConfig;
  getRuntimeGuardrailsSnapshot: () => RuntimeGuardrailsSnapshot;
  startupRuntimeTuning: RuntimeTuningConfig;
  stateReducerIngress: {
    getPath: () => string;
    isEnabled: () => boolean;
    getMaxBodyBytes: () => number;
    handle: (input: {
      headers: Record<string, string | string[] | undefined>;
      body: string;
      remoteAddress: string | null;
    }) => {
      status: number;
      success: boolean;
      duplicate?: boolean;
      reason?: string;
      message?: string;
    };
  };
  getMeshSharedToken: () => string | null;
  constantTimeEqualString: (a: string, b: string) => boolean;
  normalizeMeshInboundDelivery: (payload: Record<string, unknown>) => { deliveryId: string } & Record<string, unknown>;
  hasSeenMeshDelivery: (deliveryId: string) => boolean;
  applyInboundMeshDelivery: (delivery: { deliveryId: string } & Record<string, unknown>) => boolean;
  markSeenMeshDelivery: (deliveryId: string) => void;
  getStatePlaneRuntimeStats: () => unknown;
  resetCompressionMetrics: () => void;
}

function writeJson(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function requirePluginAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RuntimeAdminDependencies
): number | null {
  const userId = deps.getAuthenticatedUserId(req);
  if (!deps.isPluginAdmin(userId)) {
    writeJson(res, 403, { success: false, error: 'Admin permissions required' });
    return null;
  }
  return userId;
}

export async function handleRuntimeAdminRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: RuntimeAdminDependencies
): Promise<boolean> {
  if (url.pathname === '/api/plugins' && req.method === 'GET') {
    const userId = deps.getAuthenticatedUserId(req);
    const isAdmin = deps.isPluginAdmin(userId);

    if (!deps.pluginLoader.isSystemEnabled()) {
      writeJson(res, 200, {
        success: true,
        plugins: [],
        scope: isAdmin ? 'admin' : 'public',
        enabled: false,
        installEnabled: false
      });
      return true;
    }

    try {
      const plugins = deps.pluginLoader.getLoadedPlugins();
      const responsePlugins = isAdmin
        ? plugins
        : plugins.map((plugin) => ({
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            description: plugin.description,
            hasFrontend: plugin.hasFrontend,
            hasBackend: plugin.hasBackend
          }));
      writeJson(res, 200, {
        success: true,
        plugins: responsePlugins,
        scope: isAdmin ? 'admin' : 'public'
      });
    } catch (error) {
      console.error('[Plugins] Failed to fetch plugin list:', error);
      writeJson(res, 500, { success: false, error: 'Failed to list plugins' });
    }
    return true;
  }

  if (url.pathname === '/api/plugins/audit' && req.method === 'GET') {
    if (!deps.pluginLoader.isSystemEnabled()) {
      writeJson(res, 503, { success: false, error: 'Plugin system is disabled by operator' });
      return true;
    }

    if (requirePluginAdmin(req, res, deps) === null) {
      return true;
    }

    try {
      const rawLimit = Number(url.searchParams.get('limit') || '200');
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(1000, Math.floor(rawLimit))) : 200;
      const events = deps.pluginLoader.getAuditEvents(limit);
      writeJson(res, 200, { success: true, events });
    } catch (error) {
      console.error('[Plugins] Failed to fetch audit log:', error);
      writeJson(res, 500, { success: false, error: 'Failed to fetch plugin audit log' });
    }
    return true;
  }

  if (url.pathname === '/api/plugins/signers' && req.method === 'GET') {
    if (!deps.pluginLoader.isSystemEnabled()) {
      writeJson(res, 503, { success: false, error: 'Plugin system is disabled by operator' });
      return true;
    }

    if (requirePluginAdmin(req, res, deps) === null) {
      return true;
    }

    try {
      writeJson(res, 200, { success: true, signers: deps.pluginLoader.getTrustedSigners() });
    } catch (error) {
      console.error('[Plugins] Failed to fetch trusted signers:', error);
      writeJson(res, 500, { success: false, error: 'Failed to fetch trusted signers' });
    }
    return true;
  }

  if (url.pathname === '/api/plugins/signers' && req.method === 'POST') {
    if (!deps.pluginLoader.isSystemEnabled()) {
      writeJson(res, 503, { success: false, error: 'Plugin system is disabled by operator' });
      return true;
    }

    const userId = requirePluginAdmin(req, res, deps);
    if (userId === null) {
      return true;
    }

    try {
      const body = await readJsonObjectBody(req);
      const keyId = typeof body.keyId === 'string' ? body.keyId.trim() : '';
      const publicKey = typeof body.publicKey === 'string' ? body.publicKey.trim() : '';
      const note = typeof body.note === 'string' ? body.note.trim() : '';

      if (!keyId || !publicKey) {
        writeJson(res, 400, { success: false, error: 'keyId and publicKey are required' });
        return true;
      }

      deps.pluginLoader.trustSigner({
        keyId,
        publicKey,
        trustedBy: `user:${userId}`,
        note: note || undefined
      });

      writeJson(res, 200, {
        success: true,
        signers: deps.pluginLoader.getTrustedSigners()
      });
    } catch (error) {
      if (isRequestBodyTooLargeError(error)) {
        writeJson(res, 413, { success: false, error: 'Request payload exceeds server limit' });
        return true;
      }
      console.error('[Plugins] Failed to trust signer:', error);
      writeJson(res, 400, { success: false, error: 'Invalid request payload' });
    }
    return true;
  }

  if (url.pathname === '/api/plugins/install' && req.method === 'POST') {
    if (!deps.pluginLoader.isSystemEnabled()) {
      writeJson(res, 503, { success: false, error: 'Plugin system is disabled by operator' });
      return true;
    }
    if (!deps.pluginLoader.isInstallEnabled()) {
      writeJson(res, 403, { success: false, error: 'Plugin install is disabled by operator' });
      return true;
    }

    const userId = requirePluginAdmin(req, res, deps);
    if (userId === null) {
      return true;
    }

    try {
      const bodyBuffer = await readRequestBuffer(req, 110 * 1024 * 1024);
      const uploaded = readMultipartSingleFile(req.headers['content-type'], bodyBuffer, 'pluginPackage');
      if (!uploaded) {
        writeJson(res, 400, {
          success: false,
          error: 'pluginPackage file is required (multipart/form-data)'
        });
        return true;
      }
      if (uploaded.data.length > 100 * 1024 * 1024) {
        writeJson(res, 413, { success: false, error: 'Plugin package is too large (max 100MB)' });
        return true;
      }

      const lowerName = uploaded.fileName.toLowerCase();
      if (!lowerName.endsWith('.zip') && !lowerName.endsWith('.wabi-plugin') && !lowerName.endsWith('.wabip')) {
        writeJson(res, 400, {
          success: false,
          error: 'Plugin package must be a .zip, .wabi-plugin, or .wabip file'
        });
        return true;
      }

      const result = await deps.pluginLoader.installPluginFromArchive(uploaded.data, {
        uploadedBy: `user:${userId}`,
        fileName: uploaded.fileName
      });

      writeJson(res, 200, { success: true, plugin: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to install plugin package';
      if (message.startsWith('request_body_too_large')) {
        writeJson(res, 413, {
          success: false,
          error: 'Plugin package payload exceeds server request limit'
        });
        return true;
      }
      const isClientError =
        message.includes('already installed') ||
        message.includes('No plugin.json') ||
        message.includes('Plugin manifest') ||
        message.includes('Unsafe archive') ||
        message.includes('Plugin id');
      writeJson(res, isClientError ? 400 : 500, { success: false, error: message });
    }
    return true;
  }

  const policyPathMatch = url.pathname.match(/^\/api\/admin\/policies\/([^/]+)$/);
  if (policyPathMatch && req.method === 'GET') {
    if (requirePluginAdmin(req, res, deps) === null) {
      return true;
    }

    const requestedKey = decodeURIComponent(policyPathMatch[1]);
    if (!deps.isKnownPolicyKey(requestedKey)) {
      writeJson(res, 404, { success: false, error: 'Unknown policy key' });
      return true;
    }

    writeJson(res, 200, {
      success: true,
      key: requestedKey,
      config: deps.getPolicyValue(requestedKey),
      defaults: deps.getPolicyDefaults(requestedKey)
    });
    return true;
  }

  if (policyPathMatch && req.method === 'POST') {
    if (requirePluginAdmin(req, res, deps) === null) {
      return true;
    }

    const requestedKey = decodeURIComponent(policyPathMatch[1]);
    if (!deps.isKnownPolicyKey(requestedKey)) {
      writeJson(res, 404, { success: false, error: 'Unknown policy key' });
      return true;
    }

    try {
      const rawBody = await readJsonObjectBody(req);
      const config = deps.savePolicyValue(requestedKey, rawBody);
      writeJson(res, 200, {
        success: true,
        key: requestedKey,
        config,
        restartRequired: requestedKey === deps.runtimePolicyKey
      });
    } catch (error) {
      if (isRequestBodyTooLargeError(error)) {
        writeJson(res, 413, { success: false, error: 'Policy payload exceeds server limit' });
        return true;
      }
      writeJson(res, 400, { success: false, error: 'Invalid policy payload' });
    }
    return true;
  }

  if (url.pathname === '/api/admin/upload-limits' && req.method === 'GET') {
    if (requirePluginAdmin(req, res, deps) === null) {
      return true;
    }
    writeJson(res, 200, {
      success: true,
      config: deps.getPolicyValue(deps.uploadLimitsPolicyKey),
      defaults: deps.getPolicyDefaults(deps.uploadLimitsPolicyKey)
    });
    return true;
  }

  if (url.pathname === '/api/admin/upload-limits' && req.method === 'POST') {
    if (requirePluginAdmin(req, res, deps) === null) {
      return true;
    }

    try {
      const rawBody = await readJsonObjectBody(req);
      const config = deps.savePolicyValue(deps.uploadLimitsPolicyKey, rawBody);
      writeJson(res, 200, { success: true, config });
    } catch (error) {
      if (isRequestBodyTooLargeError(error)) {
        writeJson(res, 413, { success: false, error: 'Upload limit payload exceeds server limit' });
        return true;
      }
      writeJson(res, 400, { success: false, error: 'Invalid upload limit payload' });
    }
    return true;
  }

  if (url.pathname === '/api/admin/compression-metrics' && req.method === 'GET') {
    if (requirePluginAdmin(req, res, deps) === null) {
      return true;
    }
    writeJson(res, 200, {
      success: true,
      metrics: deps.getCompressionMetricsSnapshot()
    });
    return true;
  }

  if (url.pathname === '/api/admin/compression-config' && req.method === 'GET') {
    if (requirePluginAdmin(req, res, deps) === null) {
      return true;
    }
    writeJson(res, 200, {
      success: true,
      config: deps.compressionConfig
    });
    return true;
  }

  if (url.pathname === '/api/admin/runtime-guardrails' && req.method === 'GET') {
    if (requirePluginAdmin(req, res, deps) === null) {
      return true;
    }

    const configured = deps.getPolicyValue(deps.runtimePolicyKey);
    const runtimeSnapshot = deps.getRuntimeGuardrailsSnapshot();
    const currentUvThreadpoolSize = process.env.UV_THREADPOOL_SIZE
      ? Number(process.env.UV_THREADPOOL_SIZE)
      : null;
    const restartRequired = JSON.stringify(configured) !== JSON.stringify(deps.startupRuntimeTuning);

    writeJson(res, 200, {
      success: true,
      runtimeTuning: {
        configured,
        startupApplied: deps.startupRuntimeTuning,
        restartRequired,
        effective: {
          uvThreadpoolSize: Number.isFinite(currentUvThreadpoolSize as number)
            ? currentUvThreadpoolSize
            : null,
          heavyProfilingEnabled: (
            runtimeSnapshot as { heavyProfiling?: { enabled?: boolean } }
          ).heavyProfiling?.enabled ?? false
        }
      },
      guardrails: runtimeSnapshot
    });
    return true;
  }

  if (url.pathname === deps.stateReducerIngress.getPath() && req.method === 'POST') {
    if (!deps.stateReducerIngress.isEnabled()) {
      writeJson(res, 404, { success: false, error: 'Reducer ingress is disabled' });
      return true;
    }

    const maxBodyBytes = deps.stateReducerIngress.getMaxBodyBytes();
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let responded = false;

    req.on('data', (chunk) => {
      if (responded) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBodyBytes) {
        responded = true;
        writeJson(res, 413, {
          success: false,
          error: `Payload exceeds reducer ingress limit (${maxBodyBytes} bytes)`
        });
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });

    req.on('end', () => {
      if (responded) return;
      const body = Buffer.concat(chunks).toString('utf8');
      const result = deps.stateReducerIngress.handle({
        headers: req.headers as Record<string, string | string[] | undefined>,
        body,
        remoteAddress: req.socket.remoteAddress || null
      });
      writeJson(res, result.status, {
        success: result.success,
        duplicate: result.duplicate,
        reason: result.reason,
        message: result.message
      });
    });

    req.on('error', (error) => {
      if (responded) return;
      responded = true;
      console.error('[StatePlane] Reducer ingress request failed:', error);
      writeJson(res, 500, { success: false, error: 'Reducer ingress request failed' });
    });
    return true;
  }

  if (url.pathname === '/api/internal/mesh/deliver' && req.method === 'POST') {
    const meshToken = deps.getMeshSharedToken();
    if (!meshToken) {
      writeJson(res, 503, { success: false, error: 'Mesh delivery is not configured' });
      return true;
    }

    const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : '';
    const expected = `Bearer ${meshToken}`;
    if (!authHeader || !deps.constantTimeEqualString(authHeader, expected)) {
      writeJson(res, 401, { success: false, error: 'Unauthorized mesh delivery' });
      return true;
    }

    try {
      const body = await readJsonObjectBody(req, 256 * 1024);
      const delivery = deps.normalizeMeshInboundDelivery(body);
      if (deps.hasSeenMeshDelivery(delivery.deliveryId)) {
        writeJson(res, 202, { success: true, duplicate: true });
        return true;
      }

      const delivered = deps.applyInboundMeshDelivery(delivery);
      if (delivered) {
        deps.markSeenMeshDelivery(delivery.deliveryId);
      }
      writeJson(res, 202, { success: true, delivered });
    } catch (error) {
      if (isRequestBodyTooLargeError(error)) {
        writeJson(res, 413, { success: false, error: 'Mesh delivery payload too large' });
        return true;
      }
      writeJson(res, 400, {
        success: false,
        error: isInvalidJsonBodyError(error)
          ? 'Invalid mesh delivery payload'
          : error instanceof Error
            ? error.message
            : String(error)
      });
    }
    return true;
  }

  if (url.pathname === '/api/admin/state-plane' && req.method === 'GET') {
    if (requirePluginAdmin(req, res, deps) === null) {
      return true;
    }
    writeJson(res, 200, {
      success: true,
      runtime: deps.getStatePlaneRuntimeStats()
    });
    return true;
  }

  if (url.pathname === '/api/admin/compression-metrics/reset' && req.method === 'POST') {
    if (requirePluginAdmin(req, res, deps) === null) {
      return true;
    }
    deps.resetCompressionMetrics();
    writeJson(res, 200, { success: true });
    return true;
  }

  if (url.pathname.startsWith('/api/plugins/signers/') && req.method === 'DELETE') {
    if (!deps.pluginLoader.isSystemEnabled()) {
      writeJson(res, 503, { success: false, error: 'Plugin system is disabled by operator' });
      return true;
    }

    if (requirePluginAdmin(req, res, deps) === null) {
      return true;
    }

    try {
      const keyId = decodeURIComponent(url.pathname.replace('/api/plugins/signers/', '')).trim();
      if (!keyId) {
        writeJson(res, 400, { success: false, error: 'keyId is required' });
        return true;
      }

      deps.pluginLoader.untrustSigner(keyId);
      writeJson(res, 200, {
        success: true,
        signers: deps.pluginLoader.getTrustedSigners()
      });
    } catch (error) {
      console.error('[Plugins] Failed to remove trusted signer:', error);
      writeJson(res, 500, { success: false, error: 'Failed to remove trusted signer' });
    }
    return true;
  }

  return false;
}
