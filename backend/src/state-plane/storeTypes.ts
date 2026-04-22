export interface BaseRuntimeStats {
	mode: 'stdb_primary';
	writesAttempted: number;
	writesSucceeded: number;
	writesFailed: number;
	lastError: string | null;
	lastErrorAt: number | null;
	operations: Record<string, number>;
}

export type ChannelStoreRuntimeStats = BaseRuntimeStats;
export type ChannelMemberStoreRuntimeStats = BaseRuntimeStats;
export type UserStoreRuntimeStats = BaseRuntimeStats;
export type SessionStoreRuntimeStats = BaseRuntimeStats;
export type RbacStoreRuntimeStats = BaseRuntimeStats;

export interface RoleDefinitionRecord {
	workspaceId: string;
	roleName: string;
	displayName: string;
	priority: number;
	color: string | null;
	isHoisted: boolean;
}
