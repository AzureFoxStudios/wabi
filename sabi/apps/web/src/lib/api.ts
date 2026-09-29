import { session } from './storage.ts';

/** Tiny API client. All requests are same-origin and relative (works behind any proxy). */
export class ApiError extends Error {
  status: number;
  code: string;
  details: any;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/*
 * Auth: the server sets an HttpOnly session cookie. Some embeddings (a cross-site iframe with third-party
 * cookies blocked) never send it back, so we also keep the session token for this tab only and send it
 * as a Bearer header. GET-only browser loads (EventSource, images, downloads) use authUrl().
 */
const TOKEN_KEY = 'sabi.token';
// Tab-scoped; falls back to memory when storage is blocked (client-side navigation keeps it alive).
function token(): string | null {
  return session.get(TOKEN_KEY);
}
function setToken(t: string | null | undefined) {
  session.set(TOKEN_KEY, t || null);
}
function headers(extra: Record<string, string> = {}): Record<string, string> {
  const t = token();
  // Both headers on purpose: some proxies strip Authorization.
  return t ? { ...extra, authorization: `Bearer ${t}`, 'x-sabi-session': t } : extra;
}
/** URL for a GET resource the browser loads itself (img src, download link, EventSource). */
export function authUrl(path: string): string {
  const t = token();
  return t ? `${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(t)}` : path;
}

async function handle<T>(res: Response): Promise<T> {
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const e = body.error ?? {};
    if (res.status === 401) setToken(null);
    if (res.status === 401 && typeof window !== 'undefined' && !location.pathname.startsWith('/login') && !location.pathname.startsWith('/setup')) {
      location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    }
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? res.statusText, e.details);
  }
  return body as T;
}

export async function get<T = any>(path: string, params?: Record<string, string | undefined | null | boolean>): Promise<T> {
  const qs = params ? new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false).map(([k, v]) => [k, String(v)])).toString() : '';
  return handle<T>(await fetch(`/api/${path}${qs ? `?${qs}` : ''}`, { credentials: 'same-origin', headers: headers() }));
}

export async function post<T = any>(path: string, body: unknown = {}): Promise<T> {
  const signIn = path === 'login' || path === 'setup';
  const payload = signIn ? { ...(body as object), wantToken: true } : body;
  const r = await handle<T>(await fetch(`/api/${path}`, {
    method: 'POST', credentials: 'same-origin', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify(payload),
  }));
  if (signIn) setToken((r as any)?.token);
  if (path === 'logout') setToken(null);
  return r;
}

/*
 * Corrections (voiding issued documents or payments, manual journal entries) may need a separate
 * password. The server answers `corrections_password`; we ask for it once, keep it in memory for a
 * few minutes and retry the same command — so no screen has to know which actions are corrections.
 */
type Asker = (message: string) => Promise<string | null>;
let askCorrections: Asker | null = null;
let correctionsCache: { pw: string; until: number } | null = null;
export function setCorrectionsAsker(fn: Asker | null) {
  askCorrections = fn;
}

/** Run a domain command. Returns the handler result. */
export async function command<T = any>(name: string, input: Record<string, unknown>): Promise<T> {
  const pw = correctionsCache && correctionsCache.until > Date.now() ? correctionsCache.pw : undefined;
  try {
    const r = await post<{ result: T }>(`commands/${name}`, pw ? { ...input, correctionsPassword: pw } : input);
    return r.result;
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== 'corrections_password' || !askCorrections) throw e;
    correctionsCache = null;
    const given = await askCorrections(pw ? 'wrong' : 'needed');
    if (!given) throw new ApiError(0, 'cancelled', 'Cancelled');
    correctionsCache = { pw: given, until: Date.now() + 5 * 60_000 };
    return command<T>(name, input);
  }
}

export async function upload(subjectType: string, subjectId: string, file: File) {
  const qs = new URLSearchParams({ subjectType, subjectId, name: file.name });
  return handle<{ result: { id: string } }>(await fetch(`/api/files?${qs}`, {
    method: 'POST', credentials: 'same-origin', headers: headers({ 'content-type': file.type || 'application/octet-stream' }), body: file,
  }));
}
