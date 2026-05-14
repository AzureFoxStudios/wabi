const DEFAULT_PROMPTPAY_COUNTRY = 'TH';

export function toMinorAmount(amountMinor: unknown): number {
	const parsed = Number(amountMinor);
	if (!Number.isFinite(parsed)) return 0;
	return Math.max(0, Math.floor(parsed));
}

function tlv(tag: string, value: string): string {
	const len = String(value.length).padStart(2, '0');
	return `${tag}${len}${value}`;
}

export function normalizePromptPayProxyId(raw: unknown): string | null {
	const digits = String(raw || '').replace(/\D/g, '');
	if (!digits) return null;

	if (digits.length === 10 && digits.startsWith('0')) {
		return `0066${digits.slice(1)}`;
	}

	if (digits.length === 13) {
		return digits;
	}

	if (digits.length === 15) {
		return digits;
	}

	return null;
}

function crc16Ccitt(input: string): string {
	let crc = 0xffff;
	for (let i = 0; i < input.length; i += 1) {
		crc ^= input.charCodeAt(i) << 8;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) : crc << 1;
			crc &= 0xffff;
		}
	}
	return crc.toString(16).toUpperCase().padStart(4, '0');
}

export interface PromptPayQrParams {
	proxyId: string;
	amountMinor: number;
	intentId: string;
}

export function buildPromptPayQrPayload({ proxyId, amountMinor, intentId }: PromptPayQrParams): string {
	const normalizedProxy = normalizePromptPayProxyId(proxyId);
	if (!normalizedProxy) {
		throw new Error('th_payments_invalid_promptpay_proxy_id');
	}

	const isMobileProxy = normalizedProxy.startsWith('0066');
	const merchantInfo =
		tlv('00', 'A000000677010111') +
		tlv(isMobileProxy ? '01' : '02', normalizedProxy);

	let payload = '';
	payload += tlv('00', '01');
	payload += tlv('01', '12');
	payload += tlv('29', merchantInfo);
	payload += tlv('53', '764');

	const amount = (toMinorAmount(amountMinor) / 100).toFixed(2);
	payload += tlv('54', amount);
	payload += tlv('58', DEFAULT_PROMPTPAY_COUNTRY);
	payload += tlv('59', (process.env.TH_PAYMENTS_MERCHANT_NAME || 'WABI').slice(0, 25).toUpperCase());
	payload += tlv('60', (process.env.TH_PAYMENTS_MERCHANT_CITY || 'BANGKOK').slice(0, 15).toUpperCase());

	const reference = String(intentId || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 25);
	if (reference) {
		payload += tlv('62', tlv('05', reference));
	}

	const bodyForCrc = `${payload}6304`;
	const crc = crc16Ccitt(bodyForCrc);
	return `${bodyForCrc}${crc}`;
}

export function isServerDonationIntent(input: unknown): boolean {
	const record = input as Record<string, unknown> | null;
	return Boolean(record?.metadata && record.metadata.kind === 'server_donation');
}

export interface ResolvedPromptPayTarget {
	proxyId: string;
	source: string;
}

export function resolvePromptPayProxyId(input: unknown): ResolvedPromptPayTarget {
	const record = input as Record<string, unknown> | null;
	const savedOrOneOffRef = String(record?.customerRef || '').trim();
	if (isServerDonationIntent(input)) {
		const serverPromptPayProxyId = String(process.env.TH_PAYMENTS_PROMPTPAY_PROXY_ID || '').trim();
		if (!serverPromptPayProxyId) {
			throw new Error('th_payments_server_promptpay_not_configured');
		}
		return {
			proxyId: serverPromptPayProxyId,
			source: 'server'
		};
	}
	if (!savedOrOneOffRef) {
		throw new Error('th_payments_promptpay_reference_required');
	}
	return {
		proxyId: savedOrOneOffRef,
		source: 'user'
	};
}