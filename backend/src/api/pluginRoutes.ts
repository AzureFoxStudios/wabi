import type { IncomingMessage, ServerResponse } from 'http';
import type { PluginManager } from '../plugins/loader.js';
import { authMiddleware, requireAdminAuth } from '../middleware/authMiddleware.js';

function parseJsonBody(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function ensureAdmin(req: IncomingMessage, res: ServerResponse): boolean {
  let nextCalled = false;
  authMiddleware(req, res, () => {
    nextCalled = true;
  });

  if (!nextCalled) return false;
  return requireAdminAuth(req, res);
}

function sendJson(res: ServerResponse, status: number, payload: Record<string, any>) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export async function handlePluginRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  pluginManager: PluginManager
): Promise<boolean> {
  if (!url.pathname.startsWith('/api/plugins')) return false;
  if (!ensureAdmin(req, res)) return true;

  try {
    if (url.pathname === '/api/plugins' && req.method === 'GET') {
      sendJson(res, 200, { plugins: pluginManager.getInstalledPlugins() });
      return true;
    }

    const lifecycleMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/lifecycle$/);
    if (lifecycleMatch && req.method === 'GET') {
      sendJson(res, 200, pluginManager.getLifecycle(decodeURIComponent(lifecycleMatch[1])));
      return true;
    }

    const enableMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/enable$/);
    if (enableMatch && req.method === 'POST') {
      const pluginId = decodeURIComponent(enableMatch[1]);
      await pluginManager.enablePlugin(pluginId);
      sendJson(res, 200, { success: true, pluginId, action: 'enabled' });
      return true;
    }

    const disableMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/disable$/);
    if (disableMatch && req.method === 'POST') {
      const pluginId = decodeURIComponent(disableMatch[1]);
      await pluginManager.disablePlugin(pluginId);
      sendJson(res, 200, { success: true, pluginId, action: 'disabled' });
      return true;
    }

    const reloadMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/reload$/);
    if (reloadMatch && req.method === 'POST') {
      const pluginId = decodeURIComponent(reloadMatch[1]);
      await pluginManager.reloadPlugin(pluginId);
      sendJson(res, 200, { success: true, pluginId, action: 'reloaded' });
      return true;
    }

    const uninstallMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/uninstall$/);
    if (uninstallMatch && req.method === 'POST') {
      const pluginId = decodeURIComponent(uninstallMatch[1]);
      await pluginManager.uninstallPlugin(pluginId);
      sendJson(res, 200, { success: true, pluginId, action: 'uninstalled' });
      return true;
    }

    if (url.pathname === '/api/plugins/install' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      if (!body.source) {
        sendJson(res, 400, { error: 'source is required' });
        return true;
      }

      await pluginManager.installPlugin(body.source);
      sendJson(res, 201, { success: true, source: body.source });
      return true;
    }

    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Plugin route failed';
    sendJson(res, 500, { error: message });
    return true;
  }
}
