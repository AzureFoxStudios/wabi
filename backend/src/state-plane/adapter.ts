import type { StatePlaneConfig } from './config.js';
import type { MessageStoreRuntimeStats } from './messageStore.js';
import type { ChannelStoreRuntimeStats } from './channelStore.js';
import type { ChannelMemberStoreRuntimeStats } from './channelMemberStore.js';
import type { UserStoreRuntimeStats } from './userStore.js';
import type { SessionStoreRuntimeStats } from './sessionStore.js';
import type { RbacStoreRuntimeStats } from './rbacStore.js';
import type { StatePlaneShadowWriterStats } from './shadowWriter.js';
import type { StatePlaneOutboxStats } from './outbox.js';
import type { StatePlaneWatchdogStats } from './watchdog.js';
import type { StatePlaneReducerIngressStats } from './reducerIngress.js';
import type { StatePlaneSchemaVersionStats } from './schemaVersion.js';
import type { StateMeshRuntimeStats } from './meshRuntime.js';

export type StatePlaneEventEntity = 'presence' | 'system';
export type StatePlaneEffectiveMode = 'legacy' | 'dual_write' | 'stdb_primary';

export interface StatePlaneWarmupStats {
	enabled: boolean;
	running: boolean;
	startedAt: number | null;
	completedAt: number | null;
	success: boolean | null;
	lastError: string | null;
	limit: number;
	counts: {
		channels: number;
		channelMembers: number;
		users: number;
		sessions: number;
		rbacAssignments: number;
	};
}

export interface StatePlaneRuntimeStats {
	config: Omit<StatePlaneConfig, 'shadowToken' | 'shadowSigningSecret' | 'shadowCommand'> & {
		shadowToken: string | null;
		shadowSigningSecret: string | null;
		shadowCommand: string | null;
		effectiveMode: StatePlaneEffectiveMode;
		modeFallbackReason: string | null;
	};
	messageStore: MessageStoreRuntimeStats | null;
	channelStore: ChannelStoreRuntimeStats;
	channelMemberStore: ChannelMemberStoreRuntimeStats;
	userStore: UserStoreRuntimeStats;
	sessionStore: SessionStoreRuntimeStats;
	rbacStore: RbacStoreRuntimeStats;
	shadowWriter: StatePlaneShadowWriterStats;
	watchdog: StatePlaneWatchdogStats;
	reducerIngress: StatePlaneReducerIngressStats;
	schema: StatePlaneSchemaVersionStats;
	outbox: StatePlaneOutboxStats | null;
	warmup: StatePlaneWarmupStats;
	mesh: StateMeshRuntimeStats;
}

export interface StatePlaneAdapter {
	readonly config: StatePlaneConfig;
	start(): void;
	stop(): void;
	getRuntimeStats(): StatePlaneRuntimeStats;
	recordEvent(entity: StatePlaneEventEntity, operation: string, payload: Record<string, unknown>): void;
}
