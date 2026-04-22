import { getStatePlaneConfigFromEnv, type StatePlaneConfig } from './config.js';
import {
	getMessageStoreRuntimeStats,
	type MessageStoreRuntimeStats,
	type MessageStore
} from './messageStore.js';
import { StdbPrimaryMessageStore } from './stdbMessageStore.js';
import { StatePlaneOutbox } from './outbox.js';
import { StdbPrimaryChannelStore } from './stdbChannelStore.js';
import { StdbPrimaryChannelMemberStore } from './stdbChannelMemberStore.js';
import { StdbPrimaryUserStore } from './stdbUserStore.js';
import { StdbPrimarySessionStore } from './stdbSessionStore.js';
import { StdbPrimaryRbacStore } from './stdbRbacStore.js';
import { createStdbClient } from './stdbCommon.js';
import { StatePlaneReducerIngress } from './reducerIngress.js';
import { StatePlaneSchemaVersionManager } from './schemaVersion.js';
import {
	configureStateMeshRuntime,
	getStateMeshRuntimeStats,
	startStateMeshRuntime,
	stopStateMeshRuntime,
	registerStateMeshSocketLease,
	releaseStateMeshSocketLease,
	findStateMeshSocketLeaseByStableUserId,
	getCurrentStateMeshInstanceId,
	findStateMeshInstanceLeaseById,
	listActiveStateMeshInstanceLeases,
	sendStateMeshRemoteDelivery,
	upsertStateMeshPresenceLease,
	deleteStateMeshPresenceLease,
	listStateMeshPresenceLeases
} from './meshRuntime.js';
import type { StatePlaneAdapter, StatePlaneRuntimeStats } from './adapter.js';

export { getStatePlaneConfigFromEnv };
export type { StatePlaneConfig } from './config.js';
export type { MessageStore, MessageStoreRuntimeStats } from './messageStore.js';
export type { StatePlaneAdapter, StatePlaneRuntimeStats, StatePlaneEventEntity } from './adapter.js';

const statePlaneConfig = getStatePlaneConfigFromEnv();

function assertStdbClientReady(): void {
	const client = createStdbClient();
	const runtime = client.getRuntimeStats();
	if (!runtime.enabled) {
		const missing: string[] = [];
		if (!runtime.server) missing.push('WABI_STDB_BRIDGE_SERVER');
		if (!runtime.database) missing.push('WABI_STDB_BRIDGE_DATABASE');
		if (!runtime.helperPath) missing.push('backend/scripts/state-plane-stdb-http.mjs');
		throw new Error(`[StatePlane] STDB client not configured (${missing.join(', ')})`);
	}
	if (process.env.NODE_ENV === 'production' && runtime.authMode !== 'token') {
		throw new Error(
			'[StatePlane] STDB production mode requires WABI_STDB_AUTH_TOKEN — anonymous access is not allowed in production'
		);
	}
	const probe = client.probeConnectivity(Math.min(client.getTimeoutMs(), 1500));
	if (!probe.ok) {
		console.warn(`[StatePlane] STDB bridge probe failed at startup (${probe.reason || 'unknown'}); will retry on first call`);
	}
}

assertStdbClientReady();

const sharedOutbox = new StatePlaneOutbox({
	path: statePlaneConfig.outboxPath || undefined,
	redactSensitive: statePlaneConfig.outboxRedactSensitive
});

export const stateMessageStore: MessageStore = new StdbPrimaryMessageStore({
	outbox: sharedOutbox
});

console.log(
	`[StatePlane] Message store: stdb_primary (SpacetimeDB source of truth)`
);
console.log(
	`[StatePlane] subscriptions=${statePlaneConfig.stdbSubscriptionsEnabled} rbac=${statePlaneConfig.enforceRbac}`
);
if (statePlaneConfig.stdbSubscriptionsEnabled) {
	console.log(
		'[StatePlane] STDB subscription bridge mode: backend remains realtime event source; external STDB writes converge through backend read-on-demand (no direct socket fanout from STDB).'
	);
}

export const stateChannelStore = new StdbPrimaryChannelStore({ outbox: sharedOutbox });
export const stateChannelMemberStore = new StdbPrimaryChannelMemberStore({ outbox: sharedOutbox });
export const stateUserStore = new StdbPrimaryUserStore({ outbox: sharedOutbox });
export const stateSessionStore = new StdbPrimarySessionStore({ outbox: sharedOutbox });
export const stateRbacStore = new StdbPrimaryRbacStore({ outbox: sharedOutbox });

export const stateReducerIngress = new StatePlaneReducerIngress(statePlaneConfig);
export const stateSchemaVersion = new StatePlaneSchemaVersionManager(statePlaneConfig);

export function getStateMessageStoreRuntimeStats(): MessageStoreRuntimeStats | null {
	return getMessageStoreRuntimeStats(stateMessageStore);
}

export function getStatePlaneRuntimeStats(): StatePlaneRuntimeStats {
	return {
		config: { ...statePlaneConfig },
		messageStore: getStateMessageStoreRuntimeStats(),
		channelStore: stateChannelStore.getRuntimeStats(),
		channelMemberStore: stateChannelMemberStore.getRuntimeStats(),
		userStore: stateUserStore.getRuntimeStats(),
		sessionStore: stateSessionStore.getRuntimeStats(),
		rbacStore: stateRbacStore.getRuntimeStats(),
		reducerIngress: stateReducerIngress.getStats(),
		schema: stateSchemaVersion.getStats(),
		outbox: sharedOutbox.getStats(),
		mesh: getStateMeshRuntimeStats()
	};
}

export function startStatePlaneRuntime(): void {
	stateSchemaVersion.reconcile();
	const schemaStats = stateSchemaVersion.getStats();
	if (schemaStats.mismatch) {
		const reason = schemaStats.reason || 'schema_mismatch';
		console.warn(`[StatePlane] Schema version mismatch: ${reason}`);
	}
}

export function stopStatePlaneRuntime(): void {
	// no-op: no background runtime components currently require shutdown
}

export function recordStatePlaneEvent(
	entity: 'presence' | 'system',
	operation: string,
	payload: Record<string, unknown>
): void {
	sharedOutbox.append({
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

export {
	configureStateMeshRuntime,
	startStateMeshRuntime,
	stopStateMeshRuntime,
	registerStateMeshSocketLease,
	releaseStateMeshSocketLease,
	findStateMeshSocketLeaseByStableUserId,
	getCurrentStateMeshInstanceId,
	findStateMeshInstanceLeaseById,
	listActiveStateMeshInstanceLeases,
	sendStateMeshRemoteDelivery,
	upsertStateMeshPresenceLease,
	deleteStateMeshPresenceLease,
	listStateMeshPresenceLeases
};
