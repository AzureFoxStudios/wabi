import QRCode from 'qrcode';
import { brandName } from '$lib/branding';
import { formatMinorAmount, parseMajorAmountInput } from '$lib/payments/paymentAmounts';
import {
	getPaymentAccess,
	getPaymentIntent,
	getUserSettings,
	listPaymentAccountLinks,
	saveUserSettings,
	type PaymentAccountLink,
	type PaymentAccessActorStatus,
	type PaymentEvent,
	type PaymentIntent
} from '$lib/api';

export type PaymentActionResult = {
	actionInfo?: string;
	actionError?: string;
};

export function parsePaymentAmountMinor(value: string, currency: string): number {
	return parseMajorAmountInput(value, currency);
}

export function getPresentationString(presentation: Record<string, unknown>, key: string): string {
	const value = presentation[key];
	return typeof value === 'string' ? value.trim() : '';
}

export function getShareablePaymentTarget(presentation: Record<string, unknown>): string {
	return (
		getPresentationString(presentation, 'url') ||
		getPresentationString(presentation, 'deepLinkUrl') ||
		getPresentationString(presentation, 'fallbackUrl') ||
		getPresentationString(presentation, 'qrData')
	);
}

export function getQrImageSource(presentation: Record<string, unknown>, qrDataUrl: string): string {
	return getPresentationString(presentation, 'qrImageUrl') || qrDataUrl;
}

export async function copyPaymentText(text: string): Promise<PaymentActionResult> {
	if (!text) return {};
	try {
		await navigator.clipboard.writeText(text);
		return { actionInfo: 'Copied to clipboard.' };
	} catch {
		return { actionError: 'Failed to copy to clipboard.' };
	}
}

export async function savePaymentQrImage(source: string, intentId?: string): Promise<PaymentActionResult> {
	if (!source) return { actionError: 'No QR image is available to save.' };

	const anchor = document.createElement('a');
	anchor.download = `wabi-payment-${intentId || 'intent'}.png`;
	try {
		if (source.startsWith('data:')) {
			anchor.href = source;
			anchor.click();
			return { actionInfo: 'QR image saved.' };
		}

		const response = await fetch(source);
		if (!response.ok) throw new Error('download_failed');
		const blob = await response.blob();
		const objectUrl = URL.createObjectURL(blob);
		anchor.href = objectUrl;
		anchor.click();
		URL.revokeObjectURL(objectUrl);
		return { actionInfo: 'QR image saved.' };
	} catch {
		anchor.href = source;
		anchor.target = '_blank';
		anchor.rel = 'noopener noreferrer';
		anchor.click();
		return { actionInfo: 'Opened QR image. Use browser save if download was blocked.' };
	}
}

export async function sharePaymentTarget(target: string, activeIntent: PaymentIntent | null): Promise<PaymentActionResult> {
	if (!target) return { actionError: 'No payment target is available to share.' };

	const title = `${brandName} payment request`;
	const text = activeIntent
		? `Pay ${formatMinorAmount(activeIntent.amountMinor, activeIntent.currency)}`
		: `${brandName} payment request`;

	if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
		try {
			await navigator.share({ title, text, url: target });
			return { actionInfo: 'Payment request shared.' };
		} catch {
			// Fall through to clipboard copy for dismissed or unsupported native share flows.
		}
	}

	await copyPaymentText(target);
	return { actionInfo: 'Share unavailable on this device. Copied payment target instead.' };
}

export async function createPaymentQrDataUrl(presentation: Record<string, unknown>): Promise<string> {
	const qrPayload = typeof presentation.qrData === 'string' ? presentation.qrData.trim() : '';
	if (!qrPayload) return '';
	try {
		return await QRCode.toDataURL(qrPayload, {
			errorCorrectionLevel: 'M',
			margin: 1,
			width: 360
		});
	} catch {
		return '';
	}
}

export async function loadPaymentAccountRoutePreference(token: string | null): Promise<string> {
	if (!token) return '';
	try {
		const settings = await getUserSettings(token);
		return String(settings?.payment_preferred_route || '').trim().toUpperCase();
	} catch {
		return '';
	}
}

export async function savePaymentAccountRoutePreference(token: string | null, routeKey: string): Promise<string> {
	const normalized = String(routeKey || '').trim().toUpperCase();
	if (!token || !normalized) return '';
	await saveUserSettings(token, { payment_preferred_route: normalized });
	return normalized;
}

export async function fetchPaymentAccountLinks(token: string | null): Promise<PaymentAccountLink[]> {
	return token ? listPaymentAccountLinks(token) : [];
}

export async function fetchPaymentAccessStatus(token: string | null): Promise<PaymentAccessActorStatus | null> {
	try {
		return (await getPaymentAccess(token)).actor;
	} catch {
		return null;
	}
}

export async function fetchPaymentIntentStatus(
	token: string | null,
	intentId: string,
	refresh: boolean
): Promise<{ intent: PaymentIntent; events: PaymentEvent[]; providerRefreshError?: string }> {
	if (!token) throw new Error('You must be logged in to view payment status.');
	return getPaymentIntent(token, intentId, { refresh, includeEvents: true, eventLimit: 50 });
}
