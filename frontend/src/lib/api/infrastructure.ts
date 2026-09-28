import { getApiBase, fetchWithTimeout, safeJsonParse } from './utils';
export async function infrastructureRequest<T>(token: string | null | undefined, path: string, init?: RequestInit): Promise<T> {
    const response = await fetchWithTimeout(`${getApiBase()}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init?.headers } });
    const data = await safeJsonParse(response);
    if (!response.ok) throw new Error((data as { error?: string } | null)?.error || `Request failed (${response.status})`);
    return data as T;
}
export interface NetworkHealth {
    observedAt: string; sampleSeconds: number | null; processMemoryBytes: number | null;
    processCpuPercent: number | null; httpRequestsTotal: number; uptimeSeconds: number;
    interfaces: { name: string; receivedBytes: number; sentBytes: number; receivedBytesPerSecond: number | null; sentBytesPerSecond: number | null }[];
}
export interface HelperNode {
    nodeId: string; displayName: string; capabilities: string[]; status: string; reachability: string;
    lastHeartbeatAt: string | null; endpoint: string | null;
    load: { cpuPercent: number | null; memoryUsedMb: number | null; uploadMbps: number | null };
}
