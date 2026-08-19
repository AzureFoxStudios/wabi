import type { PaymentIntent, PaymentIntentStatus } from '../api';
import { brandName } from '../branding';

export type PaymentVerificationMode =
	| 'provider_verified'
	| 'external_confirmation'
	| 'local_test'
	| 'standard';

function getIntentMetadata(intent: Pick<PaymentIntent, 'metadata'>): Record<string, unknown> {
	return intent.metadata && typeof intent.metadata === 'object' ? intent.metadata : {};
}

function getIntentMethodId(intent: Pick<PaymentIntent, 'metadata'>): string {
	const metadata = getIntentMetadata(intent);
	return typeof metadata.methodId === 'string' ? metadata.methodId.trim() : '';
}

export function getPaymentVerificationMode(
	intent: Pick<PaymentIntent, 'pluginId' | 'checkoutMode' | 'metadata'>
): PaymentVerificationMode {
	const metadata = getIntentMetadata(intent);
	if (metadata.localTestMode === true) {
		return 'local_test';
	}
	if (metadata.providerManaged === true) {
		return 'provider_verified';
	}
	const methodId = getIntentMethodId(intent);
	if (
		(intent.pluginId === 'promptpay' || intent.pluginId === 'th-payments') &&
		(methodId === 'promptpay_qr' || intent.checkoutMode === 'qr')
	) {
		return 'external_confirmation';
	}
	if (intent.pluginId === 'btc-payments' && methodId === 'bitcoin_qr') {
		return 'external_confirmation';
	}
	// Phases 2-4 rails: crypto wallet QRs, EPC SEPA QRs and US app switches all
	// settle outside Wabi — pending stays until manual confirmation.
	if (
		intent.pluginId === 'payments-crypto' ||
		intent.pluginId === 'payments-eu' ||
		intent.pluginId === 'payments-us'
	) {
		return 'external_confirmation';
	}
	return 'standard';
}

function humanizeStatus(status: PaymentIntentStatus): string {
	switch (status) {
		case 'draft':
			return 'Draft';
		case 'pending':
			return 'Pending';
		case 'succeeded':
			return 'Paid';
		case 'failed':
			return 'Failed';
		case 'expired':
			return 'Expired';
		case 'refunded':
			return 'Refunded';
		case 'disputed':
			return 'Disputed';
		case 'canceled':
			return 'Canceled';
		default:
			return status;
	}
}

export function getPaymentIntentStatusLabel(
	intent: Pick<PaymentIntent, 'status' | 'pluginId' | 'checkoutMode' | 'metadata'>
): string {
	const verificationMode = getPaymentVerificationMode(intent);
	switch (intent.status) {
		case 'pending':
			switch (verificationMode) {
				case 'provider_verified':
					return 'Awaiting Provider Confirmation';
				case 'external_confirmation':
					return 'Awaiting External Confirmation';
				case 'local_test':
					return 'Awaiting Test Confirmation';
				default:
					return 'Pending';
			}
		case 'succeeded':
			switch (verificationMode) {
				case 'provider_verified':
					return 'Paid (Verified)';
				case 'local_test':
					return 'Paid (Test)';
				default:
					return 'Paid';
			}
		default:
			return humanizeStatus(intent.status);
	}
}

export function getPaymentIntentStatusHelp(
	intent: Pick<PaymentIntent, 'status' | 'pluginId' | 'checkoutMode' | 'metadata'>
): string | null {
	const verificationMode = getPaymentVerificationMode(intent);
	switch (verificationMode) {
		case 'provider_verified':
			if (intent.status === 'pending') {
				return `${brandName} is waiting for the external payment provider webhook or status API.`;
			}
			if (intent.status === 'succeeded') {
				return 'Confirmed by the external payment provider.';
			}
			return null;
		case 'external_confirmation':
			if (intent.status === 'pending') {
				if (intent.pluginId === 'btc-payments') {
					return `${brandName} created the request, but the wallet or external processor must confirm settlement. Wallet return alone is not proof of payment.`;
				}
				return `${brandName} created the request, but the bank app or external processor must confirm settlement. App return alone is not proof of payment.`;
			}
			if (intent.status === 'succeeded') {
				if (intent.pluginId === 'btc-payments') {
					return 'Marked paid after external confirmation. Wallet return alone is not treated as proof.';
				}
				return 'Marked paid after external confirmation. App return alone is not treated as proof.';
			}
			return null;
		case 'local_test':
			if (intent.status === 'pending') {
				return 'Local test mode only. This does not move money.';
			}
			if (intent.status === 'succeeded' || intent.status === 'refunded') {
				return 'Local simulation only. No money moved through a real provider.';
			}
			return null;
		default:
			return null;
	}
}

export function getPaymentVerificationLabel(
	intent: Pick<PaymentIntent, 'pluginId' | 'checkoutMode' | 'metadata'>
): string {
	switch (getPaymentVerificationMode(intent)) {
		case 'provider_verified':
			return 'Provider verified';
		case 'external_confirmation':
			return 'External confirmation';
		case 'local_test':
			return 'Local test';
		default:
			return 'Standard';
	}
}
