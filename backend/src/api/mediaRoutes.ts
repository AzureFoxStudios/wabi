import type { IncomingMessage, ServerResponse } from 'http';

function boolFromEnv(value: string | undefined, fallback: boolean = false): boolean {
	if (value == null) return fallback;
	return value === 'true' || value === '1';
}

function numberFromEnv(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

interface GatewayHeartbeatState {
	lastSeenAt: number;
	version?: string;
	region?: string;
	activeStreams?: number;
}

const gatewayHeartbeat: GatewayHeartbeatState = {
	lastSeenAt: 0
};

function isGatewayAuthorized(req: IncomingMessage): boolean {
	const configuredKey = process.env.MEDIA_GATEWAY_KEY;
	if (!configuredKey) return false;
	const provided = req.headers['x-media-gateway-key'];
	return typeof provided === 'string' && provided === configuredKey;
}


// GET /api/media/runtime
// Provides server runtime hints for media quality transport paths.
export async function handleGetMediaRuntime(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const srtGatewayEnabled = boolFromEnv(process.env.MEDIA_SRT_GATEWAY_ENABLED, false);
		const localEnhancedEnabled = boolFromEnv(process.env.MEDIA_LOCAL_ENHANCED_ENABLED, true);

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			media: {
				localEnhancedEnabled,
				srtGatewayEnabled,
				srtGatewayUrl: process.env.MEDIA_SRT_GATEWAY_URL || null,
				opus: {
					audioBitrateWeb: numberFromEnv(process.env.MEDIA_OPUS_AUDIO_WEB_BITRATE, 64000),
					audioBitrateLocal: numberFromEnv(process.env.MEDIA_OPUS_AUDIO_LOCAL_BITRATE, 96000)
				},
				gateway: {
					configured: Boolean(process.env.MEDIA_SRT_GATEWAY_URL),
					heartbeatTimeoutMs: numberFromEnv(process.env.MEDIA_GATEWAY_HEARTBEAT_TIMEOUT_MS, 45_000),
					healthy: gatewayHeartbeat.lastSeenAt > 0 && Date.now() - gatewayHeartbeat.lastSeenAt < numberFromEnv(process.env.MEDIA_GATEWAY_HEARTBEAT_TIMEOUT_MS, 45_000),
					lastSeenAt: gatewayHeartbeat.lastSeenAt || null,
					activeStreams: gatewayHeartbeat.activeStreams ?? 0,
					version: gatewayHeartbeat.version || null,
					region: gatewayHeartbeat.region || null
				}
			},
			notes: {
				srtDirectBrowserSupported: false,
				message: 'SRT is expected to run through a server-side media gateway, not directly from browser WebRTC peers.'
			}
		}));
	} catch (error) {
		console.error('[MediaRuntime] Failed to return media runtime config:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to read media runtime configuration' }));
	}
}


// POST /api/media/gateway-heartbeat
// Optional SRT gateway can report health/stream load to backend.
export async function handleMediaGatewayHeartbeat(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (!isGatewayAuthorized(req)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Unauthorized gateway heartbeat' }));
		return;
	}

	let body = '';
	await new Promise<void>((resolve, reject) => {
		req.on('data', chunk => {
			body += chunk.toString();
		});
		req.on('end', () => resolve());
		req.on('error', reject);
	});

	let payload: Record<string, unknown> = {};
	if (body) {
		try {
			payload = JSON.parse(body);
		} catch {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid JSON in gateway heartbeat' }));
			return;
		}
	}

	gatewayHeartbeat.lastSeenAt = Date.now();
	gatewayHeartbeat.version = typeof payload.version === 'string' ? payload.version : undefined;
	gatewayHeartbeat.region = typeof payload.region === 'string' ? payload.region : undefined;
	gatewayHeartbeat.activeStreams = typeof payload.activeStreams === 'number' ? payload.activeStreams : 0;

	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ ok: true }));
}
