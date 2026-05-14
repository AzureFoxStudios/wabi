#!/usr/bin/env node

/**
 * Relay Phase 1 validation helper.
 *
 * Required:
 *   WABI_ORIGIN_URL
 *
 * Optional:
 *   WABI_ADMIN_TOKEN              (required for admin checks)
 *   RELAY_EXPECTED_PUBLIC_URL     (checks relay appears in active list)
 */

const origin = (process.env.WABI_ORIGIN_URL || '').replace(/\/+$/, '');
const adminToken = process.env.WABI_ADMIN_TOKEN || '';
const expectedRelayUrl = process.env.RELAY_EXPECTED_PUBLIC_URL || '';

if (!origin) {
  console.error('Missing WABI_ORIGIN_URL');
  process.exit(1);
}

async function getJson(url, options = {}) {
  const res = await fetch(url, options);
  const body = await res.text();
  let json = null;
  try {
    json = body ? JSON.parse(body) : null;
  } catch {
    json = { raw: body };
  }
  return { ok: res.ok, status: res.status, json };
}

function authHeaders() {
  if (!adminToken) return {};
  return { Authorization: `Bearer ${adminToken}` };
}

function pass(msg) {
  console.log(`[PASS] ${msg}`);
}

function fail(msg) {
  console.error(`[FAIL] ${msg}`);
}

async function main() {
  let failed = false;

  const relays = await getJson(`${origin}/api/relays`);
  if (!relays.ok) {
    fail(`/api/relays returned ${relays.status}`);
    failed = true;
  } else {
    const count = Array.isArray(relays.json?.relays) ? relays.json.relays.length : 0;
    pass(`/api/relays reachable (${count} active relay entries)`);
  }

  if (expectedRelayUrl && relays.ok) {
    const found = (relays.json?.relays || []).some((r) => r.url === expectedRelayUrl);
    if (!found) {
      fail(`Expected relay URL not found in active list: ${expectedRelayUrl}`);
      failed = true;
    } else {
      pass(`Expected relay URL is active: ${expectedRelayUrl}`);
    }
  }

  if (!adminToken) {
    console.log('[INFO] Skipping admin endpoint checks (set WABI_ADMIN_TOKEN to enable).');
  } else {
    const adminRelays = await getJson(`${origin}/api/relays/admin`, {
      headers: authHeaders()
    });
    if (!adminRelays.ok) {
      fail(`/api/relays/admin returned ${adminRelays.status}`);
      failed = true;
    } else {
      const total = Array.isArray(adminRelays.json?.relays) ? adminRelays.json.relays.length : 0;
      const pending = (adminRelays.json?.relays || []).filter((r) => r.approved === 0 || r.status === 'pending').length;
      pass(`/api/relays/admin reachable (${total} total, ${pending} pending)`);
    }
  }

  if (failed) {
    process.exit(1);
  }

  console.log('[DONE] Relay Phase 1 checks passed.');
}

main().catch((error) => {
  console.error('[FAIL] Relay check script error:', error);
  process.exit(1);
});
