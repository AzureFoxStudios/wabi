export interface EndpointHealth {
	role: 'authority' | 'anchor';
	status: 'ok' | 'degraded';
}

export function parseEndpointHealth(value: unknown): EndpointHealth {
	if (!value || typeof value !== 'object') throw new Error('Endpoint did not return Wabi health');
	const record = value as Record<string, unknown>;
	if (record.service !== 'wabi-server' || (record.role !== 'authority' && record.role !== 'anchor') ||
		(record.status !== 'ok' && record.status !== 'degraded')) {
		throw new Error('Endpoint did not return a recognized Wabi role');
	}
	return { role: record.role, status: record.status };
}

/** Read the selected entry point itself. Anchor proxies other API routes to Authority. */
export async function readEndpointHealth(serverUrl: string): Promise<EndpointHealth> {
	const response = await fetch(`${serverUrl.replace(/\/+$/, '')}/health`, {
		cache: 'no-store',
		signal: AbortSignal.timeout(5000)
	});
	return parseEndpointHealth(await response.json());
}
