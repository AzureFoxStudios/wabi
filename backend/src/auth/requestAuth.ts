import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'http';
import { verifyToken } from './jwt.js';
import { sessionRepository } from '../db/repositories/sessionRepository.js';

const AUTH_COOKIE_NAME = (process.env.AUTH_COOKIE_NAME || 'wabi_auth').trim() || 'wabi_auth';
const AUTH_COOKIE_DOMAIN = (process.env.AUTH_COOKIE_DOMAIN || '').trim();
const AUTH_COOKIE_SAME_SITE_RAW = (process.env.AUTH_COOKIE_SAMESITE || 'lax').trim().toLowerCase();
const AUTH_COOKIE_SECURE_RAW = (process.env.AUTH_COOKIE_SECURE || '').trim().toLowerCase();
const DEFAULT_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

type SameSiteValue = 'Strict' | 'Lax' | 'None';

function normalizeSameSite(value: string): SameSiteValue {
  if (value === 'strict') return 'Strict';
  if (value === 'none') return 'None';
  return 'Lax';
}

function parseBoolean(value: string, fallback: boolean): boolean {
  if (!value) return fallback;
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
  return fallback;
}

function shouldUseSecureCookie(sameSite: SameSiteValue): boolean {
  const fallback = process.env.NODE_ENV === 'production' || sameSite === 'None';
  return parseBoolean(AUTH_COOKIE_SECURE_RAW, fallback) || sameSite === 'None';
}

function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  const pairs = cookieHeader.split(';');
  for (const pairRaw of pairs) {
    const pair = pairRaw.trim();
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const valueRaw = pair.slice(eq + 1);
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(valueRaw);
    } catch {
      out[key] = valueRaw;
    }
  }
  return out;
}

function appendSetCookieHeader(res: ServerResponse, cookie: string): void {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookie);
    return;
  }
  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing.map(String), cookie]);
    return;
  }
  res.setHeader('Set-Cookie', [String(existing), cookie]);
}

function serializeCookie(name: string, value: string, maxAgeSeconds: number): string {
  const sameSite = normalizeSameSite(AUTH_COOKIE_SAME_SITE_RAW);
  const secure = shouldUseSecureCookie(sameSite);
  const attrs: string[] = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${sameSite}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`
  ];
  if (secure) attrs.push('Secure');
  if (AUTH_COOKIE_DOMAIN) attrs.push(`Domain=${AUTH_COOKIE_DOMAIN}`);
  return attrs.join('; ');
}

export function getAuthTokenFromHeaders(headers: IncomingHttpHeaders): string | null {
  const authHeader = headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.slice(7).trim();
    if (bearer) return bearer;
  }

  const cookies = parseCookieHeader(typeof headers.cookie === 'string' ? headers.cookie : undefined);
  const cookieToken = cookies[AUTH_COOKIE_NAME];
  if (!cookieToken) return null;
  const token = cookieToken.trim();
  return token.length > 0 ? token : null;
}

export function getAuthTokenFromRequest(req: IncomingMessage): string | null {
  return getAuthTokenFromHeaders(req.headers);
}

export function getAuthenticatedUserIdFromRequest(req: IncomingMessage): number | null {
  const token = getAuthTokenFromRequest(req);
  if (!token) return null;
  try {
    const payload = verifyToken(token);
    if (!payload.userId || !payload.sessionId) return null;
    const dbSession = sessionRepository.findById(payload.sessionId);
    if (!dbSession || (dbSession.expires_at && dbSession.expires_at < Date.now())) {
      return null;
    }
    return payload.userId;
  } catch {
    return null;
  }
}

export function getAuthenticatedSessionIdFromRequest(req: IncomingMessage): string | null {
  const token = getAuthTokenFromRequest(req);
  if (!token) return null;
  try {
    const payload = verifyToken(token);
    if (!payload.sessionId) return null;
    const dbSession = sessionRepository.findById(payload.sessionId);
    if (!dbSession || (dbSession.expires_at && dbSession.expires_at < Date.now())) {
      return null;
    }
    return payload.sessionId;
  } catch {
    return null;
  }
}

export function setAuthCookie(res: ServerResponse, token: string, maxAgeSeconds = DEFAULT_COOKIE_MAX_AGE_SECONDS): void {
  appendSetCookieHeader(res, serializeCookie(AUTH_COOKIE_NAME, token, maxAgeSeconds));
}

export function clearAuthCookie(res: ServerResponse): void {
  appendSetCookieHeader(res, serializeCookie(AUTH_COOKIE_NAME, '', 0));
}
