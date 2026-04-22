export interface StatePlaneConfig {
	stdbSubscriptionsEnabled: boolean;
	enforceRbac: boolean;
	outboxPath: string | null;
	outboxRedactSensitive: boolean;
	outboxMaxBytes: number;
	outboxTruncateMinBytes: number;
	planeSchemaVersion: number;
	planeSchemaAutoApply: boolean;
	reducerIngressEnabled: boolean;
	reducerIngressRequireSignature: boolean;
	reducerIngressMaxSkewMs: number;
	reducerIngressMaxBodyBytes: number;
	reducerIngressBearerToken: string | null;
	reducerIngressSigningSecret: string | null;
	reducerIngressSigningKeyId: string | null;
}

function normalizeBool(value: string | undefined, fallback: boolean): boolean {
	if (value == null) return fallback;
	const raw = value.trim().toLowerCase();
	if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
	if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
	return fallback;
}

function normalizePositiveInt(value: string | undefined, fallback: number, min: number, max: number): number {
	if (value == null || value.trim().length === 0) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalizeOptional(value: string | undefined): string | null {
	if (value == null) return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function getStatePlaneConfigFromEnv(): StatePlaneConfig {
	const outboxMaxBytes = normalizePositiveInt(process.env.STATE_OUTBOX_MAX_BYTES, 64 * 1024 * 1024, 1024 * 1024, 1024 * 1024 * 1024);
	const outboxTruncateMinBytes = normalizePositiveInt(
		process.env.STATE_OUTBOX_TRUNCATE_MIN_BYTES,
		16 * 1024 * 1024,
		1024 * 1024,
		outboxMaxBytes
	);

	return {
		stdbSubscriptionsEnabled: normalizeBool(process.env.STATE_STDB_SUBSCRIPTIONS_ENABLED, false),
		enforceRbac: normalizeBool(process.env.STATE_STDB_ENFORCE_RBAC, true),
		outboxPath: normalizeOptional(process.env.STATE_OUTBOX_PATH),
		outboxRedactSensitive: normalizeBool(process.env.STATE_OUTBOX_REDACT_SENSITIVE, true),
		outboxMaxBytes,
		outboxTruncateMinBytes,
		planeSchemaVersion: normalizePositiveInt(process.env.STATE_PLANE_SCHEMA_VERSION, 1, 1, 1000),
		planeSchemaAutoApply: normalizeBool(process.env.STATE_PLANE_SCHEMA_AUTO_APPLY, true),
		reducerIngressEnabled: normalizeBool(process.env.STATE_REDUCER_INGRESS_ENABLED, false),
		reducerIngressRequireSignature: normalizeBool(process.env.STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE, true),
		reducerIngressMaxSkewMs: normalizePositiveInt(process.env.STATE_REDUCER_INGRESS_MAX_SKEW_MS, 300000, 1000, 3600000),
		reducerIngressMaxBodyBytes: normalizePositiveInt(process.env.STATE_REDUCER_INGRESS_MAX_BODY_BYTES, 1048576, 4096, 16777216),
		reducerIngressBearerToken: normalizeOptional(process.env.STATE_REDUCER_INGRESS_BEARER_TOKEN),
		reducerIngressSigningSecret: normalizeOptional(process.env.STATE_REDUCER_INGRESS_SIGNING_SECRET),
		reducerIngressSigningKeyId: normalizeOptional(process.env.STATE_REDUCER_INGRESS_SIGNING_KEY_ID)
	};
}
