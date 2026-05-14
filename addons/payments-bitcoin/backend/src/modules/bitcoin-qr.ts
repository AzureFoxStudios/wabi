const SATOSHIS_PER_BTC = 100_000_000;

export function toSats(amountMinor: number): number {
	const parsed = Number(amountMinor);
	if (!Number.isFinite(parsed)) return 0;
	return Math.max(0, Math.floor(parsed));
}

export function satsToBtcString(amountMinor: number): string {
	const sats = toSats(amountMinor);
	const whole = Math.floor(sats / SATOSHIS_PER_BTC);
	const fraction = String(sats % SATOSHIS_PER_BTC).padStart(8, '0').replace(/0+$/, '');
	return `${whole}${fraction ? `.${fraction}` : ''}`;
}

export function formatSatsLabel(amountMinor: number): string {
	return `${satsToBtcString(amountMinor)} BTC`;
}

export function normalizeBitcoinAddress(raw: string): string | null {
	let value = String(raw || '').trim();
	if (!value) return null;
	if (value.toLowerCase().startsWith('bitcoin:')) {
		value = value.slice('bitcoin:'.length);
	}
	const queryIndex = value.indexOf('?');
	if (queryIndex >= 0) {
		value = value.slice(0, queryIndex);
	}
	value = value.trim();
	if (!value) return null;
	if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,62}$/.test(value)) {
		return value;
	}
	if (/^(bc1|tb1|bcrt1)[ac-hj-np-z02-9]{11,87}$/i.test(value)) {
		return value.toLowerCase();
	}
	return null;
}

export interface BitcoinUriParams {
	address: string;
	amountMinor: number;
	label?: string;
	message?: string;
}

export function buildBitcoinUri({ address, amountMinor, label, message }: BitcoinUriParams): string {
	const normalizedAddress = normalizeBitcoinAddress(address);
	if (!normalizedAddress) {
		throw new Error('btc_payments_invalid_address');
	}
	const params = new URLSearchParams();
	const btcAmount = satsToBtcString(amountMinor);
	if (btcAmount && btcAmount !== '0') {
		params.set('amount', btcAmount);
	}
	const normalizedLabel = String(label || '').trim();
	if (normalizedLabel) {
		params.set('label', normalizedLabel.slice(0, 80));
	}
	const normalizedMessage = String(message || '').trim();
	if (normalizedMessage) {
		params.set('message', normalizedMessage.slice(0, 240));
	}
	const suffix = params.toString();
	return `bitcoin:${normalizedAddress}${suffix ? `?${suffix}` : ''}`;
}

export function isServerDonationIntent(input: { metadata?: { kind?: string } }): boolean {
	return Boolean(input?.metadata && input.metadata.kind === 'server_donation');
}

export interface BitcoinDestination {
	address: string;
	source: 'user' | 'server';
}

export function resolveBitcoinDestination(input: {
	customerRef?: string;
	metadata?: { kind?: string };
}): BitcoinDestination {
	const savedOrOneOffRef = String(input?.customerRef || '').trim();
	if (isServerDonationIntent(input)) {
		const serverDonationAddress = normalizeBitcoinAddress(process.env.BTC_PAYMENTS_DONATION_ADDRESS || '');
		if (!serverDonationAddress) {
			throw new Error('btc_payments_server_address_not_configured');
		}
		return {
			address: serverDonationAddress,
			source: 'server'
		};
	}

	const userAddress = normalizeBitcoinAddress(savedOrOneOffRef);
	if (!userAddress) {
		throw new Error('btc_payments_address_required');
	}
	return {
		address: userAddress,
		source: 'user'
	};
}