export function normalizeReaderDocumentServerScope(serverUrl: string | null | undefined): string {
	const raw = String(serverUrl || '').trim();
	if (!raw) return 'local-default';
	try {
		const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
		const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
		return `${parsed.protocol}//${parsed.host}${path}`.toLowerCase();
	} catch {
		return raw.toLowerCase();
	}
}

export function makeReaderDocumentScope(
	serverUrl: string | null | undefined,
	identity: string | number | null | undefined
): string {
	const server = normalizeReaderDocumentServerScope(serverUrl);
	const account = String(identity ?? '').trim() || 'anonymous';
	return `${server}|${account}`;
}

const ANONYMOUS_DEVICE_KEY = 'wabi:reader:anonymous-device:v1';

export function getReaderAnonymousDeviceId(): string {
	if (typeof window === 'undefined') return 'ssr';
	try {
		const existing = localStorage.getItem(ANONYMOUS_DEVICE_KEY)?.trim();
		if (existing) return existing;
		const next = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
			? crypto.randomUUID()
			: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
		localStorage.setItem(ANONYMOUS_DEVICE_KEY, next);
		return next;
	} catch {
		return 'ephemeral';
	}
}
