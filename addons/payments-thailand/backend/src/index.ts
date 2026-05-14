import crypto from 'crypto';
import type { BackendPlugin, PluginContext } from '@wabi/payment-types';
import {
	buildPromptPayQrPayload,
	isServerDonationIntent,
	resolvePromptPayProxyId,
	toMinorAmount
} from './modules/promptpay-qr';
import {
	createAdapterIntent,
	createAdapterRefund,
	fetchAdapterStatus,
	isAdapterConfigured
} from './modules/psp-adapter';

const PROVIDER_NAME = 'Thailand PromptPay';
const DEFAULT_PROMPTPAY_CURRENCY = 'THB';
const DEFAULT_EXPIRES_MS = 15 * 60 * 1000;

function randomId(prefix: string): string {
	return `${prefix}${crypto.randomBytes(10).toString('hex')}`;
}

function getWebhookSecret(): string {
	return (process.env.TH_PAYMENTS_WEBHOOK_SECRET || 'th-payments-dev-webhook-secret').trim();
}

function getPublicBaseUrl(): string {
	const raw =
		process.env.WABI_PUBLIC_BASE_URL ||
		process.env.PUBLIC_URL ||
		`http://127.0.0.1:${process.env.PORT || '3000'}`;
	return raw.replace(/\/+$/, '');
}

function safeJsonParse(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
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

function normalizeStatus(value: unknown): string | null {
	const normalized = String(value || '').trim().toLowerCase();
	if (
		normalized === 'draft' ||
		normalized === 'pending' ||
		normalized === 'succeeded' ||
		normalized === 'failed' ||
		normalized === 'expired' ||
		normalized === 'refunded' ||
		normalized === 'disputed' ||
		normalized === 'canceled'
	) {
		return normalized;
	}
	return null;
}

function normalizeCheckoutMode(value: unknown): string | null {
	const normalized = String(value || '').trim().toLowerCase();
	if (
		normalized === 'qr' ||
		normalized === 'payment_link' ||
		normalized === 'redirect' ||
		normalized === 'app_switch' ||
		normalized === 'tap_to_pay'
	) {
		return normalized;
	}
	return null;
}

function toObject(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function normalizePresentation(value: unknown): Record<string, unknown> | null {
	const record = toObject(value);
	if (!record) return null;
	const mode = normalizeCheckoutMode(record.mode);
	if (!mode) return null;

	if (mode === 'qr') {
		const qrData = String(record.qrData || '').trim();
		if (!qrData) return null;
		return {
			mode,
			qrData,
			qrFormat: typeof record.qrFormat === 'string' ? record.qrFormat : undefined,
			qrImageUrl: typeof record.qrImageUrl === 'string' ? record.qrImageUrl : undefined,
			deepLinkUrl: typeof record.deepLinkUrl === 'string' ? record.deepLinkUrl : undefined,
			expiresAt: Number.isFinite(Number(record.expiresAt)) ? Math.floor(Number(record.expiresAt)) : undefined
		};
	}

	if (mode === 'payment_link' || mode === 'redirect') {
		const url = String(record.url || '').trim();
		if (!url) return null;
		return {
			mode,
			url,
			expiresAt: Number.isFinite(Number(record.expiresAt)) ? Math.floor(Number(record.expiresAt)) : undefined
		};
	}

	if (mode === 'app_switch') {
		const deepLinkUrl = String(record.deepLinkUrl || '').trim();
		if (!deepLinkUrl) return null;
		return {
			mode,
			deepLinkUrl,
			fallbackUrl: typeof record.fallbackUrl === 'string' ? record.fallbackUrl : undefined,
			universalLinkUrl: typeof record.universalLinkUrl === 'string' ? record.universalLinkUrl : undefined,
			packageName: typeof record.packageName === 'string' ? record.packageName : undefined,
			expiresAt: Number.isFinite(Number(record.expiresAt)) ? Math.floor(Number(record.expiresAt)) : undefined
		};
	}

	if (mode === 'tap_to_pay') {
		const providerSessionId = String(record.providerSessionId || '').trim();
		if (!providerSessionId) return null;
		return {
			mode,
			providerSessionId,
			instructions: typeof record.instructions === 'string' ? record.instructions : undefined,
			expiresAt: Number.isFinite(Number(record.expiresAt)) ? Math.floor(Number(record.expiresAt)) : undefined
		};
	}

	return null;
}

interface IntentRecord {
	providerIntentId: string;
	wabiIntentId: string;
	idempotencyKey: string;
	amountMinor: number;
	currency: string;
	countryCode: string;
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
	const data = await ctx.storage.get(`th-payments:intent:${providerIntentId}`);
	return data ? (JSON.parse(data) as IntentRecord) : null;
}

async function getRecordByWabiIntentId(ctx: PluginContext, wabiIntentId: string): Promise<IntentRecord | null> {
	if (!wabiIntentId) return null;
	const providerIntentId = await ctx.storage.get(`th-payments:wabi-intent:${wabiIntentId}`);
	if (!providerIntentId) return null;
	return getRecordByProviderIntentId(ctx, providerIntentId);
}

async function saveIntentRecord(ctx: PluginContext, record: IntentRecord): Promise<void> {
	await ctx.storage.set(`th-payments:intent:${record.providerIntentId}`, JSON.stringify(record));
	if (record.wabiIntentId) {
		await ctx.storage.set(`th-payments:wabi-intent:${record.wabiIntentId}`, record.providerIntentId);
	}
	if (record.idempotencyKey) {
		await ctx.storage.set(`th-payments:idem:${record.idempotencyKey}`, record.providerIntentId);
	}
}

const plugin: BackendPlugin = {
	name: 'payments-thailand',

	async onLoad(ctx) {
		ctxRef = ctx;
		ctx.logger.info('payments-thailand plugin loaded', {
			provider: PROVIDER_NAME,
			promptPayConfigured: Boolean(process.env.TH_PAYMENTS_PROMPTPAY_PROXY_ID),
			adapterConfigured: isAdapterConfigured()
		});
	},

	payment: {
		async getCapabilities() {
			const methods = [];
			methods.push({
				id: 'promptpay_qr',
				label: 'PromptPay QR',
				checkoutModes: ['qr', 'app_switch'],
				countries: ['TH'],
				currencies: ['THB'],
				enabledByDefault: true,
				estimatedSharePercent: 80,
				notes: process.env.TH_PAYMENTS_PROMPTPAY_PROXY_ID
					? "Personal requests use the sender's saved PromptPay number. Server donations use the server PromptPay destination."
					: "Personal requests use the sender's saved PromptPay number. Server donation QR needs TH_PAYMENTS_PROMPTPAY_PROXY_ID."
			});

			if (isAdapterConfigured()) {
				methods.push({
					id: 'psp_checkout',
					label: 'Contracted PSP Checkout',
					checkoutModes: ['payment_link', 'redirect', 'app_switch'],
					countries: ['TH'],
					currencies: ['THB'],
					enabledByDefault: true,
					estimatedSharePercent: 20,
					notes: 'Hosted checkout from contracted processor adapter.'
				});
			}

			return {
				pluginId: 'payments-thailand',
				providerName: PROVIDER_NAME,
				countries: ['TH'],
				currencies: ['THB'],
				methods,
				nonCustodialOnly: true,
				webhookSignatureRequired: true,
				supportsRefunds: true,
				supportsDisputes: true,
				notes:
					'PromptPay QR uses user-saved PromptPay numbers for personal requests and the server PromptPay number for server donations. Configure TH_PAYMENTS_ADAPTER_BASE_URL for contracted PSP checkout/refunds.'
			};
		},

		async createIntent(ctx: PluginContext, input: {
			intentId?: string;
			idempotencyKey?: string;
			amountMinor?: number;
			methodId?: string;
			currency?: string;
			countryCode?: string;
			customerRef?: string;
			description?: string;
			metadata?: Record<string, unknown>;
			workspaceId?: string;
			channelId?: string;
		}) {
			ctxRef = ctx;

			const idempotencyKey = String(input.idempotencyKey || '').trim();
			if (idempotencyKey) {
				const existingProviderIntentId = await ctx.storage.get(`th-payments:idem:${idempotencyKey}`);
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

			const providerIntentId = randomId('thpi_');
			const now = Date.now();
			const expiresAt = now + DEFAULT_EXPIRES_MS;
			const methodId = String(input.methodId || '').trim();
			let presentation: Record<string, unknown>;
			let checkoutMode: string;
			let status: string;
			let providerManaged = false;
			let providerMetadata: Record<string, unknown> | null = null;

			if (methodId === 'promptpay_qr') {
				const promptPayTarget = resolvePromptPayProxyId(input);
				const qrData = buildPromptPayQrPayload({
					proxyId: promptPayTarget.proxyId,
					amountMinor: input.amountMinor || 0,
					intentId: input.intentId || providerIntentId
				});
				checkoutMode = 'qr';
				presentation = {
					mode: 'qr',
					qrData,
					qrFormat: 'emvco',
					deepLinkUrl: `promptpay://pay?amount=${(toMinorAmount(input.amountMinor || 0) / 100).toFixed(2)}`,
					expiresAt
				};
				providerMetadata = {
					promptPayTargetSource: promptPayTarget.source
				};
				status = 'pending';
			} else if (methodId === 'psp_checkout') {
				const adapterResponse = await createAdapterIntent({
					providerIntentId,
					intentId: input.intentId || '',
					workspaceId: input.workspaceId || '',
					channelId: input.channelId || '',
					amountMinor: toMinorAmount(input.amountMinor),
					currency: String(input.currency || DEFAULT_PROMPTPAY_CURRENCY).toUpperCase(),
					countryCode: String(input.countryCode || 'TH').toUpperCase(),
					customerRef: String(input.customerRef || '').trim() || undefined,
					description: String(input.description || '').trim() || undefined,
					metadata: input.metadata || {},
					idempotencyKey
				});

				const adaptedProviderIntentId = String(adapterResponse.providerIntentId || providerIntentId).trim();
				const adaptedStatus = normalizeStatus(adapterResponse.status) || 'pending';
				const adaptedPresentation = normalizePresentation(adapterResponse.presentation);
				if (!adaptedPresentation) {
					throw new Error('th_payments_adapter_invalid_presentation');
				}

				providerManaged = true;
				status = adaptedStatus;
				checkoutMode = adaptedPresentation.mode as string;
				presentation = adaptedPresentation;
				providerMetadata = toObject(adapterResponse.metadata);

				if (adaptedProviderIntentId && adaptedProviderIntentId !== providerIntentId) {
					await ctx.storage.set(`th-payments:provider-map:${providerIntentId}`, adaptedProviderIntentId);
				}
			} else {
				throw new Error(`th_payments_unsupported_method:${methodId}`);
			}

			const mappedProviderIntentId = (await ctx.storage.get(`th-payments:provider-map:${providerIntentId}`)) || providerIntentId;
			const record: IntentRecord = {
				providerIntentId: mappedProviderIntentId,
				wabiIntentId: String(input.intentId || ''),
				idempotencyKey,
				amountMinor: toMinorAmount(input.amountMinor),
				currency: String(input.currency || DEFAULT_PROMPTPAY_CURRENCY).toUpperCase(),
				countryCode: String(input.countryCode || 'TH').toUpperCase(),
				status,
				methodId,
				providerManaged,
				presentation,
				providerMetadata,
				createdAt: now,
				updatedAt: now,
				expiresAt
			};

			await saveIntentRecord(ctx, record);
			return {
				providerIntentId: mappedProviderIntentId,
				status,
				checkoutMode,
				presentation,
				expiresAt,
				metadata: {
					provider: PROVIDER_NAME,
					methodId,
					providerManaged,
					...(providerMetadata || {})
				}
			};
		},

		async verifyWebhook(ctx: PluginContext, input: {
			headers: Record<string, string | string[] | undefined>;
			rawBody: string;
		}) {
			ctxRef = ctx;
			const providedSignature = extractHeaderValue(input.headers, 'x-th-payments-signature').trim();
			if (!providedSignature) {
				return { valid: false, reason: 'Missing x-th-payments-signature header' };
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
			const eventId = String(record.eventId || randomId('thevt_')).trim();
			const providerIntentId = String(record.providerIntentId || '').trim();
			const intentId = String(record.intentId || '').trim();
			const status = normalizeStatus(record.status);
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

			if (record.providerManaged) {
				try {
					const statusPayload = await fetchAdapterStatus(record.providerIntentId);
					const nextStatus = normalizeStatus(statusPayload.status);
					if (nextStatus) {
						record.status = nextStatus;
					}
					const nextPresentation = normalizePresentation(statusPayload.presentation);
					if (nextPresentation) {
						record.presentation = nextPresentation;
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

		async refundIntent(ctx: PluginContext, input: {
			providerIntentId?: string;
			intentId?: string;
			amountMinor?: number;
			reason?: string;
			idempotencyKey?: string;
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

			if (record.providerManaged) {
				try {
					const refund = await createAdapterRefund({
						providerIntentId: record.providerIntentId,
						amountMinor: Number.isFinite(Number(input.amountMinor)) ? Math.floor(Number(input.amountMinor)) : record.amountMinor,
						reason: String(input.reason || '').trim() || undefined,
						idempotencyKey: String(input.idempotencyKey || '').trim() || randomId('threfund_')
					});
					const status = normalizeStatus(refund.status);
					if (!status || (status !== 'refunded' && status !== 'pending' && status !== 'failed')) {
						return { status: 'failed', metadata: { reason: 'adapter_invalid_refund_status' } };
					}
					record.status = status;
					record.updatedAt = Date.now();
					await saveIntentRecord(ctx, record);
					return {
						status,
						providerRefundId: typeof refund.providerRefundId === 'string' ? refund.providerRefundId : randomId('thrf_'),
						metadata: toObject(refund.metadata) || null
					};
				} catch (error) {
					return {
						status: 'failed',
						metadata: {
							reason: 'adapter_refund_failed',
							detail: error instanceof Error ? error.message : 'unknown'
						}
					};
				}
			}

			if (record.status !== 'succeeded' && record.status !== 'pending') {
				return {
					status: 'failed',
					metadata: { reason: `cannot_refund_status_${record.status}` }
				};
			}

			record.status = 'refunded';
			record.updatedAt = Date.now();
			await saveIntentRecord(ctx, record);

			return {
				status: 'refunded',
				providerRefundId: randomId('thrf_'),
				metadata: {
					providerIntentId: record.providerIntentId,
					refundedAt: record.updatedAt
				}
			};
		}
	}
};

export default plugin;