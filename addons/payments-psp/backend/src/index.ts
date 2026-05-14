import crypto from 'crypto';
import type { BackendPlugin, PluginContext } from '@wabi/payment-types';

const PROVIDER_NAME = 'Stripe/PayPal';

function getStripeConfigured(): boolean {
	return Boolean(process.env.STRIPE_SECRET_KEY);
}

function getPayPalConfigured(): boolean {
	return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

function toMinorAmount(amountMinor: unknown): number {
	const parsed = Number(amountMinor);
	if (!Number.isFinite(parsed)) return 0;
	return Math.max(0, Math.floor(parsed));
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

function toObject(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

const plugin: BackendPlugin = {
	name: 'payments-psp',

	async onLoad(ctx) {
		ctx.logger.info('payments-psp plugin loaded', {
			provider: PROVIDER_NAME,
			stripeConfigured: getStripeConfigured(),
			paypalConfigured: getPayPalConfigured()
		});
	},

	payment: {
		async getCapabilities() {
			const methods = [];

			if (getStripeConfigured()) {
				methods.push({
					id: 'stripe_checkout',
					label: 'Stripe Checkout',
					checkoutModes: ['payment_link', 'redirect'],
					enabledByDefault: true,
					estimatedSharePercent: 29,
					notes: 'Stripe hosted checkout. Requires STRIPE_SECRET_KEY.'
				});
			}

			if (getPayPalConfigured()) {
				methods.push({
					id: 'paypal_checkout',
					label: 'PayPal Checkout',
					checkoutModes: ['payment_link', 'redirect'],
					enabledByDefault: true,
					estimatedSharePercent: 34,
					notes: 'PayPal hosted checkout. Requires PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.'
				});
			}

			return {
				pluginId: 'payments-psp',
				providerName: PROVIDER_NAME,
				countries: [],
				currencies: ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY'],
				methods,
				nonCustodialOnly: false,
				webhookSignatureRequired: true,
				supportsRefunds: true,
				supportsDisputes: true,
				notes: 'Stripe and PayPal provider. Configure to enable.'
			};
		},

		async createIntent(ctx: PluginContext, input: {
			intentId?: string;
			idempotencyKey?: string;
			amountMinor?: number;
			methodId?: string;
			currency?: string;
			customerRef?: string;
			description?: string;
			metadata?: Record<string, unknown>;
			workspaceId?: string;
			channelId?: string;
		}) {
			const methodId = String(input.methodId || '').trim();

			if (methodId === 'stripe_checkout' && !getStripeConfigured()) {
				throw new Error('payments-psp_stripe_not_configured');
			}
			if (methodId === 'paypal_checkout' && !getPayPalConfigured()) {
				throw new Error('payments-psp_paypal_not_configured');
			}

			const providerIntentId = `${methodId}_${crypto.randomBytes(10).toString('hex')}`;

			return {
				providerIntentId,
				status: 'pending',
				checkoutMode: 'payment_link',
				presentation: {
					mode: 'payment_link',
					url: `https://example.com/checkout/${providerIntentId}`,
					expiresAt: Date.now() + 15 * 60 * 1000
				},
				expiresAt: Date.now() + 15 * 60 * 1000,
				metadata: {
					provider: PROVIDER_NAME,
					methodId,
					warning: 'PSP adapter not implemented - configure STRIPE_SECRET_KEY or PAYPAL credentials'
				}
			};
		},

		async verifyWebhook(ctx: PluginContext, input: {
			headers: Record<string, string | string[] | undefined>;
			rawBody: string;
		}) {
			return {
				valid: false,
				reason: 'Webhook verification not implemented'
			};
		},

		async getIntentStatus(ctx: PluginContext, input: {
			providerIntentId?: string;
			intentId?: string;
		}) {
			return {
				status: 'pending',
				metadata: { reason: 'Status check not implemented' }
			};
		},

		async refundIntent(ctx: PluginContext, input: {
			providerIntentId?: string;
			intentId?: string;
			amountMinor?: number;
			reason?: string;
		}) {
			return {
				status: 'failed',
				metadata: { reason: 'Refund not implemented' }
			};
		}
	}
};

export default plugin;