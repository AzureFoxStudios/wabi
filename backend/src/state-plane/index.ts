import { getStatePlaneConfigFromEnv, type StateBackendMode, type StatePlaneConfig } from './config.js';
import {
	DualWriteMessageStore,
	InMemoryShadowMessageStore,
	LegacyMessageStore,
	getMessageStoreRuntimeStats,
	type MessageStoreRuntimeStats,
	type MessageStore
} from './messageStore.js';
import { StdbPrimaryMessageStore } from './stdbMessageStore.js';
import { StatePlaneOutbox } from './outbox.js';
import { StateChannelStore } from './channelStore.js';
import { StdbPrimaryChannelStore } from './stdbChannelStore.js';
import { StateChannelMemberStore } from './channelMemberStore.js';
import { StdbPrimaryChannelMemberStore } from './stdbChannelMemberStore.js';
import { StateUserStore } from './userStore.js';
import { StdbPrimaryUserStore } from './stdbUserStore.js';
import { StateSessionStore } from './sessionStore.js';
import { StdbPrimarySessionStore } from './stdbSessionStore.js';
import { StateRbacStore } from './rbacStore.js';
import { StdbPrimaryRbacStore } from './stdbRbacStore.js';
import { createStdbClient } from './stdbCommon.js';
import { StatePlaneShadowWriter } from './shadowWriter.js';
import { StatePlaneWatchdog } from './watchdog.js';
import { StatePlaneReducerIngress } from './reducerIngress.js';
import { StatePlaneSchemaVersionManager } from './schemaVersion.js';
import type { StatePlaneAdapter, StatePlaneRuntimeStats, StatePlaneWarmupStats } from './adapter.js';

export { getStatePlaneConfigFromEnv };
export type { StateBackendMode, StatePlaneConfig } from './config.js';
export type { MessageStore, MessageStoreRuntimeStats } from './messageStore.js';
export type { StatePlaneAdapter, StatePlaneRuntimeStats, StatePlaneEventEntity } from './adapter.js';

type EffectiveStateBackendMode = 'legacy' | 'dual_write' | 'stdb_primary';

interface StateBackendResolution {
	requestedMode: StateBackendMode;
	effectiveMode: EffectiveStateBackendMode;
	fallbackReason: string | null;
}

interface StdbPrimaryReadiness {
	ready: boolean;
	reason: string | null;
}

const statePlaneConfig = getStatePlaneConfigFromEnv();

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
	if (value == null) return fallback;
	const normalized = value.trim().toLowerCase();
	if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
	if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
	return fallback;
}

function checkStdbPrimaryReadiness(config: StatePlaneConfig): StdbPrimaryReadiness {
	if (!config.stdbWriteEnabled) {
		return {
			ready: false,
			reason: 'STATE_STDB_WRITE_ENABLED=false'
		};
	}
	if (!config.stdbReadEnabled) {
		return {
			ready: false,
			reason: 'STATE_STDB_READ_ENABLED=false'
		};
	}

	const client = createStdbClient();
	const runtime = client.getRuntimeStats();
	if (!runtime.enabled) {
		const missing: string[] = [];
		if (!runtime.server) missing.push('WABI_STDB_BRIDGE_SERVER');
		if (!runtime.database) missing.push('WABI_STDB_BRIDGE_DATABASE');
		if (!runtime.helperPath) missing.push('backend/scripts/state-plane-stdb-http.mjs');
		return {
			ready: false,
			reason: `STDB client not configured (${missing.join(', ')})`
		};
	}
	if (process.env.NODE_ENV === 'production') {
		const allowAnonymousProd = boolFromEnv(process.env.WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION, false);
		if (runtime.authMode !== 'token' && !allowAnonymousProd) {
			return {
				ready: false,
				reason:
					'STDB production mode requires WABI_STDB_AUTH_TOKEN (set WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION=true to override)'
			};
		}
	}

	return {
		ready: true,
		reason: null
	};
}

const stdbPrimaryReadiness = checkStdbPrimaryReadiness(statePlaneConfig);

function resolveStateBackendMode(): StateBackendResolution {
	const requestedMode = statePlaneConfig.mode;

	if (requestedMode === 'legacy') {
		return {
			requestedMode,
			effectiveMode: 'legacy',
			fallbackReason: null
		};
	}

	if (requestedMode === 'dual_write') {
		if (statePlaneConfig.stdbWriteEnabled) {
			return {
				requestedMode,
				effectiveMode: 'dual_write',
				fallbackReason: null
			};
		}
		return {
			requestedMode,
			effectiveMode: 'legacy',
			fallbackReason:
				'STATE_BACKEND_MODE=dual_write requested but STATE_STDB_WRITE_ENABLED=false; using legacy mode.'
		};
	}

	if (stdbPrimaryReadiness.ready) {
		return {
			requestedMode,
			effectiveMode: 'stdb_primary',
			fallbackReason: null
		};
	}

	const reason = stdbPrimaryReadiness.reason || 'unknown_stdb_primary_readiness_failure';
	if (statePlaneConfig.strictMode) {
		throw new Error(
			`STATE_BACKEND_MODE=stdb_primary requested but prerequisites were not met (${reason}) and strict mode is enabled`
		);
	}

	if (statePlaneConfig.stdbWriteEnabled) {
		return {
			requestedMode,
			effectiveMode: 'dual_write',
			fallbackReason:
				`STATE_BACKEND_MODE=stdb_primary requested but prerequisites were not met (${reason}); using dual_write preflight because STATE_STDB_WRITE_ENABLED=true.`
		};
	}

	return {
		requestedMode,
		effectiveMode: 'legacy',
		fallbackReason:
			`STATE_BACKEND_MODE=stdb_primary requested but prerequisites were not met (${reason}); using legacy mode because STATE_STDB_WRITE_ENABLED=false.`
	};
}

const backendModeResolution = resolveStateBackendMode();
const stdbPrimaryActive = backendModeResolution.effectiveMode === 'stdb_primary';
const dualWriteActive = backendModeResolution.effectiveMode === 'dual_write';
const shadowMirrorEnabled = stdbPrimaryActive;
const sharedOutbox = dualWriteActive || stdbPrimaryActive
	? new StatePlaneOutbox({
		path: statePlaneConfig.outboxPath || undefined,
		redactSensitive: statePlaneConfig.outboxRedactSensitive
	})
	: null;

function createMessageStore(config = statePlaneConfig): MessageStore {
	if (stdbPrimaryActive) {
		console.log('[StatePlane] Message store mode: stdb_primary (SpacetimeDB source of truth + legacy mirror writes)');
		return new StdbPrimaryMessageStore({
			outbox: sharedOutbox,
			mirrorLegacyWrites: shadowMirrorEnabled
		});
	}

	if (dualWriteActive) {
		const readCanaryEnabled = config.stdbReadEnabled && config.stdbMessageReadCanaryPercent > 0;
		console.log(
			`[StatePlane] Message store mode: dual_write (legacy primary + in-memory shadow + outbox, read_canary=${readCanaryEnabled ? `${config.stdbMessageReadCanaryPercent}%` : 'off'})`
		);
		return new DualWriteMessageStore(
			new LegacyMessageStore(),
			new InMemoryShadowMessageStore(),
			{
				label: 'in-memory-shadow',
				paritySampleRate: 0.1,
				outbox: sharedOutbox,
				strictShadow: config.strictMode,
				readShadowEnabled: config.stdbReadEnabled,
				readCanaryPercent: config.stdbMessageReadCanaryPercent
			}
		);
	}

	console.log('[StatePlane] Message store mode: legacy');
	return new LegacyMessageStore();
}

export const stateMessageStore = createMessageStore();

console.log(
	`[StatePlane] Backend mode requested=${backendModeResolution.requestedMode} effective=${backendModeResolution.effectiveMode}`
);
if (backendModeResolution.fallbackReason) {
	console.warn(`[StatePlane] ${backendModeResolution.fallbackReason}`);
}

if (dualWriteActive) {
	if (statePlaneConfig.stdbReadEnabled) {
		console.log(
			`[StatePlane] Read canary rollout: message=${statePlaneConfig.stdbMessageReadCanaryPercent}% channel=${statePlaneConfig.stdbChannelReadCanaryPercent}% channel_member=${statePlaneConfig.stdbChannelMemberReadCanaryPercent}% user=${statePlaneConfig.stdbUserReadCanaryPercent}% session=${statePlaneConfig.stdbSessionReadCanaryPercent}% rbac=${statePlaneConfig.stdbRbacReadCanaryPercent}%`
		);
	} else {
		console.log('[StatePlane] Read canary rollout: disabled (STATE_STDB_READ_ENABLED=false)');
	}
}

if (stdbPrimaryActive) {
	console.log(
		`[StatePlane] STDB primary routing enabled read=${statePlaneConfig.stdbReadEnabled} write=${statePlaneConfig.stdbWriteEnabled} subscriptions=${statePlaneConfig.stdbSubscriptionsEnabled}`
	);
	if (statePlaneConfig.stdbSubscriptionsEnabled) {
		console.log(
			'[StatePlane] STDB subscription bridge mode: backend remains realtime event source; external STDB writes converge through backend read-on-demand (no direct socket fanout from STDB).'
		);
	}
}

export const stateChannelStore = stdbPrimaryActive
	? new StdbPrimaryChannelStore({
		outbox: sharedOutbox,
		mirrorLegacyWrites: shadowMirrorEnabled
	})
	: new StateChannelStore(sharedOutbox, {
		dualWriteEnabled: dualWriteActive,
		label: 'channel-shadow',
		paritySampleRate: 0.1,
		strictShadow: statePlaneConfig.strictMode,
		readShadowEnabled: statePlaneConfig.stdbReadEnabled,
		readCanaryPercent: statePlaneConfig.stdbChannelReadCanaryPercent
	});

export const stateChannelMemberStore = stdbPrimaryActive
	? new StdbPrimaryChannelMemberStore({
		outbox: sharedOutbox,
		mirrorLegacyWrites: shadowMirrorEnabled
	})
	: new StateChannelMemberStore(sharedOutbox, {
		dualWriteEnabled: dualWriteActive,
		label: 'channel-member-shadow',
		paritySampleRate: 0.1,
		strictShadow: statePlaneConfig.strictMode,
		readShadowEnabled: statePlaneConfig.stdbReadEnabled,
		readCanaryPercent: statePlaneConfig.stdbChannelMemberReadCanaryPercent
	});

export const stateUserStore = stdbPrimaryActive
	? new StdbPrimaryUserStore({
		outbox: sharedOutbox,
		mirrorLegacyWrites: shadowMirrorEnabled
	})
	: new StateUserStore(sharedOutbox, {
		dualWriteEnabled: dualWriteActive,
		label: 'user-shadow',
		paritySampleRate: 0.1,
		strictShadow: statePlaneConfig.strictMode,
		readShadowEnabled: statePlaneConfig.stdbReadEnabled,
		readCanaryPercent: statePlaneConfig.stdbUserReadCanaryPercent
	});

export const stateSessionStore = stdbPrimaryActive
	? new StdbPrimarySessionStore({
		outbox: sharedOutbox,
		mirrorLegacyWrites: shadowMirrorEnabled
	})
	: new StateSessionStore(sharedOutbox, {
		dualWriteEnabled: dualWriteActive,
		label: 'session-shadow',
		paritySampleRate: 0.1,
		strictShadow: statePlaneConfig.strictMode,
		readShadowEnabled: statePlaneConfig.stdbReadEnabled,
		readCanaryPercent: statePlaneConfig.stdbSessionReadCanaryPercent
	});

export const stateRbacStore = stdbPrimaryActive
	? new StdbPrimaryRbacStore({
		outbox: sharedOutbox,
		mirrorLegacyWrites: shadowMirrorEnabled
	})
	: new StateRbacStore(sharedOutbox, {
		dualWriteEnabled: dualWriteActive,
		label: 'rbac-shadow',
		paritySampleRate: 0.1,
		strictShadow: statePlaneConfig.strictMode,
		readShadowEnabled: statePlaneConfig.stdbReadEnabled,
		readCanaryPercent: statePlaneConfig.stdbRbacReadCanaryPercent
	});

const statePlaneWarmupStats: StatePlaneWarmupStats = {
	enabled: dualWriteActive && statePlaneConfig.shadowWarmupEnabled,
	running: false,
	startedAt: null,
	completedAt: null,
	success: null,
	lastError: null,
	limit: statePlaneConfig.shadowWarmupLimit,
	counts: {
		channels: 0,
		channelMembers: 0,
		users: 0,
		sessions: 0,
		rbacAssignments: 0
	}
};

function runStatePlaneWarmup(): void {
	if (!statePlaneWarmupStats.enabled) return;
	if (statePlaneWarmupStats.running) return;
	if (statePlaneWarmupStats.completedAt != null) return;

	statePlaneWarmupStats.running = true;
	statePlaneWarmupStats.startedAt = Date.now();
	statePlaneWarmupStats.lastError = null;
	statePlaneWarmupStats.success = null;
	const limit = statePlaneWarmupStats.limit;

	try {
		statePlaneWarmupStats.counts.channels = stateChannelStore.warmFromPrimary(limit);
		statePlaneWarmupStats.counts.channelMembers = stateChannelMemberStore.warmFromPrimary(limit);
		statePlaneWarmupStats.counts.users = stateUserStore.warmFromPrimary(limit);
		statePlaneWarmupStats.counts.sessions = stateSessionStore.warmFromPrimary(limit);
		statePlaneWarmupStats.counts.rbacAssignments = stateRbacStore.warmFromPrimary(limit);
		statePlaneWarmupStats.success = true;
		console.log(
			`[StatePlane] Shadow warmup complete channels=${statePlaneWarmupStats.counts.channels} members=${statePlaneWarmupStats.counts.channelMembers} users=${statePlaneWarmupStats.counts.users} sessions=${statePlaneWarmupStats.counts.sessions} rbac=${statePlaneWarmupStats.counts.rbacAssignments} limit=${limit}`
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		statePlaneWarmupStats.lastError = message;
		statePlaneWarmupStats.success = false;
		console.warn(`[StatePlane] Shadow warmup failed: ${message}`);
		if (statePlaneConfig.strictMode) {
			throw error instanceof Error ? error : new Error(message);
		}
	} finally {
		statePlaneWarmupStats.running = false;
		statePlaneWarmupStats.completedAt = Date.now();
	}
}

export const stateShadowWriter = new StatePlaneShadowWriter(statePlaneConfig);
export const stateReducerIngress = new StatePlaneReducerIngress(statePlaneConfig);
export const stateSchemaVersion = new StatePlaneSchemaVersionManager(statePlaneConfig);
export const statePlaneWatchdog = new StatePlaneWatchdog({
	enabled: dualWriteActive,
	getRuntimeStats: () => getStatePlaneRuntimeStats(),
	recordEvent: (operation, payload) => {
		recordStatePlaneEvent('system', operation, payload);
	}
});

export function getStateMessageStoreRuntimeStats(): MessageStoreRuntimeStats | null {
	return getMessageStoreRuntimeStats(stateMessageStore);
}

export function getStatePlaneRuntimeStats(): StatePlaneRuntimeStats {
	return {
		config: {
			...statePlaneConfig,
			shadowToken: statePlaneConfig.shadowToken ? 'configured' : null,
			shadowSigningSecret: statePlaneConfig.shadowSigningSecret ? 'configured' : null,
			shadowCommand: statePlaneConfig.shadowCommand ? 'configured' : null,
			effectiveMode: backendModeResolution.effectiveMode,
			modeFallbackReason: backendModeResolution.fallbackReason
		},
		messageStore: getStateMessageStoreRuntimeStats(),
		channelStore: stateChannelStore.getRuntimeStats(),
		channelMemberStore: stateChannelMemberStore.getRuntimeStats(),
		userStore: stateUserStore.getRuntimeStats(),
		sessionStore: stateSessionStore.getRuntimeStats(),
		rbacStore: stateRbacStore.getRuntimeStats(),
		shadowWriter: stateShadowWriter.getStats(),
		watchdog: statePlaneWatchdog.getStats(),
		reducerIngress: stateReducerIngress.getStats(),
		schema: stateSchemaVersion.getStats(),
		outbox: sharedOutbox?.getStats() || null,
		warmup: {
			...statePlaneWarmupStats,
			counts: { ...statePlaneWarmupStats.counts }
		}
	};
}

export function startStatePlaneRuntime(): void {
	stateSchemaVersion.reconcile();
	const schemaStats = stateSchemaVersion.getStats();
	if (schemaStats.mismatch) {
		const reason = schemaStats.reason || 'schema_mismatch';
		const message = `[StatePlane] Schema version mismatch: ${reason}`;
		if (statePlaneConfig.strictMode) {
			throw new Error(message);
		}
		console.warn(message);
	}
	runStatePlaneWarmup();
	stateShadowWriter.start();
	statePlaneWatchdog.start();
}

export function stopStatePlaneRuntime(): void {
	statePlaneWatchdog.stop();
	stateShadowWriter.stop();
}

export function recordStatePlaneEvent(
	entity: 'presence' | 'system',
	operation: string,
	payload: Record<string, unknown>
): void {
	sharedOutbox?.append({
		timestamp: Date.now(),
		entity,
		operation,
		payload
	});
}

export const statePlaneAdapter: StatePlaneAdapter = {
	config: statePlaneConfig,
	start: startStatePlaneRuntime,
	stop: stopStatePlaneRuntime,
	getRuntimeStats: getStatePlaneRuntimeStats,
	recordEvent: recordStatePlaneEvent
};
