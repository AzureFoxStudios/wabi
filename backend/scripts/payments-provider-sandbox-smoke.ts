import crypto from 'crypto';
import http from 'http';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

type IntentState = {
	providerIntentId: string;
	status: string;
	amountMinor: number;
	currency: string;
	expiresAt: number;
};

type JsonRecord = Record<string, unknown>;

function safeParseJson(raw: string): JsonRecord {
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as JsonRecord;
		return {};
	} catch {
		return {};
	}
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

function createMockAdapterServer() {
	const intents = new Map<string, IntentState>();
	let requestCount = 0;

	const server = http.createServer(async (req, res) => {
		requestCount += 1;
		if (req.method !== 'POST') {
			res.writeHead(405, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'method_not_allowed' }));
			return;
		}

		const body = safeParseJson(await readBody(req));
		if (req.url === '/v1/intents/create') {
			const providerIntentId = String(body.providerIntentId || '').trim();
			if (!providerIntentId) {
				res.writeHead(400, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ error: 'providerIntentId required' }));
				return;
			}

			const amountMinor = Math.max(0, Math.floor(Number(body.amountMinor || 0)));
			const currency = String(body.currency || 'THB').toUpperCase();
			const expiresAt = Date.now() + 15 * 60 * 1000;
			intents.set(providerIntentId, {
				providerIntentId,
				status: 'pending',
				amountMinor,
				currency,
				expiresAt
			});

			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(
				JSON.stringify({
					providerIntentId,
					status: 'pending',
					presentation: {
						mode: 'payment_link',
						url: `https://mock-payments.local/checkout/${encodeURIComponent(providerIntentId)}`,
						expiresAt
					},
					expiresAt,
					metadata: {
						adapter: 'mock',
						created: true
					}
				})
			);
			return;
		}

		if (req.url === '/v1/intents/status') {
			const providerIntentId = String(body.providerIntentId || '').trim();
			const intent = intents.get(providerIntentId);
			if (!intent) {
				res.writeHead(404, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ error: 'intent_not_found' }));
				return;
			}
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(
				JSON.stringify({
					providerIntentId,
					status: intent.status,
					expiresAt: intent.expiresAt,
					metadata: {
						adapter: 'mock',
						requestCount
					}
				})
			);
			return;
		}

		if (req.url === '/v1/intents/refund') {
			const providerIntentId = String(body.providerIntentId || '').trim();
			const intent = intents.get(providerIntentId);
			if (!intent) {
				res.writeHead(404, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ error: 'intent_not_found' }));
				return;
			}
			intent.status = 'refunded';
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(
				JSON.stringify({
					providerIntentId,
					status: 'refunded',
					providerRefundId: `mock_ref_${providerIntentId.slice(-8)}`,
					metadata: { adapter: 'mock', refunded: true }
				})
			);
			return;
		}

		res.writeHead(404, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: 'not_found' }));
	});

	return {
		server,
		intents,
		getRequestCount: () => requestCount
	};
}

function signWebhook(rawBody: string, secret: string): string {
	return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const mock = createMockAdapterServer();
let closeServer: (() => Promise<void>) | null = null;

try {
	await new Promise<void>((resolve, reject) => {
		mock.server.listen(0, '127.0.0.1', () => resolve());
		mock.server.once('error', reject);
	});
	closeServer = async () =>
		new Promise<void>((resolve) => {
			mock.server.close(() => resolve());
		});

	const address = mock.server.address();
	assert(address && typeof address === 'object', 'mock adapter failed to bind');
	const adapterBaseUrl = `http://127.0.0.1:${address.port}`;

	process.env.TH_PAYMENTS_ADAPTER_BASE_URL = adapterBaseUrl;
	process.env.TH_PAYMENTS_ADAPTER_TOKEN = 'sandbox-token';
	process.env.TH_PAYMENTS_WEBHOOK_SECRET = 'sandbox-webhook-secret';
	process.env.TH_PAYMENTS_PROMPTPAY_PROXY_ID = '0812345678';

	const pluginModulePath = path.resolve(__dirname, '..', '..', 'plugins', 'th-payments', 'backend', 'index.mjs');
	const pluginMod = await import(pathToFileURL(pluginModulePath).href);
	const plugin = pluginMod.default;

	const storage = new Map<string, unknown>();
	const ctx = {
		storage: {
			get: async (key: string) => storage.get(key),
			set: async (key: string, value: unknown) => {
				storage.set(key, value);
			},
			delete: async (key: string) => {
				storage.delete(key);
			},
			list: async () => [...storage.keys()]
		},
		logger: {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {}
		}
	};

	if (plugin.onLoad) {
		await plugin.onLoad(ctx);
	}

	const capabilities = await plugin.payment.getCapabilities(ctx);
	assert(capabilities.methods.some((method: any) => method.id === 'psp_checkout'), 'psp_checkout method missing');

	const createInput = {
		intentId: 'wabi_intent_sandbox_001',
		workspaceId: 'default-workspace',
		channelId: 'general',
		createdByUserId: 1,
		amountMinor: 12345,
		currency: 'THB',
		countryCode: 'TH',
		methodId: 'psp_checkout',
		description: 'Sandbox test',
		customerRef: 'acct_demo_001',
		idempotencyKey: 'sandbox-intent-idem-001',
		metadata: { flow: 'sandbox' }
	};

	const created = await plugin.payment.createIntent(ctx, createInput);
	assert(created.providerIntentId, 'createIntent missing providerIntentId');
	assert(created.status === 'pending', `expected pending status, got ${created.status}`);
	assert(created.presentation?.mode === 'payment_link', 'expected payment_link presentation');

	const reused = await plugin.payment.createIntent(ctx, createInput);
	assert(
		reused.providerIntentId === created.providerIntentId,
		'idempotent createIntent returned different providerIntentId'
	);

	const knownIntent = mock.intents.get(created.providerIntentId);
	assert(knownIntent, 'mock adapter did not persist created intent');
	knownIntent.status = 'succeeded';

	const polled = await plugin.payment.getIntentStatus(ctx, {
		intentId: createInput.intentId,
		providerIntentId: created.providerIntentId
	});
	assert(polled.status === 'succeeded', `expected succeeded after poll, got ${polled.status}`);

	const refund = await plugin.payment.refundIntent(ctx, {
		intentId: createInput.intentId,
		providerIntentId: created.providerIntentId,
		idempotencyKey: 'sandbox-refund-idem-001',
		amountMinor: 12345
	});
	assert(refund.status === 'refunded', `expected refunded status, got ${refund.status}`);

	const webhookPayload = JSON.stringify({
		eventId: 'sandbox-webhook-evt-001',
		eventType: 'payment.status',
		providerIntentId: created.providerIntentId,
		intentId: createInput.intentId,
		status: 'succeeded',
		occurredAt: Date.now()
	});
	const webhookSignature = signWebhook(webhookPayload, process.env.TH_PAYMENTS_WEBHOOK_SECRET || '');
	const webhook1 = await plugin.payment.verifyWebhook(ctx, {
		headers: { 'x-th-payments-signature': webhookSignature },
		rawBody: webhookPayload
	});
	const webhook2 = await plugin.payment.verifyWebhook(ctx, {
		headers: { 'x-th-payments-signature': webhookSignature },
		rawBody: webhookPayload
	});
	assert(webhook1.valid && webhook2.valid, 'webhook verification failed');
	assert(
		webhook1.event?.eventId === webhook2.event?.eventId,
		'webhook replay did not preserve deterministic event id'
	);

	await closeServer();
	closeServer = null;
	const outageStatus = await plugin.payment.getIntentStatus(ctx, {
		intentId: createInput.intentId,
		providerIntentId: created.providerIntentId
	});
	const outageMeta = (outageStatus.metadata || {}) as Record<string, unknown>;
	assert(typeof outageMeta.adapterError === 'string', 'outage behavior did not return adapterError metadata');

	console.log(
		JSON.stringify(
			{
				ok: true,
				createdProviderIntentId: created.providerIntentId,
				requestCount: mock.getRequestCount(),
				outageStatus: outageStatus.status,
				outageError: outageMeta.adapterError
			},
			null,
			2
		)
	);
} catch (error) {
	console.error('[payments-provider-sandbox-smoke] FAIL', error);
	process.exitCode = 1;
} finally {
	if (closeServer) {
		try {
			await closeServer();
		} catch {
			// no-op
		}
	}
}
