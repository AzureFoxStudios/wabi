import { browser } from '$app/environment';
import { getServerUrl } from '$lib/serverUrl';
import type { PluginListItem } from './manifest';

const baseUrl = getServerUrl();

function buildHeaders(): HeadersInit {
	const headers: HeadersInit = { 'Content-Type': 'application/json' };
	if (!browser) return headers;

	const token = localStorage.getItem('authToken');
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	return headers;
}

async function parseResponse<T>(res: Response, fallbackMessage: string): Promise<T> {
	if (!res.ok) {
		const body = await res.text();
		throw new Error(body || fallbackMessage);
	}
	return res.json() as Promise<T>;
}

export async function fetchPlugins(): Promise<PluginListItem[]> {
	const res = await fetch(`${baseUrl}/api/plugins`, {
		method: 'GET',
		headers: buildHeaders()
	});

	const payload = await parseResponse<{ plugins: PluginListItem[] } | PluginListItem[]>(
		res,
		'Failed to fetch plugins'
	);

	if (Array.isArray(payload)) return payload;
	return payload.plugins;
}

export async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
	const endpoint = enabled ? 'enable' : 'disable';
	const res = await fetch(`${baseUrl}/api/plugins/${encodeURIComponent(pluginId)}/${endpoint}`, {
		method: 'POST',
		headers: buildHeaders()
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(body || `Failed to ${endpoint} plugin`);
	}
}

export async function requestPluginReload(pluginId: string): Promise<void> {
	const res = await fetch(`${baseUrl}/api/plugins/${encodeURIComponent(pluginId)}/reload`, {
		method: 'POST',
		headers: buildHeaders()
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(body || 'Failed to reload plugin');
	}
}
