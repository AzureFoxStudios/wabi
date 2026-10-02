export type OpeningSurface = 'server' | 'messages' | 'last-channel';

export function parseOpeningSurface(saved: string | null): OpeningSurface {
	return saved === 'server' || saved === 'messages' ? saved : 'last-channel';
}

export function accountPreferenceKey(preference: string, server: string, account: string | number): string {
	return `wabi:${preference}:${encodeURIComponent(server)}:${encodeURIComponent(String(account))}`;
}
