import http from 'http';

const VERSION = 'media-gateway/0.1.0';
const HOST = process.env.GATEWAY_HOST || '0.0.0.0';
const PORT = Number(process.env.GATEWAY_PORT || 8095);
const ORIGIN_URL = (process.env.WABI_ORIGIN_URL || '').replace(/\/+$/, '');
const GATEWAY_KEY = (process.env.MEDIA_GATEWAY_KEY || '').trim();
const GATEWAY_REGION = process.env.MEDIA_GATEWAY_REGION || process.env.GATEWAY_REGION || 'unknown';
const HEARTBEAT_INTERVAL_MS = Number(process.env.MEDIA_GATEWAY_HEARTBEAT_INTERVAL_MS || 15000);
const SESSION_SYNC_INTERVAL_MS = Number(process.env.MEDIA_GATEWAY_SESSION_SYNC_INTERVAL_MS || 10000);
const HTTP_TIMEOUT_MS = Number(process.env.MEDIA_GATEWAY_HTTP_TIMEOUT_MS || 10000);

if (!ORIGIN_URL) {
  console.error('[media-gateway] WABI_ORIGIN_URL is required.');
  process.exit(1);
}

if (!GATEWAY_KEY) {
  console.error('[media-gateway] MEDIA_GATEWAY_KEY is required.');
  process.exit(1);
}

let sessions = new Map();
let stats = {
  syncOk: 0,
  syncFail: 0,
  heartbeatOk: 0,
  heartbeatFail: 0,
  lastSyncAt: 0,
  lastHeartbeatAt: 0
};

async function fetchJson(url, options = {}) {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: abort.signal
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

function buildGatewayHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Media-Gateway-Key': GATEWAY_KEY
  };
}

async function syncSessionsFromOrigin() {
  try {
    const { response, body } = await fetchJson(`${ORIGIN_URL}/api/media/gateway/control/sessions`, {
      method: 'GET',
      headers: buildGatewayHeaders()
    });

    if (!response.ok) {
      throw new Error(`control session sync failed (${response.status}): ${body?.error || response.statusText}`);
    }

    const next = new Map();
    const rawSessions = Array.isArray(body?.sessions) ? body.sessions : [];
    for (const session of rawSessions) {
      if (!session || typeof session !== 'object') continue;
      if (typeof session.sessionId !== 'string') continue;
      next.set(session.sessionId, session);
    }

    sessions = next;
    stats.syncOk += 1;
    stats.lastSyncAt = Date.now();
  } catch (error) {
    stats.syncFail += 1;
    console.warn('[media-gateway] Session sync failed:', error.message);
  }
}

async function sendHeartbeat() {
  try {
    const activeSessionIds = [...sessions.keys()];
    const { response, body } = await fetchJson(`${ORIGIN_URL}/api/media/gateway-heartbeat`, {
      method: 'POST',
      headers: buildGatewayHeaders(),
      body: JSON.stringify({
        version: VERSION,
        region: GATEWAY_REGION,
        activeStreams: activeSessionIds.length,
        activeSessionIds
      })
    });

    if (!response.ok) {
      throw new Error(`gateway heartbeat failed (${response.status}): ${body?.error || response.statusText}`);
    }

    stats.heartbeatOk += 1;
    stats.lastHeartbeatAt = Date.now();
  } catch (error) {
    stats.heartbeatFail += 1;
    console.warn('[media-gateway] Heartbeat failed:', error.message);
  }
}

function respondJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    respondJson(res, 200, {
      status: 'ok',
      version: VERSION,
      region: GATEWAY_REGION,
      sessions: {
        active: sessions.size
      },
      stats
    });
    return;
  }

  if (url.pathname === '/sessions') {
    respondJson(res, 200, {
      sessions: [...sessions.values()]
    });
    return;
  }

  respondJson(res, 404, { error: 'Not found' });
});

async function boot() {
  await syncSessionsFromOrigin();
  await sendHeartbeat();

  setInterval(async () => {
    await syncSessionsFromOrigin();
  }, SESSION_SYNC_INTERVAL_MS).unref();

  setInterval(async () => {
    await sendHeartbeat();
  }, HEARTBEAT_INTERVAL_MS).unref();

  server.listen(PORT, HOST, () => {
    console.log(`[media-gateway] Listening on http://${HOST}:${PORT}`);
    console.log(`[media-gateway] Origin: ${ORIGIN_URL}`);
    console.log(`[media-gateway] Region: ${GATEWAY_REGION}`);
  });
}

boot().catch((error) => {
  console.error('[media-gateway] Fatal startup error:', error);
  process.exit(1);
});
