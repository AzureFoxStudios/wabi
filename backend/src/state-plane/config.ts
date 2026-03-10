export type StateBackendMode = 'legacy' | 'dual_write' | 'stdb_primary';

export interface StatePlaneConfig {
	mode: StateBackendMode;
	stdbReadEnabled: boolean;
	stdbMessageReadCanaryPercent: number;
	stdbChannelReadCanaryPercent: number;
	stdbChannelMemberReadCanaryPercent: number;
	stdbUserReadCanaryPercent: number;
	stdbSessionReadCanaryPercent: number;
	stdbRbacReadCanaryPercent: number;
	stdbWriteEnabled: boolean;
	stdbSubscriptionsEnabled: boolean;
	enforceRbac: boolean;
	strictMode: boolean;
	shadowWarmupEnabled: boolean;
	shadowWarmupLimit: number;
	outboxPath: string | null;
	outboxRedactSensitive: boolean;
	outboxMaxBytes: number;
	outboxTruncateMinBytes: number;
	shadowWriterEnabled: boolean;
	shadowSink: 'mirror' | 'http' | 'command' | 'stdb';
	shadowEndpoint: string | null;
	shadowToken: string | null;
	shadowSigningSecret: string | null;
	shadowSigningKeyId: string | null;
	shadowCommand: string | null;
	shadowCommandTimeoutMs: number;
	planeSchemaVersion: number;
	planeSchemaAutoApply: boolean;
	reducerIngressEnabled: boolean;
	reducerIngressRequireSignature: boolean;
	reducerIngressMaxSkewMs: number;
	reducerIngressMaxBodyBytes: number;
	shadowPollIntervalMs: number;
	shadowBatchSize: number;
}

function normalizeBool(value: string | undefined, fallback: boolean): boolean {
	if (value == null) return fallback;
	const raw = value.trim().toLowerCase();
	if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
	if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
	return fallback;
}

function normalizeMode(value: string | undefined): StateBackendMode {
	const raw = (value || '').trim().toLowerCase();
	if (raw === 'dual_write' || raw === 'dual-write' || raw === 'dual') return 'dual_write';
	if (raw === 'stdb_primary' || raw === 'stdb-primary' || raw === 'stdb') return 'stdb_primary';
	return 'legacy';
}

function normalizePositiveInt(value: string | undefined, fallback: number, min: number, max: number): number {
	if (value == null || value.trim().length === 0) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalizeShadowSink(value: string | undefined): 'mirror' | 'http' | 'command' | 'stdb' {
	const raw = (value || '').trim().toLowerCase();
	if (raw === 'http') return 'http';
	if (raw === 'command' || raw === 'cmd') return 'command';
	if (raw === 'stdb' || raw === 'spacetime' || raw === 'spacetimedb') return 'stdb';
	return 'mirror';
}

function normalizeOptional(value: string | undefined): string | null {
	if (value == null) return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function getStatePlaneConfigFromEnv(): StatePlaneConfig {
	const mode = normalizeMode(process.env.STATE_BACKEND_MODE);
	const stdbWriteEnabled = normalizeBool(process.env.STATE_STDB_WRITE_ENABLED, false);
	const shadowWriterEnabled = normalizeBool(
		process.env.STATE_SHADOW_WRITER_ENABLED,
		mode === 'dual_write' && stdbWriteEnabled
	);
	const stdbReadCanaryDefault = normalizePositiveInt(process.env.STATE_STDB_MESSAGE_READ_CANARY_PERCENT, 10, 0, 100);
	const outboxMaxBytes = normalizePositiveInt(process.env.STATE_OUTBOX_MAX_BYTES, 64 * 1024 * 1024, 1024 * 1024, 1024 * 1024 * 1024);
	const outboxTruncateMinBytes = normalizePositiveInt(
		process.env.STATE_OUTBOX_TRUNCATE_MIN_BYTES,
		16 * 1024 * 1024,
		1024 * 1024,
		outboxMaxBytes
	);

	return {
		mode,
		stdbReadEnabled: normalizeBool(process.env.STATE_STDB_READ_ENABLED, false),
		stdbMessageReadCanaryPercent: stdbReadCanaryDefault,
		stdbChannelReadCanaryPercent: normalizePositiveInt(
			process.env.STATE_STDB_CHANNEL_READ_CANARY_PERCENT,
			stdbReadCanaryDefault,
			0,
			100
		),
		stdbChannelMemberReadCanaryPercent: normalizePositiveInt(
			process.env.STATE_STDB_CHANNEL_MEMBER_READ_CANARY_PERCENT,
			stdbReadCanaryDefault,
			0,
			100
		),
		stdbUserReadCanaryPercent: normalizePositiveInt(
			process.env.STATE_STDB_USER_READ_CANARY_PERCENT,
			stdbReadCanaryDefault,
			0,
			100
		),
		stdbSessionReadCanaryPercent: normalizePositiveInt(
			process.env.STATE_STDB_SESSION_READ_CANARY_PERCENT,
			stdbReadCanaryDefault,
			0,
			100
		),
		stdbRbacReadCanaryPercent: normalizePositiveInt(
			process.env.STATE_STDB_RBAC_READ_CANARY_PERCENT,
			stdbReadCanaryDefault,
			0,
			100
		),
		stdbWriteEnabled,
		stdbSubscriptionsEnabled: normalizeBool(process.env.STATE_STDB_SUBSCRIPTIONS_ENABLED, false),
		enforceRbac: normalizeBool(process.env.STATE_STDB_ENFORCE_RBAC, true),
		strictMode: normalizeBool(process.env.STATE_BACKEND_STRICT, false),
		shadowWarmupEnabled: normalizeBool(process.env.STATE_SHADOW_WARMUP_ENABLED, true),
		shadowWarmupLimit: normalizePositiveInt(process.env.STATE_SHADOW_WARMUP_LIMIT, 25000, 100, 500000),
		outboxPath: normalizeOptional(process.env.STATE_OUTBOX_PATH),
		outboxRedactSensitive: normalizeBool(process.env.STATE_OUTBOX_REDACT_SENSITIVE, true),
		outboxMaxBytes,
		outboxTruncateMinBytes,
		shadowWriterEnabled,
		shadowSink: normalizeShadowSink(process.env.STATE_SHADOW_SINK),
		shadowEndpoint: normalizeOptional(process.env.STATE_SHADOW_ENDPOINT),
		shadowToken: normalizeOptional(process.env.STATE_SHADOW_TOKEN),
		shadowSigningSecret: normalizeOptional(process.env.STATE_SHADOW_SIGNING_SECRET),
		shadowSigningKeyId: normalizeOptional(process.env.STATE_SHADOW_SIGNING_KEY_ID),
		shadowCommand: normalizeOptional(process.env.STATE_SHADOW_COMMAND),
		shadowCommandTimeoutMs: normalizePositiveInt(process.env.STATE_SHADOW_COMMAND_TIMEOUT_MS, 10000, 100, 300000),
		planeSchemaVersion: normalizePositiveInt(process.env.STATE_PLANE_SCHEMA_VERSION, 1, 1, 1000),
		planeSchemaAutoApply: normalizeBool(process.env.STATE_PLANE_SCHEMA_AUTO_APPLY, true),
		reducerIngressEnabled: normalizeBool(process.env.STATE_REDUCER_INGRESS_ENABLED, false),
		reducerIngressRequireSignature: normalizeBool(process.env.STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE, true),
		reducerIngressMaxSkewMs: normalizePositiveInt(process.env.STATE_REDUCER_INGRESS_MAX_SKEW_MS, 300000, 1000, 3600000),
		reducerIngressMaxBodyBytes: normalizePositiveInt(process.env.STATE_REDUCER_INGRESS_MAX_BODY_BYTES, 1048576, 4096, 16777216),
		shadowPollIntervalMs: normalizePositiveInt(process.env.STATE_SHADOW_POLL_INTERVAL_MS, 1000, 250, 60000),
		shadowBatchSize: normalizePositiveInt(process.env.STATE_SHADOW_BATCH_SIZE, 250, 1, 5000)
	};
}
