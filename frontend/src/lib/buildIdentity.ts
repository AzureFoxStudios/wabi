export interface ServerBuildIdentity { version: string; sourceRevision: string | null }
export function parseServerBuildIdentity(value: unknown): ServerBuildIdentity | null {
	if (!value || typeof value !== 'object') return null;
	const row = value as Record<string, unknown>;
	if (row.schemaVersion !== 1 || row.component !== 'wabi-server' || typeof row.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(row.version)) return null;
	if (row.sourceRevision !== null && (typeof row.sourceRevision !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(row.sourceRevision))) return null;
	return { version: row.version, sourceRevision: row.sourceRevision as string | null };
}
