import { lookup as dnsLookup } from 'dns/promises';
import { isIP } from 'net';

const DEFAULT_MAX_DNS_RECORDS = 16;

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return fallback;
}

function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}

function isHostAllowedByRule(hostname: string, rule: string): boolean {
  if (!rule) return false;
  if (hostname === rule) return true;
  if (!rule.startsWith('.')) return false;
  return hostname.endsWith(rule);
}

function isAllowedHost(hostname: string): boolean {
  const allowedRules = parseAllowedHosts(process.env.WEBHOOK_ALLOWED_HOSTS);
  if (allowedRules.length === 0) return false;
  return allowedRules.some((rule) => isHostAllowedByRule(hostname, rule));
}

function shouldAllowPrivateTargets(): boolean {
  const fallback = process.env.NODE_ENV !== 'production';
  return boolFromEnv(process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS, fallback);
}

function maxDnsRecords(): number {
  const parsed = Number(process.env.WEBHOOK_MAX_DNS_RECORDS || DEFAULT_MAX_DNS_RECORDS);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_DNS_RECORDS;
  return Math.max(1, Math.min(64, Math.floor(parsed)));
}

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

function isPrivateOrReservedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateOrReservedIpv4(ip);
  if (version === 6) return isPrivateOrReservedIpv6(ip);
  return true;
}

function isBlockedHostName(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost');
}

function isRedirectStatusCode(statusCode: number): boolean {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308;
}

export async function assertSafeWebhookTargetUrl(rawUrl: string): Promise<URL> {
  const parsed = new URL(rawUrl);
  const hostname = parsed.hostname.trim().toLowerCase();
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('targetUrl protocol must be http or https');
  }
  if (parsed.username || parsed.password) {
    throw new Error('targetUrl cannot include credentials');
  }
  if (!hostname) {
    throw new Error('targetUrl hostname is required');
  }

  const allowPrivate = shouldAllowPrivateTargets() || isAllowedHost(hostname);
  if (allowPrivate) {
    return parsed;
  }

  if (isBlockedHostName(hostname)) {
    throw new Error('targetUrl hostname is blocked');
  }

  if (isIP(hostname) > 0) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new Error('targetUrl resolves to a private or reserved IP');
    }
    return parsed;
  }

  let records: Awaited<ReturnType<typeof dnsLookup>>;
  try {
    records = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('targetUrl host could not be resolved');
  }

  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('targetUrl host could not be resolved');
  }
  if (records.length > maxDnsRecords()) {
    throw new Error('targetUrl host has too many DNS records');
  }
  for (const record of records) {
    if (isPrivateOrReservedIp(record.address)) {
      throw new Error('targetUrl resolves to a blocked IP range');
    }
  }

  return parsed;
}

export async function fetchWebhookTargetWithGuards(
  rawUrl: string,
  init: RequestInit,
  maxRedirects = 3
): Promise<Response> {
  let nextUrl = await assertSafeWebhookTargetUrl(rawUrl);
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
      throw new Error('targetUrl redirect limit exceeded');
    }
    const redirected = new URL(location, nextUrl);
    nextUrl = await assertSafeWebhookTargetUrl(redirected.toString());
  }
  throw new Error('targetUrl redirect limit exceeded');
}
