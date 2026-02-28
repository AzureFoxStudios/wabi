import { IncomingMessage, ServerResponse } from 'http';
import { relayRepository } from '../db/repositories/relayRepository.js';
import { getAuthenticatedUserIdFromRequest } from '../auth/requestAuth.js';

interface RateBucket {
	count: number;
	windowStartMs: number;
}

const rateBuckets = new Map<string, RateBucket>();
let lastRateCleanupMs = 0;

function getClientIp(req: IncomingMessage): string {
	const xfwd = req.headers['x-forwarded-for'];
	if (typeof xfwd === 'string' && xfwd.trim()) {
		return xfwd.split(',')[0].trim();
	}
	return req.socket.remoteAddress || 'unknown';
}

function isRateLimited(
	req: IncomingMessage,
	keyPrefix: string,
	maxRequests: number,
	windowMs: number
): boolean {
	const ip = getClientIp(req);
	const key = `${keyPrefix}:${ip}`;
	const now = Date.now();

	if (now - lastRateCleanupMs > 5 * 60_000) {
		for (const [bucketKey, bucket] of rateBuckets.entries()) {
			if (now - bucket.windowStartMs > 10 * windowMs) {
				rateBuckets.delete(bucketKey);
			}
		}
		lastRateCleanupMs = now;
	}

	const existing = rateBuckets.get(key);

	if (!existing || now - existing.windowStartMs >= windowMs) {
		rateBuckets.set(key, { count: 1, windowStartMs: now });
		return false;
	}

	existing.count += 1;
	return existing.count > maxRequests;
}

// Parse JSON body (same pattern as themeRoutes.ts)
function parseBody(req: IncomingMessage): Promise<Record<string, any>> {
	return new Promise((resolve, reject) => {
		let body = '';

		req.on('data', (chunk: any) => {
			body += chunk.toString();
		});

		req.on('end', () => {
			try {
				resolve(body ? JSON.parse(body) : {});
			} catch (error) {
				reject(new Error('Invalid JSON'));
			}
		});

		req.on('error', reject);
	});
}

// Verify relay API key from X-Relay-Id + X-Relay-Key headers
async function authenticateRelay(req: IncomingMessage): Promise<number | null> {
	const relayId = req.headers['x-relay-id'] as string;
	const apiKey = req.headers['x-relay-key'] as string;
	if (!relayId || !apiKey) return null;
	const id = parseInt(relayId, 10);
	if (isNaN(id)) return null;
	const valid = await relayRepository.verifyApiKey(id, apiKey);
	return valid ? id : null;
}

// GET /api/relays â€” Public: list active approved relays
export async function handleGetRelays(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const relays = relayRepository.getActiveRelays();
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ relays }));
	} catch (error) {
		console.error('[Relay] Get relays error:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to fetch relays' }));
	}
}

// POST /api/relay/register â€” Relay self-registers with origin
export async function handleRelayRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		if (isRateLimited(req, 'relay-register', 15, 60_000)) {
			res.writeHead(429, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Too many relay registration requests. Try again shortly.' }));
			return;
		}

		let body: any;
		try {
			body = await parseBody(req);
		} catch {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid JSON in request body' }));
			return;
		}

		const { url, name, region, latitude, longitude, bandwidth_mbps, storage_gb, syncthing_device_id } = body;

		if (!url || !name || !region) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'url, name, and region are required' }));
			return;
		}

		// Validate URL format
		let parsedUrl: URL;
		try {
			parsedUrl = new URL(url);
		} catch {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid URL format' }));
			return;
		}
		if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Relay URL must use http or https' }));
			return;
		}
		if (name.length > 120 || region.length > 64) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'name or region too long' }));
			return;
		}

		// Check for duplicate
		const existing = relayRepository.findByUrl(url);
		if (existing) {
			res.writeHead(409, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Relay with this URL already registered' }));
			return;
		}

		const { relay_id, api_key } = await relayRepository.register({
			url, name, region,
			latitude: latitude != null ? parseFloat(latitude) : undefined,
			longitude: longitude != null ? parseFloat(longitude) : undefined,
			bandwidth_mbps: bandwidth_mbps != null ? parseInt(bandwidth_mbps, 10) : undefined,
			storage_gb: storage_gb != null ? parseInt(storage_gb, 10) : undefined,
			syncthing_device_id: syncthing_device_id || undefined
		});

		console.log(`[Relay] New relay registered: ${name} (${url}) â€” ID: ${relay_id}`);

		// Return API key ONCE â€” relay must save it, never returned again
		res.writeHead(201, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			relay_id,
			api_key,
			status: 'pending',
			message: 'Relay registered. An admin must approve it before it goes active.'
		}));
	} catch (error) {
		console.error('[Relay] Register error:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to register relay' }));
	}
}

// POST /api/relay/health â€” Authenticated relay reports health
export async function handleRelayHealth(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		if (isRateLimited(req, 'relay-health', 240, 60_000)) {
			res.writeHead(429, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Too many relay health updates. Slow down heartbeat interval.' }));
			return;
		}

		const relayId = await authenticateRelay(req);
		if (!relayId) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid relay credentials' }));
			return;
		}

		let body: Record<string, any> = {};
		try {
			body = await parseBody(req);
		} catch {
			// Health ping with no body is fine
		}

		relayRepository.updateHealth(relayId, {
			bandwidth_mbps: body.bandwidth_mbps != null ? parseInt(body.bandwidth_mbps, 10) : undefined,
			storage_gb: body.storage_gb != null ? parseInt(body.storage_gb, 10) : undefined
		});

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ status: 'ok' }));
	} catch (error) {
		console.error('[Relay] Health update error:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to update health' }));
	}
}

// POST /api/relay/approve â€” Admin approves a pending relay
export async function handleRelayApprove(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const userId = getAuthenticatedUserIdFromRequest(req);
		if (!userId) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Authentication required' }));
			return;
		}

		// Check admin â€” user ID 1 is always admin, or check RELAY_ADMIN_USER_IDS env
		const adminIds = (process.env.RELAY_ADMIN_USER_IDS || '1').split(',').map(id => parseInt(id.trim(), 10));
		if (!adminIds.includes(userId)) {
			res.writeHead(403, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Admin access required' }));
			return;
		}

		let body: any;
		try {
			body = await parseBody(req);
		} catch {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid JSON in request body' }));
			return;
		}

		const { relay_id } = body;
		if (!relay_id) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'relay_id is required' }));
			return;
		}

		const relay = relayRepository.findById(relay_id);
		if (!relay) {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Relay not found' }));
			return;
		}

		relayRepository.approve(relay_id);
		console.log(`[Relay] Relay approved: ${relay.name} (${relay.url})`);

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ success: true, relay_id, status: 'active' }));
	} catch (error) {
		console.error('[Relay] Approve error:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to approve relay' }));
	}
}

// GET /api/relays/admin â€” Admin: list all relays (including pending/offline)
export async function handleGetAllRelays(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const userId = getAuthenticatedUserIdFromRequest(req);
		if (!userId) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Authentication required' }));
			return;
		}

		const adminIds = (process.env.RELAY_ADMIN_USER_IDS || '1').split(',').map(id => parseInt(id.trim(), 10));
		if (!adminIds.includes(userId)) {
			res.writeHead(403, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Admin access required' }));
			return;
		}

		const relays = relayRepository.getAllRelays();
		// Strip api_key_hash from response
		const sanitized = relays.map(({ api_key_hash, ...rest }) => rest);

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ relays: sanitized }));
	} catch (error) {
		console.error('[Relay] Admin list error:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to fetch relays' }));
	}
}

// DELETE /api/relay/:relayId Ã¢â‚¬â€ Admin delete relay
export async function handleRelayDelete(req: IncomingMessage, res: ServerResponse, relayId: number): Promise<void> {
	try {
		const userId = getAuthenticatedUserIdFromRequest(req);
		if (!userId) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Authentication required' }));
			return;
		}

		const adminIds = (process.env.RELAY_ADMIN_USER_IDS || '1').split(',').map(id => parseInt(id.trim(), 10));
		if (!adminIds.includes(userId)) {
			res.writeHead(403, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Admin access required' }));
			return;
		}

		const relay = relayRepository.findById(relayId);
		if (!relay) {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Relay not found' }));
			return;
		}

		relayRepository.delete(relayId);
		console.log(`[Relay] Relay deleted by admin: ${relay.name} (${relay.url})`);
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ success: true, relay_id: relayId, deleted: true }));
	} catch (error) {
		console.error('[Relay] Delete error:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to delete relay' }));
	}
}

