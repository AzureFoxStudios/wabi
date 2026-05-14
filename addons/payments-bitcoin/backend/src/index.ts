import crypto from 'crypto';
import type { BackendPlugin, PluginContext } from '@wabi/payment-types';
import { buildBitcoinUri, normalizeBitcoinAddress, resolveBitcoinDestination, toSats } from './modules/bitcoin-qr';
import { isTestModeEnabled, buildLocalTestLightningUrl, createLocalTestLightningHtml, getDefaultExpiresAt } from './modules/lightning';
import { isAdapterConfigured, fetchAdapterStatus, createAdapterIntent, normalizeStatus, normalizePresentation } from './modules/adapter-client';

const PROVIDER_NAME = 'Bitcoin';
const DEFAULT_CURRENCY = 'BTC';
const DEFAULT_EXPIRES_MS = 15 * 60 * 1000;

function randomId(prefix: string): string {
	return `${prefix}${crypto.randomBytes(10).toString('hex')}`;
}

function getWebhookSecret(): string {
	return (process.env.BTC_PAYMENTS_WEBHOOK_SECRET || 'btc-payments-dev-webhook-secret').trim();
}

function extractHeaderValue(headers: Record<string, string | string[] | undefined>, key: string): string {
	const raw = headers?.[key] ?? headers?.[key.toLowerCase()];
	if (Array.isArray(raw)) return raw[0] || '';
	if (typeof raw === 'string') return raw;
	return '';
}

function signWebhookPayload(rawBody: string): string {
	return crypto.createHmac('sha256', getWebhookSecret()).update(rawBody).digest('hex');
}

function safeJsonParse(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function toObject(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

interface IntentRecord {
	providerIntentId: string;
	wabiIntentId: string;
	idempotencyKey: string;
	amountMinor: number;
	currency: string;
	countryCode: string | null;
	status: string;
	methodId: string;
	providerManaged: boolean;
	presentation: Record<string, unknown>;
	providerMetadata: Record<string, unknown> | null;
	createdAt: number;
	updatedAt: number;
	expiresAt: number;
}

let ctxRef: PluginContext | null = null;

async function getRecordByProviderIntentId(ctx: PluginContext, providerIntentId: string): Promise<IntentRecord | null> {
	if (!providerIntentId) return null;
	const data = await ctx.storage.get(`payments-bitcoin:intent:${providerIntentId}`);
	return data ? (JSON.parse(data) as IntentRecord) : null;
}

async function getRecordByWabiIntentId(ctx: PluginContext, wabiIntentId: string): Promise<IntentRecord | null> {
	if (!wabiIntentId) return null;
	const providerIntentId = await ctx.storage.get(`payments-bitcoin:wabi-intent:${wabiIntentId}`);
	if (!providerIntentId) return null;
	return getRecordByProviderIntentId(ctx, providerIntentId);
}

async function saveIntentRecord(ctx: PluginContext, record: IntentRecord): Promise<void> {
	await ctx.storage.set(`payments-bitcoin:intent:${record.providerIntentId}`, JSON.stringify(record));
	if (record.wabiIntentId) {
		await ctx.storage.set(`payments-bitcoin:wabi-intent:${record.wabiIntentId}`, record.providerIntentId);
	}
	if (record.idempotencyKey) {
		await ctx.storage.set(`payments-bitcoin:idem:${record.idempotencyKey}`, record.providerIntentId);
	}
}

const plugin: BackendPlugin = {
	name: 'payments-bitcoin',

	async onLoad(ctx) {
		ctxRef = ctx;
		ctx.logger.info('payments-bitcoin plugin loaded', {
			provider: PROVIDER_NAME,
			donationAddressConfigured: Boolean(normalizeBitcoinAddress(process.env.BTC_PAYMENTS_DONATION_ADDRESS || '')),
			adapterConfigured: isAdapterConfigured(),
			testModeEnabled: isTestModeEnabled()
		});
	},

	payment: {
		async getCapabilities() {
			const methods = [
				{
					id: 'bitcoin_qr',
					label: 'Bitcoin QR',
					checkoutModes: ['qr', 'app_switch'],
					currencies: [DEFAULT_CURRENCY],
					enabledByDefault: true,
					estimatedSharePercent: 100,
					notes: normalizeBitcoinAddress(process.env.BTC_PAYMENTS_DONATION_ADDRESS || '')
						? "Personal requests use the sender's saved Bitcoin address. Server donations use the server Bitcoin address."
						: "Personal requests use the sender's saved Bitcoin address. Server donations need BTC_PAYMENTS_DONATION_ADDRESS."
				}
			];

			if (isAdapterConfigured() || isTestModeEnabled()) {
				methods.push({
					id: 'lightning_checkout',
					label: 'Lightning',
					checkoutModes: ['payment_link', 'redirect', 'app_switch'],
					currencies: [DEFAULT_CURRENCY],
					enabledByDefault: true,
					estimatedSharePercent: 15,
					notes: isTestModeEnabled() && !isAdapterConfigured()
						? 'Local test mode only. This simulates Lightning settlement without moving money.'
						: 'Lightning checkout through a configured non-custodial adapter.'
				});
			}

			return {
				pluginId: 'payments-bitcoin',
				providerName: PROVIDER_NAME,
				countries: [],
				currencies: [DEFAULT_CURRENCY],
				methods,
				nonCustodialOnly: true,
				webhookSignatureRequired: true,
				supportsRefunds: false,
				supportsDisputes: false,
				notes:
					isAdapterConfigured() || isTestModeEnabled()
						? 'Bitcoin QR uses saved addresses for personal requests. Lightning appears only when adapter or local test mode is enabled.'
						: 'Bitcoin QR uses saved addresses for personal requests. Configure BTC_PAYMENTS_ADAPTER_BASE_URL to enable Lightning.'
			};
		},

		async createIntent(ctx: PluginContext, input: {
			intentId?: string;
			idempotencyKey?: string;
			amountMinor?: number;
			methodId?: string;
			customerRef?: string;
			description?: string;
			metadata?: Record<string, unknown>;
			workspaceId?: string;
			channelId?: string;
		}) {
			ctxRef = ctx;

			const idempotencyKey = String(input.idempotencyKey || '').trim();
			if (idempotencyKey) {
				const existingProviderIntentId = await ctx.storage.get(`payments-bitcoin:idem:${idempotencyKey}`);
				if (existingProviderIntentId) {
					const existing = await getRecordByProviderIntentId(ctx, existingProviderIntentId);
					if (existing) {
						return {
							providerIntentId: existing.providerIntentId,
							status: existing.status,
							checkoutMode: existing.presentation.mode as string,
							presentation: existing.presentation,
							expiresAt: existing.expiresAt,
							metadata: {
								reused: true,
								providerIntentId: existing.providerIntentId
							}
						};
					}
				}
			}

			const providerIntentId = randomId('btcpi_');
			const now = Date.now();
			const expiresAt = now + DEFAULT_EXPIRES_MS;
			const methodId = String(input.methodId || '').trim();

			if (methodId === 'bitcoin_qr') {
				const destination = resolveBitcoinDestination(input);
				const uri = buildBitcoinUri({
					address: destination.address,
					amountMinor: input.amountMinor || 0,
					label: process.env.BTC_PAYMENTS_LABEL || 'Wabi',
					message: input.description || ''
				});
				const presentation = {
					mode: 'qr',
					qrData: uri,
					qrFormat: 'raw',
					deepLinkUrl: uri,
					expiresAt
				};
				const record: IntentRecord = {
					providerIntentId,
					wabiIntentId: String(input.intentId || ''),
					idempotencyKey,
					amountMinor: toSats(input.amountMinor || 0),
					currency: DEFAULT_CURRENCY,
					countryCode: null,
					status: 'pending',
					methodId,
					providerManaged: false,
					presentation,
					providerMetadata: {
						destinationSource: destination.source
					},
					createdAt: now,
					updatedAt: now,
					expiresAt
				};
				await saveIntentRecord(ctx, record);
				return {
					providerIntentId,
					status: 'pending',
					checkoutMode: 'qr',
					presentation,
					expiresAt,
					metadata: {
						provider: PROVIDER_NAME,
						methodId,
						providerManaged: false,
						cryptoAsset: 'BTC',
						network: 'bitcoin',
						destinationSource: destination.source
					}
				};
			}

			if (methodId !== 'lightning_checkout') {
				throw new Error(`btc_payments_unsupported_method:${methodId}`);
			}
			if (!isAdapterConfigured() && !isTestModeEnabled()) {
				throw new Error('btc_payments_adapter_not_configured');
			}

			if (!isAdapterConfigured() && isTestModeEnabled()) {
				const record: IntentRecord = {
					providerIntentId,
					wabiIntentId: String(input.intentId || ''),
					idempotencyKey,
					amountMinor: toSats(input.amountMinor || 0),
					currency: DEFAULT_CURRENCY,
					countryCode: null,
					status: 'pending',
					methodId,
					providerManaged: false,
					presentation: {
						mode: 'payment_link',
						url: buildLocalTestLightningUrl(providerIntentId),
						expiresAt
					},
					providerMetadata: {
						localTestMode: true
					},
					createdAt: now,
					updatedAt: now,
					expiresAt
				};
				await saveIntentRecord(ctx, record);
				return {
					providerIntentId,
					status: 'pending',
					checkoutMode: 'payment_link',
					presentation: record.presentation,
					expiresAt,
					metadata: {
						provider: PROVIDER_NAME,
						methodId,
						providerManaged: false,
						localTestMode: true,
						cryptoAsset: 'BTC',
						network: 'lightning'
					}
				};
			}

			const adapterResponse = await createAdapterIntent({
				providerIntentId,
				intentId: input.intentId || '',
				workspaceId: input.workspaceId || '',
				channelId: input.channelId || '',
				amountMinor: toSats(input.amountMinor || 0),
				currency: DEFAULT_CURRENCY,
				customerRef: String(input.customerRef || '').trim() || undefined,
				description: String(input.description || '').trim() || undefined,
				metadata: input.metadata || {},
				methodId,
				idempotencyKey
			});

			const adaptedProviderIntentId = String(adapterResponse.providerIntentId || providerIntentId).trim() || providerIntentId;
			const adaptedStatus = normalizeStatus(adapterResponse.status) || 'pending';
			const adaptedPresentation = normalizePresentation(adapterResponse.presentation);
			if (!adaptedPresentation) {
				throw new Error('btc_payments_adapter_invalid_presentation');
			}

			const record: IntentRecord = {
				providerIntentId: adaptedProviderIntentId,
				wabiIntentId: String(input.intentId || ''),
				idempotencyKey,
				amountMinor: toSats(input.amountMinor || 0),
				currency: DEFAULT_CURRENCY,
				countryCode: null,
				status: adaptedStatus,
				methodId,
				providerManaged: true,
				presentation: adaptedPresentation as Record<string, unknown>,
				providerMetadata: toObject(adapterResponse.metadata),
				createdAt: now,
				updatedAt: now,
				expiresAt: Number.isFinite(Number(adapterResponse.expiresAt))
					? Math.floor(Number(adapterResponse.expiresAt))
					: expiresAt
			};

			await saveIntentRecord(ctx, record);
			return {
				providerIntentId: adaptedProviderIntentId,
				status: adaptedStatus,
				checkoutMode: adaptedPresentation.mode,
				presentation: adaptedPresentation as Record<string, unknown>,
				expiresAt: record.expiresAt,
				metadata: {
					provider: PROVIDER_NAME,
					methodId,
					providerManaged: true,
					cryptoAsset: 'BTC',
					network: 'lightning',
					...(record.providerMetadata || {})
				}
			};
		},

		async verifyWebhook(ctx: PluginContext, input: {
			headers: Record<string, string | string[] | undefined>;
			rawBody: string;
		}) {
			ctxRef = ctx;
			const providedSignature = extractHeaderValue(input.headers, 'x-btc-payments-signature').trim();
			if (!providedSignature) {
				return { valid: false, reason: 'Missing x-btc-payments-signature header' };
			}
			const expectedSignature = signWebhookPayload(input.rawBody);
			if (providedSignature !== expectedSignature) {
				return { valid: false, reason: 'Webhook signature mismatch' };
			}

			const parsed = safeJsonParse(input.rawBody);
			if (!parsed || typeof parsed !== 'object') {
				return { valid: false, reason: 'Invalid webhook JSON payload' };
			}

			const record = parsed as Record<string, unknown>;
			const eventId = String(record.eventId || randomId('btcevt_')).trim();
			const providerIntentId = String(record.providerIntentId || '').trim();
			const intentId = String(record.intentId || '').trim();
			const status = normalizeStatus(String(record.status));
			const eventType = String(record.eventType || 'payment.status').trim();
			const occurredAt = Number(record.occurredAt || Date.now());

			if (!providerIntentId && !intentId) {
				return { valid: false, reason: 'Webhook must contain providerIntentId or intentId' };
			}
			if (!status) {
				return { valid: false, reason: 'Webhook status is invalid or missing' };
			}

			const existingRecord =
				(providerIntentId ? await getRecordByProviderIntentId(ctx, providerIntentId) : null) ||
				(intentId ? await getRecordByWabiIntentId(ctx, intentId) : null);
			if (existingRecord) {
				existingRecord.status = status;
				existingRecord.updatedAt = Date.now();
				await saveIntentRecord(ctx, existingRecord);
			}

			return {
				valid: true,
				event: {
					eventId,
					eventType,
					intentId: intentId || (existingRecord?.wabiIntentId || undefined),
					providerIntentId: providerIntentId || (existingRecord?.providerIntentId || undefined),
					status,
					amountMinor: existingRecord?.amountMinor,
					currency: existingRecord?.currency,
					occurredAt: Number.isFinite(occurredAt) ? Math.floor(occurredAt) : Date.now(),
					raw: parsed
				}
			};
		},

		async getIntentStatus(ctx: PluginContext, input: {
			providerIntentId?: string;
			intentId?: string;
		}) {
			ctxRef = ctx;
			const record =
				(input.providerIntentId ? await getRecordByProviderIntentId(ctx, input.providerIntentId) : null) ||
				(input.intentId ? await getRecordByWabiIntentId(ctx, input.intentId) : null);

			if (!record) {
				return {
					status: 'failed',
					metadata: { reason: 'intent_not_found' }
				};
			}

			if (record.status === 'pending' && Number(record.expiresAt || 0) > 0 && Date.now() > record.expiresAt) {
				record.status = 'expired';
				record.updatedAt = Date.now();
				await saveIntentRecord(ctx, record);
			}

			if (!record.providerManaged) {
				return {
					status: record.status,
					providerIntentId: record.providerIntentId,
					amountMinor: record.amountMinor,
					currency: record.currency,
					metadata: {
						methodId: record.methodId,
						expiresAt: record.expiresAt,
						localTestMode: record.providerMetadata?.localTestMode === true
					}
				};
			}

			try {
				const statusPayload = await fetchAdapterStatus(record.providerIntentId);
				const nextStatus = normalizeStatus(statusPayload.status);
				if (nextStatus) {
					record.status = nextStatus;
				}
				const nextPresentation = normalizePresentation(statusPayload.presentation);
				if (nextPresentation) {
					record.presentation = nextPresentation as Record<string, unknown>;
				}
				if (Number.isFinite(Number(statusPayload.expiresAt))) {
					record.expiresAt = Math.floor(Number(statusPayload.expiresAt));
				}
				record.providerMetadata = toObject(statusPayload.metadata) || record.providerMetadata || null;
				record.updatedAt = Date.now();
				await saveIntentRecord(ctx, record);
			} catch (error) {
				return {
					status: record.status || 'pending',
					providerIntentId: record.providerIntentId,
					amountMinor: record.amountMinor,
					currency: record.currency,
					metadata: {
						methodId: record.methodId,
						expiresAt: record.expiresAt,
						adapterError: error instanceof Error ? error.message : 'adapter_status_error'
					}
				};
			}

			return {
				status: record.status,
				providerIntentId: record.providerIntentId,
				amountMinor: record.amountMinor,
				currency: record.currency,
				metadata: {
					methodId: record.methodId,
					expiresAt: record.expiresAt
				}
			};
		},

		async refundIntent() {
			return {
				status: 'failed',
				metadata: {
					reason: 'refunds_not_supported'
				}
			};
		}
	},

	routes: [
		{
			method: 'get',
			path: '/lightning-test',
			handler: async (req, res) => {
				const ctx = ctxRef;
				if (!ctx) {
					res.status(503).json({ success: false, error: 'Plugin context is not ready' });
					return;
				}
				const providerIntentId = String(req.query?.providerIntentId || '').trim();
				if (!providerIntentId) {
					res.status(400).json({ success: false, error: 'providerIntentId is required' });
					return;
				}
				const record = await getRecordByProviderIntentId(ctx, providerIntentId);
				if (!record) {
					res.status(404).json({ success: false, error: 'Payment intent not found' });
					return;
				}
				res.setHeader('Content-Type', 'text/html; charset=utf-8').send(createLocalTestLightningHtml({
					providerIntentId: record.providerIntentId,
					amountMinor: record.amountMinor,
					status: record.status
				}));
			}
		},
		{
			method: 'post',
			path: '/lightning-test',
			handler: async (req, res) => {
				const ctx = ctxRef;
				if (!ctx) {
					res.status(503).json({ success: false, error: 'Plugin context is not ready' });
					return;
				}
				const body = await req.json().catch(() => ({}));
				const providerIntentId = String(body.providerIntentId || '').trim();
				const action = String(body.action || '').trim().toLowerCase();
				const allowedStatuses = new Set(['pending', 'succeeded', 'failed', 'canceled', 'expired']);
				if (!providerIntentId || !allowedStatuses.has(action)) {
					res.status(400).json({ success: false, error: 'providerIntentId and a valid action are required' });
					return;
				}
				const record = await getRecordByProviderIntentId(ctx, providerIntentId);
				if (!record) {
					res.status(404).json({ success: false, error: 'Payment intent not found' });
					return;
				}
				record.status = action;
				record.updatedAt = Date.now();
				await saveIntentRecord(ctx, record);
				res.json({ success: true, status: record.status });
			}
		}
	]
};

export default plugin;