import { lookup as dnsLookup } from "dns/promises";
import { isIP } from "net";

function isPrivateOrReservedIpv4(ip: string): boolean {
	const octets = ip.split('.').map((part) => Number.parseInt(part, 10));
	if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
		return true;
	}
	const [a, b] = octets;
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	if (a >= 224) return true;
	return false;
}

function isPrivateOrReservedIpv6(ip: string): boolean {
	const normalized = ip.toLowerCase();
	if (normalized === '::' || normalized === '::1') return true;
	if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
	if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
		return true;
	}
	return false;
}

function isBlockedHostName(hostname: string): boolean {
	const normalized = hostname.trim().toLowerCase();
	return normalized === 'localhost' || normalized.endsWith('.localhost');
}

function isPrivateOrReservedIp(ip: string): boolean {
	const version = isIP(ip);
	if (version === 4) return isPrivateOrReservedIpv4(ip);
	if (version === 6) return isPrivateOrReservedIpv6(ip);
	return true;
}

async function assertSafeExternalUrl(rawUrl: string): Promise<URL> {
	const parsed = new URL(rawUrl);
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error('Only HTTP(S) URLs are allowed');
	}
	if (parsed.username || parsed.password) {
		throw new Error('Credentialed URLs are not allowed');
	}
	if (isBlockedHostName(parsed.hostname)) {
		throw new Error('Hostname is not allowed');
	}

	if (isIP(parsed.hostname) > 0) {
		if (isPrivateOrReservedIp(parsed.hostname)) {
			throw new Error('Private or reserved IPs are not allowed');
		}
		return parsed;
	}

	let records: Awaited<ReturnType<typeof dnsLookup>>;
	try {
		records = await dnsLookup(parsed.hostname, { all: true, verbatim: true });
	} catch {
		throw new Error('Failed to resolve target host');
	}
	if (!Array.isArray(records) || records.length === 0) {
		throw new Error('Failed to resolve target host');
	}
	for (const record of records) {
		if (isPrivateOrReservedIp(record.address)) {
			throw new Error('Resolved host maps to a blocked IP range');
		}
	}
	return parsed;
}

function isRedirectStatusCode(statusCode: number): boolean {
	return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308;
}

export async function fetchExternalUrlWithGuards(
	rawUrl: string,
	init: RequestInit,
	maxRedirects = 3
): Promise<Response> {
	let nextUrl = await assertSafeExternalUrl(rawUrl);
	for (let hop = 0; hop <= maxRedirects; hop += 1) {
		const response = await fetch(nextUrl.toString(), {
			...init,
			redirect: 'manual'
		});
		if (!isRedirectStatusCode(response.status)) {
			return response;
		}
		const location = response.headers.get('location');
		if (!location) {
			return response;
		}
		if (hop === maxRedirects) {
			throw new Error('Too many redirects');
		}
		const redirected = new URL(location, nextUrl);
		nextUrl = await assertSafeExternalUrl(redirected.toString());
	}
	throw new Error('Too many redirects');
}
