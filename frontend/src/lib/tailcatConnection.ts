/** Desktop Tailcat's loopback proxy is a temporary address, not a server identity. */
import { getConfiguredServerRememberPreference, getConfiguredServerUrl, normalizeServerUrl, setConfiguredServerUrl } from './serverUrl';

const PREVIOUS_URL_KEY = 'wabi.tailcat.prevServerUrl';
const PREVIOUS_REMEMBER_KEY = 'wabi.tailcat.prevServerRemember';
const PROXY_URL_KEY = 'wabi.tailcat.proxyUrl';

function proxyPort(url: string): number | null {
	try {
		const parsed = new URL(url);
		const port = Number(parsed.port);
		return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' &&
			parsed.pathname === '/' && !parsed.search && !parsed.hash &&
			Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
	} catch {
		return null;
	}
}

export function rememberTailcatConnection(previousUrl: string, proxyUrl: string): void {
	const previous = normalizeServerUrl(previousUrl);
	const proxy = normalizeServerUrl(proxyUrl);
	if (!previous || !proxy || previous === proxy || proxyPort(proxy) === null) {
		throw new Error('Invalid private tunnel connection');
	}
	try {
		localStorage.setItem(PREVIOUS_URL_KEY, previous);
		localStorage.setItem(PREVIOUS_REMEMBER_KEY, String(getConfiguredServerRememberPreference()));
		localStorage.setItem(PROXY_URL_KEY, proxy);
	} catch {
		clearTailcatConnection();
		throw new Error('Could not save the previous server address');
	}
}

export function clearTailcatConnection(): void {
	try {
		localStorage.removeItem(PREVIOUS_URL_KEY);
		localStorage.removeItem(PREVIOUS_REMEMBER_KEY);
		localStorage.removeItem(PROXY_URL_KEY);
	} catch {
		// Storage is best effort during shutdown.
	}
}

export function isCurrentTailcatProxy(): boolean {
	try {
		const proxy = localStorage.getItem(PROXY_URL_KEY);
		return !!proxy && proxyPort(proxy) !== null && getConfiguredServerUrl() === proxy;
	} catch {
		return false;
	}
}

export function restoreTailcatConnection(): boolean {
	try {
		const previous = normalizeServerUrl(localStorage.getItem(PREVIOUS_URL_KEY) || '');
		if (!previous) return false;
		const proxy = localStorage.getItem(PROXY_URL_KEY);
		const configured = getConfiguredServerUrl();
		if (proxy && configured && configured !== proxy) {
			// The member selected another server while the tunnel was running.
			clearTailcatConnection();
			return true;
		}
		const remember = localStorage.getItem(PREVIOUS_REMEMBER_KEY) === 'true';
		setConfiguredServerUrl(previous, remember);
		clearTailcatConnection();
		return true;
	} catch {
		return false;
	}
}

/** Return to the saved address only when this app's own proxy disappeared. */
export async function recoverStoppedTailcatConnection(
	status: () => Promise<{ connected: boolean; proxyPort: number | null }>
): Promise<boolean> {
	let proxy: string | null;
	try {
		proxy = localStorage.getItem(PROXY_URL_KEY);
	} catch {
		return false;
	}
	if (!proxy || proxyPort(proxy) === null) return false;
	const configured = getConfiguredServerUrl();
	if (configured && configured !== proxy) return false;
	try {
		const tunnel = await status();
		if (tunnel.connected && tunnel.proxyPort === proxyPort(proxy)) {
			if (configured) return false;
			setConfiguredServerUrl(proxy, false);
			return true;
		}
	} catch {
		// An unavailable native command is not proof that the tunnel stopped.
		return false;
	}
	return restoreTailcatConnection();
}
