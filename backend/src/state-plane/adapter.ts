import type { StatePlaneConfig } from './config.js';
import type { MessageStoreRuntimeStats } from './messageStore.js';
import type {
	ChannelStoreRuntimeStats,
	ChannelMemberStoreRuntimeStats,
	UserStoreRuntimeStats,
	SessionStoreRuntimeStats,
	RbacStoreRuntimeStats
} from './storeTypes.js';
import type { StatePlaneOutboxStats } from './outbox.js';
import type { StatePlaneReducerIngressStats } from './reducerIngress.js';
import type { StatePlaneSchemaVersionStats } from './schemaVersion.js';
import type { StateMeshRuntimeStats } from './meshRuntime.js';

export type StatePlaneEventEntity = 'presence' | 'system';

export interface StatePlaneRuntimeStats {
	config: StatePlaneConfig;
	messageStore: MessageStoreRuntimeStats | null;
	channelStore: ChannelStoreRuntimeStats;
	channelMemberStore: ChannelMemberStoreRuntimeStats;
	userStore: UserStoreRuntimeStats;
	sessionStore: SessionStoreRuntimeStats;
	rbacStore: RbacStoreRuntimeStats;
	reducerIngress: StatePlaneReducerIngressStats;
	schema: StatePlaneSchemaVersionStats;
	outbox: StatePlaneOutboxStats | null;
	mesh: StateMeshRuntimeStats;
}

export interface StatePlaneAdapter {
	readonly config: StatePlaneConfig;
	start(): void;
	stop(): void;
	getRuntimeStats(): StatePlaneRuntimeStats;
	recordEvent(entity: StatePlaneEventEntity, operation: string, payload: Record<string, unknown>): void;
}
