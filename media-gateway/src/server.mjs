import http from 'http';
import { spawn } from 'child_process';

const VERSION = 'media-gateway/0.1.0';
const HOST = process.env.GATEWAY_HOST || '0.0.0.0';
const PORT = Number(process.env.GATEWAY_PORT || 8095);
const ORIGIN_URL = (process.env.WABI_ORIGIN_URL || '').replace(/\/+$/, '');
const GATEWAY_KEY = (process.env.MEDIA_GATEWAY_KEY || '').trim();
const GATEWAY_REGION = process.env.MEDIA_GATEWAY_REGION || process.env.GATEWAY_REGION || 'unknown';
const HEARTBEAT_INTERVAL_MS = Number(process.env.MEDIA_GATEWAY_HEARTBEAT_INTERVAL_MS || 15000);
const SESSION_SYNC_INTERVAL_MS = Number(process.env.MEDIA_GATEWAY_SESSION_SYNC_INTERVAL_MS || 10000);
const HTTP_TIMEOUT_MS = Number(process.env.MEDIA_GATEWAY_HTTP_TIMEOUT_MS || 10000);
const WORKER_ENABLED = process.env.MEDIA_GATEWAY_WORKER_ENABLED === 'true' || process.env.MEDIA_GATEWAY_WORKER_ENABLED === '1';
const WORKER_CMD = (process.env.MEDIA_GATEWAY_WORKER_CMD || '').trim();
const WORKER_ARGS_JSON = (process.env.MEDIA_GATEWAY_WORKER_ARGS_JSON || '').trim();
const WORKER_ENV_PASSTHROUGH = (process.env.MEDIA_GATEWAY_WORKER_ENV_PASSTHROUGH || '').trim();
const WORKER_SHUTDOWN_TIMEOUT_MS = Number(process.env.MEDIA_GATEWAY_WORKER_SHUTDOWN_TIMEOUT_MS || 8000);

if (!ORIGIN_URL) {
  console.error('[media-gateway] WABI_ORIGIN_URL is required.');
  process.exit(1);
}

if (!GATEWAY_KEY) {
  console.error('[media-gateway] MEDIA_GATEWAY_KEY is required.');
  process.exit(1);
}

if (WORKER_ENABLED && !WORKER_CMD) {
  console.error('[media-gateway] MEDIA_GATEWAY_WORKER_CMD is required when MEDIA_GATEWAY_WORKER_ENABLED=true.');
  process.exit(1);
}

/** @type {Map<string, any>} */
let sessions = new Map();
/** @type {Map<string, any>} */
let sessionWorkers = new Map();
let stats = {
  syncOk: 0,
  syncFail: 0,
  heartbeatOk: 0,
  heartbeatFail: 0,
  workerStarts: 0,
  workerStops: 0,
  workerFailures: 0,
  lastSyncAt: 0,
  lastHeartbeatAt: 0
};

function parseWorkerArgsTemplate() {
  if (!WORKER_ARGS_JSON) return [];
  try {
    const parsed = JSON.parse(WORKER_ARGS_JSON);
    if (!Array.isArray(parsed)) {
      throw new Error('MEDIA_GATEWAY_WORKER_ARGS_JSON must be a JSON array');
    }
    return parsed.map((value) => String(value));
  } catch (error) {
    console.error('[media-gateway] Invalid MEDIA_GATEWAY_WORKER_ARGS_JSON:', error.message);
    process.exit(1);
  }
}

const WORKER_ARG_TEMPLATE = parseWorkerArgsTemplate();

function buildWorkerEnv(session) {
  const env = { ...process.env };
  env.WABI_SESSION_ID = session.sessionId;
  env.WABI_CHANNEL_ID = session.channelId || '';
  env.WABI_KIND = session.kind || 'voice';
  env.WABI_GATEWAY_URL = ORIGIN_URL;
  env.WABI_REGION = GATEWAY_REGION;
  env.WABI_PUBLISH_URL = session.publishUrl;
  env.WABI_PLAYBACK_URL = session.playbackUrl;
  env.WABI_EXPIRES_AT = String(session.expiresAt || 0);
  env.WABI_MEDIA_GATEWAY_KEY = GATEWAY_KEY;

  if (WORKER_ENV_PASSTHROUGH) {
    for (const key of WORKER_ENV_PASSTHROUGH.split(',').map((part) => part.trim()).filter(Boolean)) {
      if (process.env[key] != null) {
        env[key] = process.env[key];
      }
    }
  }

  return env;
}

function applyWorkerTemplateArg(templateArg, session) {
  return templateArg
    .replaceAll('{{sessionId}}', session.sessionId)
    .replaceAll('{{channelId}}', session.channelId || '')
    .replaceAll('{{kind}}', session.kind || 'voice')
    .replaceAll('{{publishUrl}}', session.publishUrl || '')
    .replaceAll('{{playbackUrl}}', session.playbackUrl || '')
    .replaceAll('{{expiresAt}}', String(session.expiresAt || ''));
}

function getRenderedWorkerArgs(session) {
  const rendered = WORKER_ARG_TEMPLATE.map((arg) => applyWorkerTemplateArg(arg, session));
  if (rendered.length > 0) return rendered;
  return [
    '--session-id',
    session.sessionId,
    '--channel-id',
    session.channelId || '',
    '--kind',
    session.kind || 'voice',
    '--publish-url',
    session.publishUrl || '',
    '--playback-url',
    session.playbackUrl || ''
  ];
}

function getWorkerStatus(sessionId) {
  const worker = sessionWorkers.get(sessionId);
  if (!worker) {
    return {
      enabled: WORKER_ENABLED,
      state: WORKER_ENABLED ? 'stopped' : 'disabled',
      startedAt: null,
      lastExitAt: null,
      lastExitCode: null,
      lastExitSignal: null
    };
  }
  return {
    enabled: WORKER_ENABLED,
    state: worker.running ? 'running' : 'stopped',
    startedAt: worker.startedAt || null,
    lastExitAt: worker.lastExitAt || null,
    lastExitCode: worker.lastExitCode ?? null,
    lastExitSignal: worker.lastExitSignal ?? null
  };
}

function startWorkerForSession(session) {
  if (!WORKER_ENABLED) return;
  const current = sessionWorkers.get(session.sessionId);
  if (current?.running) return;

  const args = getRenderedWorkerArgs(session);
  const env = buildWorkerEnv(session);
  const child = spawn(WORKER_CMD, args, {
    env,
    stdio: 'inherit',
    windowsHide: true,
    shell: false
  });

  const state = {
    sessionId: session.sessionId,
    running: true,
    child,
    startedAt: Date.now(),
    lastExitAt: null,
    lastExitCode: null,
    lastExitSignal: null
  };
  sessionWorkers.set(session.sessionId, state);
  stats.workerStarts += 1;

  child.on('error', (error) => {
    stats.workerFailures += 1;
    state.running = false;
    state.lastExitAt = Date.now();
    state.lastExitCode = null;
    state.lastExitSignal = null;
    console.warn(`[media-gateway] Worker error for session ${session.sessionId}:`, error.message);
  });

  child.on('exit', (code, signal) => {
    if (state.running) {
      stats.workerFailures += 1;
    }
    state.running = false;
    state.lastExitAt = Date.now();
    state.lastExitCode = code;
    state.lastExitSignal = signal;
    console.warn(`[media-gateway] Worker exited for session ${session.sessionId} (code=${code}, signal=${signal})`);
  });

  console.log(`[media-gateway] Worker started for session ${session.sessionId}`);
}

function stopWorkerForSession(sessionId) {
  const state = sessionWorkers.get(sessionId);
  if (!state) return;
  if (!state.running || !state.child) return;

  stats.workerStops += 1;
  state.running = false;

  try {
    state.child.kill('SIGTERM');
  } catch {
    // no-op
  }

  const timeout = setTimeout(() => {
    if (state.child.exitCode == null && !state.child.killed) {
      try {
        state.child.kill('SIGKILL');
      } catch {
        // no-op
      }
    }
  }, WORKER_SHUTDOWN_TIMEOUT_MS);
  timeout.unref();
}

function reconcileWorkers(nextSessions) {
  if (!WORKER_ENABLED) return;

  for (const [sessionId] of sessionWorkers.entries()) {
    if (!nextSessions.has(sessionId)) {
      stopWorkerForSession(sessionId);
    }
  }

  for (const session of nextSessions.values()) {
    if (session.status !== 'open') {
      stopWorkerForSession(session.sessionId);
      continue;
    }
    startWorkerForSession(session);
  }
}

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

    reconcileWorkers(next);
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
    const activeSessionIds = WORKER_ENABLED
      ? [...sessions.keys()].filter((sessionId) => sessionWorkers.get(sessionId)?.running === true)
      : [...sessions.keys()];
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
    const rows = [...sessions.values()].map((session) => ({
      ...session,
      worker: getWorkerStatus(session.sessionId)
    }));
    respondJson(res, 200, {
      worker: {
        enabled: WORKER_ENABLED,
        commandConfigured: Boolean(WORKER_CMD),
        shutdownTimeoutMs: WORKER_SHUTDOWN_TIMEOUT_MS
      },
      sessions: rows
    });
    return;
  }

  respondJson(res, 404, { error: 'Not found' });
});

async function shutdown() {
  console.log('[media-gateway] Shutdown requested, stopping workers...');
  for (const [sessionId] of sessionWorkers.entries()) {
    stopWorkerForSession(sessionId);
  }

  await new Promise((resolve) => {
    const started = Date.now();
    const interval = setInterval(() => {
      const running = [...sessionWorkers.values()].some((state) => state.running);
      const expired = Date.now() - started > WORKER_SHUTDOWN_TIMEOUT_MS + 1500;
      if (!running || expired) {
        clearInterval(interval);
        resolve();
      }
    }, 120);
    interval.unref();
  });

  await new Promise((resolve) => {
    server.close(() => resolve());
  });
}

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
    if (WORKER_ENABLED) {
      console.log(`[media-gateway] Worker mode enabled: ${WORKER_CMD}`);
    } else {
      console.log('[media-gateway] Worker mode disabled (control-plane only)');
    }
  });
}

let shuttingDown = false;
async function handleSignal(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[media-gateway] Received ${signal}`);
  try {
    await shutdown();
    process.exit(0);
  } catch (error) {
    console.error('[media-gateway] Shutdown error:', error);
    process.exit(1);
  }
}

process.on('SIGINT', () => void handleSignal('SIGINT'));
process.on('SIGTERM', () => void handleSignal('SIGTERM'));

boot().catch((error) => {
  console.error('[media-gateway] Fatal startup error:', error);
  process.exit(1);
});
