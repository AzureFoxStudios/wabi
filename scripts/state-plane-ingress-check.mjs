#!/usr/bin/env node

import { createHmac, randomBytes } from 'crypto';

const originRaw = (process.env.WABI_ORIGIN_URL || 'http://localhost:8080').trim();
const origin = originRaw.replace(/\/+$/, '');
const path = (process.env.WABI_STATE_REDUCER_PATH || '/api/internal/state-plane/reducer').trim();
const authToken = (process.env.WABI_AUTH_TOKEN || '').trim();
const shadowToken = (process.env.WABI_SHADOW_TOKEN || process.env.STATE_SHADOW_TOKEN || '').trim();
const signingSecret = (process.env.WABI_SHADOW_SIGNING_SECRET || process.env.STATE_SHADOW_SIGNING_SECRET || '').trim();
const signingKeyId = (process.env.WABI_SHADOW_SIGNING_KEY_ID || process.env.STATE_SHADOW_SIGNING_KEY_ID || '').trim();

function now() {
	return Date.now();
}

function buildEvent() {
	return {
		eventId: `check_${now()}_${randomBytes(6).toString('hex')}`,
		timestamp: now(),
		entity: 'system',
		operation: 'ingress_check',
		payload: {
			source: 'scripts/state-plane-ingress-check.mjs',
			at: now()
		}
	};
}

function buildHeaders(body) {
	const headers = {
		'Content-Type': 'application/json'
	};
	if (shadowToken) {
		headers.Authorization = `Bearer ${shadowToken}`;
	}
	if (signingSecret) {
		const timestamp = now().toString();
		const nonce = randomBytes(16).toString('hex');
		const signature = createHmac('sha256', signingSecret)
			.update(`${timestamp}.${nonce}.${body}`)
			.digest('hex');
		headers['X-Wabi-State-Timestamp'] = timestamp;
		headers['X-Wabi-State-Nonce'] = nonce;
		headers['X-Wabi-State-Signature'] = `sha256=${signature}`;
		headers['X-Wabi-State-Signature-Alg'] = 'hmac-sha256';
		if (signingKeyId) {
			headers['X-Wabi-State-Key-Id'] = signingKeyId;
		}
	}
	return headers;
}

async function postCheckEvent() {
	const event = buildEvent();
	const body = JSON.stringify(event);
	const headers = buildHeaders(body);
	const response = await fetch(`${origin}${path}`, {
		method: 'POST',
		headers,
		body
	});
	const text = await response.text();
	let payload = null;
	try {
		payload = JSON.parse(text);
	} catch {
		payload = { raw: text };
	}

	console.log('[state-plane-ingress-check] Reducer ingress response');
	console.log(`  url=${origin}${path}`);
	console.log(`  status=${response.status}`);
	console.log(`  eventId=${event.eventId}`);
	console.log(`  signed=${Boolean(signingSecret)}`);
	console.log(`  bearer=${Boolean(shadowToken)}`);
	console.log(`  body=${JSON.stringify(payload)}`);

	if (!response.ok) {
		process.exit(1);
	}
}

async function fetchAdminRuntime() {
	if (!authToken) return;
	const response = await fetch(`${origin}/api/admin/state-plane`, {
		method: 'GET',
		headers: {
			Authorization: `Bearer ${authToken}`
		}
	});
	if (!response.ok) {
		const body = await response.text().catch(() => '');
		console.warn(`[state-plane-ingress-check] Failed to read admin runtime: HTTP ${response.status}`);
		if (body) {
			console.warn(body);
		}
		return;
	}

	const payload = await response.json();
	const ingress = payload?.runtime?.reducerIngress || {};
	console.log('[state-plane-ingress-check] Reducer ingress runtime');
	console.log(`  enabled=${Boolean(ingress.enabled)} path=${ingress.path || ''}`);
	console.log(`  accepted=${Number(ingress.accepted || 0)} duplicates=${Number(ingress.duplicates || 0)} rejected=${Number(ingress.rejected || 0)} rejectedAuth=${Number(ingress.rejectedAuth || 0)} rejectedSignature=${Number(ingress.rejectedSignature || 0)} rejectedReplay=${Number(ingress.rejectedReplay || 0)} rejectedParse=${Number(ingress.rejectedParse || 0)} errors=${Number(ingress.errors || 0)}`);
}

async function main() {
	await postCheckEvent();
	await fetchAdminRuntime();
}

main().catch((error) => {
	console.error('[state-plane-ingress-check] Unhandled error:', error);
	process.exit(2);
});
