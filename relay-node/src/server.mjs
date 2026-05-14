import { createServer } from 'node:http';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = Number(process.env.RELAY_PORT || 8090);
const HOST = process.env.RELAY_HOST || '0.0.0.0';
const ORIGIN_BASE_URL = (process.env.RELAY_ORIGIN_URL || '').replace(/\/+$/, '');
const PUBLIC_URL = (process.env.RELAY_PUBLIC_URL || '').replace(/\/+$/, '');
const RELAY_NAME = process.env.RELAY_NAME || 'Unnamed Relay';
const RELAY_REGION = process.env.RELAY_REGION || 'unknown';
const CACHE_DIR = process.env.RELAY_CACHE_DIR || join(process.cwd(), 'cache');
const STATE_DIR = process.env.RELAY_STATE_DIR || join(process.cwd(), 'state');
const STATE_FILE = join(STATE_DIR, 'registration.json');
const HEARTBEAT_INTERVAL_MS = Number(process.env.RELAY_HEARTBEAT_INTERVAL_MS || 60000);
const CACHE_TTL_SECONDS = Number(process.env.RELAY_CACHE_TTL_SECONDS || 3600);
const MAX_CACHE_BYTES = Number(process.env.RELAY_MAX_CACHE_BYTES || 50 * 1024 * 1024);
const MAX_CACHE_TOTAL_BYTES = Number(process.env.RELAY_MAX_CACHE_TOTAL_BYTES || 2 * 1024 * 1024 * 1024);
const MAX_CACHE_ITEMS = Number(process.env.RELAY_MAX_CACHE_ITEMS || 5000);
const CACHE_CLEAN_INTERVAL_MS = Number(process.env.RELAY_CACHE_CLEAN_INTERVAL_MS || 5 * 60 * 1000);
const ORIGIN_FETCH_TIMEOUT_MS = Number(process.env.RELAY_ORIGIN_FETCH_TIMEOUT_MS || 20_000);
const CACHE_PATH_PREFIXES = (process.env.RELAY_CACHE_PATH_PREFIXES || '/uploads/,/emotes/')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const STARTUP_DELAY_MS = Number(process.env.RELAY_STARTUP_DELAY_MS || 3000);
const CORS_ALLOW_ORIGIN = process.env.RELAY_CORS_ALLOW_ORIGIN || '*';

const bandwidth = parseOptionalInt(process.env.RELAY_BANDWIDTH_MBPS);
const storageGb = parseOptionalInt(process.env.RELAY_STORAGE_GB);
const latitude = parseOptionalFloat(process.env.RELAY_LATITUDE);
const longitude = parseOptionalFloat(process.env.RELAY_LONGITUDE);
const syncthingDeviceId = (process.env.RELAY_SYNCTHING_DEVICE_ID || '').trim() || undefined;

if (!ORIGIN_BASE_URL) {
  console.error('[relay-node] RELAY_ORIGIN_URL is required.');
  process.exit(1);
}

if (!PUBLIC_URL) {
  console.error('[relay-node] RELAY_PUBLIC_URL is required.');
  process.exit(1);
}

const state = {
  relayId: null,
  apiKey: null,
  registeredAt: null
};

const runtimeStats = {
  cacheHits: 0,
  cacheMisses: 0,
  cacheWrites: 0,
  cacheWriteErrors: 0,
  cacheEvictions: 0,
  proxiedRequests: 0,
  proxiedErrors: 0,
  heartbeatsOk: 0,
  heartbeatsFailed: 0,
  registrationAttempts: 0
};

function parseOptionalInt(value) {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalFloat(value) {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isCacheablePath(pathname) {
  return CACHE_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function toCacheKey(pathname, search) {
  return createHash('sha256').update(`${pathname}${search}`).digest('hex');
}

function toCachePaths(key, contentType) {
  const extension = guessExtension(contentType);
  const bodyPath = join(CACHE_DIR, `${key}${extension}`);
  const metaPath = join(CACHE_DIR, `${key}.meta.json`);
  const tempPath = join(CACHE_DIR, `${key}.tmp`);
  return { bodyPath, metaPath, tempPath };
}

function guessExtension(contentType = '') {
  const normalized = contentType.toLowerCase();
  if (normalized.includes('image/jpeg')) return '.jpg';
  if (normalized.includes('image/png')) return '.png';
  if (normalized.includes('image/gif')) return '.gif';
  if (normalized.includes('image/webp')) return '.webp';
  if (normalized.includes('video/mp4')) return '.mp4';
  if (normalized.includes('application/pdf')) return '.pdf';
  return '.bin';
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Range,If-None-Match,If-Modified-Since');
}

async function ensureDirs() {
  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(STATE_DIR, { recursive: true });
}

async function loadState() {
  try {
    const raw = await readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.relayId && parsed.apiKey) {
      state.relayId = parsed.relayId;
      state.apiKey = parsed.apiKey;
      state.registeredAt = parsed.registeredAt || null;
      console.log(`[relay-node] Loaded registration state (relay_id=${state.relayId}).`);
    }
  } catch {
    // First run, no state file.
  }
}

async function saveState() {
  await writeFile(
    STATE_FILE,
    JSON.stringify(
      {
        relayId: state.relayId,
        apiKey: state.apiKey,
        registeredAt: state.registeredAt || Date.now()
      },
      null,
      2
    ),
    'utf8'
  );
}

async function registerRelayIfNeeded() {
  if (state.relayId && state.apiKey) return;
  runtimeStats.registrationAttempts += 1;

  const payload = {
    url: PUBLIC_URL,
    name: RELAY_NAME,
    region: RELAY_REGION,
    latitude,
    longitude,
    bandwidth_mbps: bandwidth,
    storage_gb: storageGb,
    syncthing_device_id: syncthingDeviceId
  };

  const response = await fetch(`${ORIGIN_BASE_URL}/api/relay/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (response.status === 409) {
    const data = await safeJson(response);
    throw new Error(
      `Relay URL already registered at origin. ${data?.error || ''} ` +
      `If this is a re-provisioned node, remove the old relay entry first.`
    );
  }

  if (!response.ok) {
    const data = await safeJson(response);
    throw new Error(`Registration failed (${response.status}): ${data?.error || response.statusText}`);
  }

  const body = await response.json();
  if (!body?.relay_id || !body?.api_key) {
    throw new Error('Registration response missing relay_id/api_key.');
  }

  state.relayId = body.relay_id;
  state.apiKey = body.api_key;
  state.registeredAt = Date.now();
  await saveState();
  console.log(`[relay-node] Registered with origin (relay_id=${state.relayId}, status=${body.status}).`);
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function sendHeartbeat() {
  if (!state.relayId || !state.apiKey) return;

  const payload = {
    bandwidth_mbps: bandwidth,
    storage_gb: storageGb,
    version: 'relay-node/0.1.0',
    region: RELAY_REGION,
    activeStreams: 0
  };

  const response = await fetch(`${ORIGIN_BASE_URL}/api/relay/health`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Relay-Id': String(state.relayId),
      'X-Relay-Key': state.apiKey
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await safeJson(response);
    console.warn(`[relay-node] Heartbeat failed (${response.status}): ${body?.error || response.statusText}`);
    runtimeStats.heartbeatsFailed += 1;
    return;
  }

  runtimeStats.heartbeatsOk += 1;
  console.log('[relay-node] Heartbeat ok.');
}

async function readCache(metaPath, bodyPath) {
  const rawMeta = await readFile(metaPath, 'utf8');
  const meta = JSON.parse(rawMeta);
  const fileStats = await stat(bodyPath);

  const isExpired = Date.now() > meta.expiresAt;
  if (isExpired) {
    return null;
  }

  return { meta, size: fileStats.size };
}

async function writeCache(cachePaths, metadata, buffer) {
  await writeFile(cachePaths.tempPath, buffer);
  await rename(cachePaths.tempPath, cachePaths.bodyPath);
  await writeFile(cachePaths.metaPath, JSON.stringify(metadata), 'utf8');
}

async function getCacheInventory() {
  const entries = await readdir(CACHE_DIR, { withFileTypes: true });
  const bodyFiles = entries
    .filter((entry) => entry.isFile() && !entry.name.endsWith('.meta.json') && !entry.name.endsWith('.tmp'))
    .map((entry) => entry.name);

  const files = [];
  let totalBytes = 0;

  for (const fileName of bodyFiles) {
    const bodyPath = join(CACHE_DIR, fileName);
    const key = fileName.replace(extname(fileName), '');
    const metaPath = join(CACHE_DIR, `${key}.meta.json`);
    let metadata = null;
    try {
      metadata = JSON.parse(await readFile(metaPath, 'utf8'));
    } catch {
      metadata = null;
    }

    let fileStat;
    try {
      fileStat = await stat(bodyPath);
    } catch {
      continue;
    }
    totalBytes += fileStat.size;
    files.push({
      key,
      bodyPath,
      metaPath,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      expiresAt: metadata?.expiresAt || 0
    });
  }

  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return { files, totalBytes };
}

async function evictCacheFile(fileInfo, reason) {
  await Promise.allSettled([
    rm(fileInfo.bodyPath, { force: true }),
    rm(fileInfo.metaPath, { force: true })
  ]);
  runtimeStats.cacheEvictions += 1;
  console.log(`[relay-node] Cache evict (${reason}): ${fileInfo.key}`);
}

async function pruneCache() {
  const now = Date.now();
  const inventory = await getCacheInventory();
  let { files, totalBytes } = inventory;

  // Remove expired entries first.
  for (const fileInfo of [...files]) {
    if (fileInfo.expiresAt > 0 && now > fileInfo.expiresAt) {
      await evictCacheFile(fileInfo, 'expired');
      files = files.filter((f) => f.key !== fileInfo.key);
      totalBytes -= fileInfo.size;
    }
  }

  // Evict oldest until within size/item budgets.
  while (files.length > MAX_CACHE_ITEMS || totalBytes > MAX_CACHE_TOTAL_BYTES) {
    const oldest = files.shift();
    if (!oldest) break;
    await evictCacheFile(oldest, 'budget');
    totalBytes -= oldest.size;
  }
}

function shouldAttemptCache(pathname, reqMethod, upstreamStatus, contentLength, hasRangeHeader) {
  if (reqMethod !== 'GET') return false;
  if (upstreamStatus !== 200) return false;
  if (hasRangeHeader) return false;
  if (!isCacheablePath(pathname)) return false;
  if (Number.isFinite(contentLength) && contentLength > MAX_CACHE_BYTES) return false;
  return true;
}

async function proxyRequest(req, res, url) {
  runtimeStats.proxiedRequests += 1;
  const upstreamUrl = `${ORIGIN_BASE_URL}${url.pathname}${url.search}`;
  const requestHeaders = {
    'Accept': req.headers.accept || '*/*',
    'If-None-Match': req.headers['if-none-match'] || '',
    'If-Modified-Since': req.headers['if-modified-since'] || '',
    'Range': req.headers.range || ''
  };

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), ORIGIN_FETCH_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: requestHeaders,
      signal: abort.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  const headersToForward = ['content-type', 'content-length', 'etag', 'last-modified', 'cache-control', 'accept-ranges'];
  for (const key of headersToForward) {
    const value = upstream.headers.get(key);
    if (value) res.setHeader(key, value);
  }
  setCorsHeaders(res);
  res.statusCode = upstream.status;

  const contentLength = Number.parseInt(upstream.headers.get('content-length') || '', 10);
  const shouldCache = shouldAttemptCache(
    url.pathname,
    req.method || 'GET',
    upstream.status,
    contentLength,
    Boolean(req.headers.range)
  );

  if (!upstream.body) {
    res.end();
    return;
  }

  if (!shouldCache) {
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.end(buffer);
    return;
  }

  const buffer = Buffer.from(await upstream.arrayBuffer());
  if (buffer.length <= MAX_CACHE_BYTES) {
    const key = toCacheKey(url.pathname, url.search);
    const cachePaths = toCachePaths(key, upstream.headers.get('content-type') || '');
    const metadata = {
      status: upstream.status,
      contentType: upstream.headers.get('content-type') || 'application/octet-stream',
      etag: upstream.headers.get('etag') || null,
      lastModified: upstream.headers.get('last-modified') || null,
      cacheControl: upstream.headers.get('cache-control') || null,
      expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000
    };
    try {
      await writeCache(cachePaths, metadata, buffer);
      runtimeStats.cacheWrites += 1;
      console.log(`[relay-node] Cache write: ${url.pathname}`);
      await pruneCache();
    } catch (error) {
      runtimeStats.cacheWriteErrors += 1;
      console.warn(`[relay-node] Cache write failed for ${url.pathname}:`, error.message);
    }
  }

  res.end(buffer);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    setCorsHeaders(res);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (url.pathname === '/health') {
    const inventory = await getCacheInventory().catch(() => ({ files: [], totalBytes: 0 }));
    setCorsHeaders(res);
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 200;
    res.end(JSON.stringify({
      status: 'ok',
      relayName: RELAY_NAME,
      region: RELAY_REGION,
      relayId: state.relayId,
      registered: Boolean(state.relayId && state.apiKey),
      uptimeSeconds: Math.floor(process.uptime()),
      cache: {
        items: inventory.files.length,
        totalBytes: inventory.totalBytes,
        maxItems: MAX_CACHE_ITEMS,
        maxTotalBytes: MAX_CACHE_TOTAL_BYTES
      },
      stats: runtimeStats
    }));
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    setCorsHeaders(res);
    res.statusCode = 405;
    res.end('Method Not Allowed');
    return;
  }

  try {
    const key = toCacheKey(url.pathname, url.search);
    const cachePaths = toCachePaths(key, 'application/octet-stream');
    const cached = await readCache(cachePaths.metaPath, cachePaths.bodyPath).catch(() => null);

    if (cached && isCacheablePath(url.pathname) && !req.headers.range) {
      runtimeStats.cacheHits += 1;
      setCorsHeaders(res);
      res.setHeader('Content-Type', cached.meta.contentType || 'application/octet-stream');
      if (cached.meta.etag) res.setHeader('ETag', cached.meta.etag);
      if (cached.meta.lastModified) res.setHeader('Last-Modified', cached.meta.lastModified);
      if (cached.meta.cacheControl) res.setHeader('Cache-Control', cached.meta.cacheControl);
      res.setHeader('Content-Length', String(cached.size));
      res.statusCode = Number(cached.meta.status || 200);
      const buffer = await readFile(cachePaths.bodyPath);
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(buffer);
      }
      return;
    }

    runtimeStats.cacheMisses += 1;
    await proxyRequest(req, res, url);
  } catch (error) {
    runtimeStats.proxiedErrors += 1;
    setCorsHeaders(res);
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Relay proxy failure', details: error.message }));
  }
});

function shutdown(signal) {
  console.log(`[relay-node] Received ${signal}, shutting down...`);
  server.close(() => {
    console.log('[relay-node] HTTP server closed.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

async function main() {
  await ensureDirs();
  await loadState();
  await pruneCache().catch((error) => {
    console.warn('[relay-node] Initial cache prune failed:', error.message);
  });

  if (STARTUP_DELAY_MS > 0) {
    await delay(STARTUP_DELAY_MS);
  }

  try {
    await registerRelayIfNeeded();
    await sendHeartbeat();
  } catch (error) {
    console.error('[relay-node] Startup registration/heartbeat failed:', error.message);
  }

  setInterval(async () => {
    try {
      await registerRelayIfNeeded();
      await sendHeartbeat();
    } catch (error) {
      console.warn('[relay-node] Periodic relay sync failed:', error.message);
    }
  }, HEARTBEAT_INTERVAL_MS).unref();

  setInterval(async () => {
    try {
      await pruneCache();
    } catch (error) {
      console.warn('[relay-node] Cache prune failed:', error.message);
    }
  }, CACHE_CLEAN_INTERVAL_MS).unref();

  server.listen(PORT, HOST, () => {
    console.log(`[relay-node] Listening on http://${HOST}:${PORT}`);
    console.log(`[relay-node] Origin: ${ORIGIN_BASE_URL}`);
    console.log(`[relay-node] Public URL: ${PUBLIC_URL}`);
    console.log(`[relay-node] Cache prefixes: ${CACHE_PATH_PREFIXES.join(', ')}`);
    console.log(`[relay-node] Cache budgets: items<=${MAX_CACHE_ITEMS} totalBytes<=${MAX_CACHE_TOTAL_BYTES}`);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((error) => {
  console.error('[relay-node] Fatal error:', error);
  process.exit(1);
});
