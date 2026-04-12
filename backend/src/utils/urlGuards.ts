import dns from 'dns';
import { isIP } from 'net';

const BLOCKED_HOSTS = new Set([
  'localhost',
  'local',
  'metadata.google.internal',
  'metadata.azure.com',
  'instance-data',
  '169.254.169.254',
  '100.100.100.200',
  '168.63.129.16',
]);

function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && b === 18) return true;
  if (a === 192 && b === 0 && parts[2] === 0) return true;
  if (a === 192 && b === 0 && parts[2] === 2) return true;
  if (a === 198 && b === 51 && parts[2] === 100) return true;
  if (a === 203 && b === 0 && parts[2] === 113) return true;
  return false;
}

function isPrivateOrReservedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::' || normalized === 'fe80::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('fe80')) return true;
  if (normalized.startsWith('ff')) return true;
  if (normalized.startsWith('2001:db8')) return true;
  if (normalized.startsWith('100::')) return true;
  return false;
}

function isPrivateOrReservedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateOrReservedIpv4(ip);
  if (v === 6) return isPrivateOrReservedIpv6(ip);
  return false;
}

function isBlockedHostName(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(lower)) return true;
  if (lower.endsWith('.localhost') || lower.endsWith('.local')) return true;
  if (lower.endsWith('.internal') || lower.endsWith('.metadata')) return true;
  return false;
}

export async function assertSafeExternalUrl(rawUrl: string, maxRedirects = 3): Promise<URL> {
  let nextUrl: URL;
  try {
    nextUrl = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }

  if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
    throw new Error('Only HTTP(S) URLs are allowed');
  }
  if (nextUrl.username || nextUrl.password) {
    throw new Error('Credentialed URLs are not allowed');
  }
  if (isBlockedHostName(nextUrl.hostname)) {
    throw new Error('Hostname is not allowed');
  }

  if (isIP(nextUrl.hostname) > 0) {
    if (isPrivateOrReservedIp(nextUrl.hostname)) {
      throw new Error('Private or reserved IPs are not allowed');
    }
    return nextUrl;
  }

  let records: dns.LookupAddress[];
  try {
    records = await new Promise<dns.LookupAddress[]>((resolve, reject) => {
      dns.lookup(nextUrl.hostname, { all: true }, (err, addresses) => {
        if (err) reject(err);
        else resolve(addresses);
      });
    });
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

  return nextUrl;
}

export async function fetchExternalUrlWithGuards(
  rawUrl: string,
  init: RequestInit = {},
  maxRedirects = 3
): Promise<Response> {
  let nextUrl = await assertSafeExternalUrl(rawUrl);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await fetch(nextUrl.toString(), {
      ...init,
      redirect: 'manual'
    });

    if (response.status < 300 || response.status >= 400 || !response.headers.has('location')) {
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
