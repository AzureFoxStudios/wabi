// Minor-unit decimals per rail. Must match the Rust addon crates:
// payments-crypto chain decimals (USDC/USDT 6, BTC 8, XMR 12); fiat defaults
// to 2 via Intl below (EUR/USD/THB).
const SPECIAL_CURRENCY_MINOR_UNITS: Record<string, number> = {
	BTC: 8,
	XMR: 12,
	USDC: 6,
	USDT: 6
};

function normalizeCurrencyCode(currency: string | null | undefined): string {
	return String(currency || '').trim().toUpperCase();
}

export function getCurrencyMinorUnit(currency: string | null | undefined): number {
	const normalized = normalizeCurrencyCode(currency);
	if (normalized in SPECIAL_CURRENCY_MINOR_UNITS) {
		return SPECIAL_CURRENCY_MINOR_UNITS[normalized];
	}
	if (!normalized) {
		return 2;
	}
	try {
		return new Intl.NumberFormat(undefined, {
			style: 'currency',
			currency: normalized
		}).resolvedOptions().maximumFractionDigits;
	} catch {
		return 2;
	}
}

export function parseMajorAmountInput(value: string, currency: string | null | undefined): number {
	const normalizedInput = String(value || '')
		.trim()
		.replace(/,/g, '');
	if (!normalizedInput || !/^\d+(?:\.\d+)?$/.test(normalizedInput)) {
		return 0;
	}

	const minorUnit = getCurrencyMinorUnit(currency);
	const [wholePartRaw, fractionPartRaw = ''] = normalizedInput.split('.');
	const wholePart = wholePartRaw.replace(/^0+(?=\d)/, '') || '0';
	const truncatedFraction = fractionPartRaw.slice(0, minorUnit);
	const paddedFraction = truncatedFraction.padEnd(minorUnit, '0');
	const combined = `${wholePart}${paddedFraction}`.replace(/^0+(?=\d)/, '') || '0';
	const parsed = Number(combined);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function formatMinorAsDecimalString(
	amountMinor: number,
	currency: string | null | undefined,
	trimTrailingZeros: boolean
): string {
	const minorUnit = getCurrencyMinorUnit(currency);
	const absolute = Math.abs(Math.trunc(amountMinor));
	if (minorUnit === 0) {
		return `${amountMinor < 0 ? '-' : ''}${absolute.toString()}`;
	}

	const divisor = 10 ** minorUnit;
	const whole = Math.floor(absolute / divisor);
	let fraction = String(absolute % divisor).padStart(minorUnit, '0');
	if (trimTrailingZeros) {
		fraction = fraction.replace(/0+$/, '');
	}
	return `${amountMinor < 0 ? '-' : ''}${whole.toString()}${fraction ? `.${fraction}` : ''}`;
}

export function minorToMajorInput(amountMinor: number, currency: string | null | undefined): string {
	if (!Number.isFinite(amountMinor)) return '';
	return formatMinorAsDecimalString(amountMinor, currency, true);
}

export function formatMinorAmount(amountMinor: number, currency: string | null | undefined): string {
	const normalizedCurrency = normalizeCurrencyCode(currency);
	if (!Number.isFinite(amountMinor)) {
		return normalizedCurrency || '';
	}
	if (normalizedCurrency === 'BTC') {
		return `${formatMinorAsDecimalString(amountMinor, normalizedCurrency, true)} BTC`.trim();
	}

	const minorUnit = getCurrencyMinorUnit(normalizedCurrency);
	const value = amountMinor / 10 ** minorUnit;
	try {
		return new Intl.NumberFormat(undefined, {
			style: 'currency',
			currency: normalizedCurrency || 'USD',
			maximumFractionDigits: Math.max(2, minorUnit),
			minimumFractionDigits: minorUnit === 0 ? 0 : Math.min(minorUnit, 2)
		}).format(value);
	} catch {
		return `${formatMinorAsDecimalString(amountMinor, normalizedCurrency, true)} ${normalizedCurrency}`.trim();
	}
}
