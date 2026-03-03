import {
	channelMemberRepository,
	type DbChannelMember
} from '../db/repositories/channelMemberRepository.js';
import db from '../db/database.js';
import { type StatePlaneOutbox } from './outbox.js';

interface ShadowStats {
	enabled: boolean;
	label: string;
	writesAttempted: number;
	writesSucceeded: number;
	writesFailed: number;
	lastError: string | null;
	lastErrorAt: number | null;
}

interface ParityStats {
	samples: number;
	mismatches: number;
	lastMismatch: string | null;
	lastMismatchAt: number | null;
}

interface ReadSwitchStats {
	enabled: boolean;
	canaryPercent: number;
	attempts: number;
	canaryRouted: number;
	shadowServed: number;
	fallbacks: number;
	shadowErrors: number;
	mismatches: number;
	lastFallbackReason: string | null;
	lastFallbackAt: number | null;
}

export interface ChannelMemberStoreRuntimeStats {
	mode: 'legacy' | 'dual_write' | 'stdb_primary';
	writesAttempted: number;
	writesSucceeded: number;
	writesFailed: number;
	lastError: string | null;
	lastErrorAt: number | null;
	operations: Record<string, number>;
	shadow: ShadowStats;
	parity: ParityStats;
	readSwitch: ReadSwitchStats;
}

export interface StateChannelMemberStoreOptions {
	dualWriteEnabled?: boolean;
	label?: string;
	paritySampleRate?: number;
	strictShadow?: boolean;
	readShadowEnabled?: boolean;
	readCanaryPercent?: number;
}

function normalizeSampleRate(input: number | undefined): number {
	if (!Number.isFinite(input)) return 0.1;
	return Math.max(0, Math.min(1, input as number));
}

function normalizeCanaryPercent(input: number | undefined): number {
	if (!Number.isFinite(input)) return 0;
	return Math.max(0, Math.min(100, Math.floor(input as number)));
}

function sortMembers(rows: DbChannelMember[]): DbChannelMember[] {
	return [...rows].sort((a, b) => {
		if (a.joined_at !== b.joined_at) return a.joined_at - b.joined_at;
		return a.user_id.localeCompare(b.user_id);
	});
}

function sortUserChannels(rows: { channel_id: string; role: string }[]): { channel_id: string; role: string }[] {
	return [...rows].sort((a, b) => {
		if (a.channel_id !== b.channel_id) return a.channel_id.localeCompare(b.channel_id);
		return a.role.localeCompare(b.role);
	});
}

function compareMembers(a: DbChannelMember, b: DbChannelMember): string | null {
	if (a.channel_id !== b.channel_id) return 'channel_id_mismatch';
	if (a.user_id !== b.user_id) return 'user_id_mismatch';
	if (a.username !== b.username) return 'username_mismatch';
	if ((a.registered_user_id || null) !== (b.registered_user_id || null)) return 'registered_user_id_mismatch';
	if (a.joined_at !== b.joined_at) return 'joined_at_mismatch';
	if (a.role !== b.role) return 'role_mismatch';
	return null;
}

export class StateChannelMemberStore {
	private readonly dualWriteEnabled: boolean;
	private readonly paritySampleRate: number;
	private readonly label: string;
	private readonly strictShadow: boolean;
	private readonly readShadowEnabled: boolean;
	private readonly readCanaryPercent: number;
	private shadowMembersByChannel = new Map<string, Map<string, DbChannelMember>>();
	private seededChannels = new Set<string>();
	private stats: ChannelMemberStoreRuntimeStats = {
		mode: 'legacy',
		writesAttempted: 0,
		writesSucceeded: 0,
		writesFailed: 0,
		lastError: null,
		lastErrorAt: null,
		operations: {},
		shadow: {
			enabled: false,
			label: 'none',
			writesAttempted: 0,
			writesSucceeded: 0,
			writesFailed: 0,
			lastError: null,
			lastErrorAt: null
		},
		parity: {
			samples: 0,
			mismatches: 0,
			lastMismatch: null,
			lastMismatchAt: null
		},
		readSwitch: {
			enabled: false,
			canaryPercent: 0,
			attempts: 0,
			canaryRouted: 0,
			shadowServed: 0,
			fallbacks: 0,
			shadowErrors: 0,
			mismatches: 0,
			lastFallbackReason: null,
			lastFallbackAt: null
		}
	};

	constructor(
		private readonly outbox: StatePlaneOutbox | null = null,
		options: StateChannelMemberStoreOptions = {}
	) {
		this.dualWriteEnabled = options.dualWriteEnabled === true;
		this.label = options.label || 'channel-member-shadow';
		this.paritySampleRate = normalizeSampleRate(options.paritySampleRate);
		this.strictShadow = options.strictShadow === true;
		this.readShadowEnabled = options.readShadowEnabled === true;
		this.readCanaryPercent = normalizeCanaryPercent(options.readCanaryPercent);

		this.stats.mode = this.dualWriteEnabled ? 'dual_write' : 'legacy';
		this.stats.shadow.enabled = this.dualWriteEnabled;
		this.stats.shadow.label = this.dualWriteEnabled ? this.label : 'none';
		this.stats.readSwitch.enabled = this.dualWriteEnabled && this.readShadowEnabled;
		this.stats.readSwitch.canaryPercent = this.readCanaryPercent;
	}

	private cloneMember(member: DbChannelMember): DbChannelMember {
		return { ...member };
	}

	private trackPrimarySuccess(op: string): void {
		this.stats.writesAttempted += 1;
		this.stats.writesSucceeded += 1;
		this.stats.operations[op] = (this.stats.operations[op] || 0) + 1;
	}

	private trackPrimaryFailure(op: string, error: unknown): void {
		this.stats.writesAttempted += 1;
		this.stats.writesFailed += 1;
		this.stats.operations[op] = (this.stats.operations[op] || 0) + 1;
		this.stats.lastErrorAt = Date.now();
		this.stats.lastError = error instanceof Error ? error.message : String(error);
	}

	private shadowBestEffort(op: string, fn: () => void): void {
		if (!this.dualWriteEnabled) return;
		this.stats.shadow.writesAttempted += 1;
		try {
			fn();
			this.stats.shadow.writesSucceeded += 1;
		} catch (error) {
			this.stats.shadow.writesFailed += 1;
			this.stats.shadow.lastErrorAt = Date.now();
			this.stats.shadow.lastError = error instanceof Error ? error.message : String(error);
			const key = `shadow:${op}`;
			if (!this.stats.operations[key]) {
				this.stats.operations[key] = 1;
				console.warn(`[StatePlane] Channel-member shadow operation failed (${op}); continuing with primary store`, error);
			} else {
				this.stats.operations[key] += 1;
			}
			if (this.strictShadow) {
				throw error instanceof Error ? error : new Error(String(error));
			}
		}
	}

	private shouldRunParitySample(): boolean {
		return this.dualWriteEnabled && this.paritySampleRate > 0 && Math.random() <= this.paritySampleRate;
	}

	private shouldRunReadCanary(): boolean {
		if (!this.dualWriteEnabled) return false;
		if (!this.readShadowEnabled) return false;
		if (this.readCanaryPercent <= 0) return false;
		return Math.random() * 100 < this.readCanaryPercent;
	}

	private recordReadAttempt(): void {
		this.stats.readSwitch.attempts += 1;
	}

	private recordReadCanaryRoute(): void {
		this.stats.readSwitch.canaryRouted += 1;
	}

	private recordReadServedByShadow(): void {
		this.stats.readSwitch.shadowServed += 1;
	}

	private recordReadFallback(reason: string): void {
		this.stats.readSwitch.fallbacks += 1;
		this.stats.readSwitch.lastFallbackReason = reason;
		this.stats.readSwitch.lastFallbackAt = Date.now();
	}

	private recordReadShadowError(op: string, error: unknown): void {
		this.stats.readSwitch.shadowErrors += 1;
		this.recordReadFallback(`error:${op}`);
		const key = `read_shadow_error:${op}`;
		if (!this.stats.operations[key]) {
			this.stats.operations[key] = 1;
			console.warn(`[StatePlane] Channel-member shadow read failed (${op}); falling back to primary`, error);
			return;
		}
		this.stats.operations[key] += 1;
	}

	private recordParityMismatch(reason: string): void {
		this.stats.parity.mismatches += 1;
		this.stats.parity.lastMismatch = reason;
		this.stats.parity.lastMismatchAt = Date.now();
	}

	private recordParitySample(): void {
		this.stats.parity.samples += 1;
	}

	private getShadowChannel(channelId: string): Map<string, DbChannelMember> {
		let members = this.shadowMembersByChannel.get(channelId);
		if (!members) {
			members = new Map<string, DbChannelMember>();
			this.shadowMembersByChannel.set(channelId, members);
		}
		return members;
	}

	private upsertShadowMember(member: DbChannelMember): void {
		const channelMembers = this.getShadowChannel(member.channel_id);
		channelMembers.set(member.user_id, this.cloneMember(member));
	}

	private removeShadowMember(channelId: string, userId: string): void {
		const members = this.shadowMembersByChannel.get(channelId);
		if (!members) return;
		members.delete(userId);
		if (members.size === 0) {
			this.shadowMembersByChannel.delete(channelId);
			this.seededChannels.delete(channelId);
		}
	}

	private shadowMembers(channelId: string): DbChannelMember[] {
		const members = this.shadowMembersByChannel.get(channelId);
		if (!members) return [];
		return sortMembers(Array.from(members.values()).map((row) => this.cloneMember(row)));
	}

	private appendOutbox(operation: string, payload: Record<string, unknown>): void {
		this.outbox?.append({
			timestamp: Date.now(),
			entity: 'channel_member',
			operation,
			payload
		});
	}

	private seedChannelFromPrimary(channelId: string): void {
		const rows = channelMemberRepository.getMembers(channelId);
		const members = new Map<string, DbChannelMember>();
		for (const row of rows) {
			members.set(row.user_id, this.cloneMember(row));
		}
		this.shadowMembersByChannel.set(channelId, members);
		this.seededChannels.add(channelId);
	}

	private ensureSeededChannel(channelId: string): void {
		if (this.seededChannels.has(channelId)) return;
		this.seedChannelFromPrimary(channelId);
	}

	addMember(member: Omit<DbChannelMember, 'id'>): DbChannelMember {
		try {
			const added = channelMemberRepository.addMember(member);
			this.trackPrimarySuccess('add_member');
			this.shadowBestEffort('add_member', () => {
				this.upsertShadowMember(added);
				this.seededChannels.add(member.channel_id);
			});
			this.appendOutbox('add_member', {
				channelId: member.channel_id,
				userId: member.user_id,
				role: member.role
			});
			return added;
		} catch (error) {
			this.trackPrimaryFailure('add_member', error);
			throw error;
		}
	}

	getMembers(channelId: string): DbChannelMember[] {
		this.recordReadAttempt();
		const primary = channelMemberRepository.getMembers(channelId);
		if (this.shouldRunReadCanary()) {
			this.recordReadCanaryRoute();
			this.recordParitySample();
			try {
				this.ensureSeededChannel(channelId);
				const shadow = this.shadowMembers(channelId);
				const orderedPrimary = sortMembers(primary);
				if (orderedPrimary.length !== shadow.length) {
					this.recordParityMismatch(
						`read_canary:getMembers(${channelId}): row_count_mismatch primary=${orderedPrimary.length} shadow=${shadow.length}`
					);
					this.stats.readSwitch.mismatches += 1;
					this.recordReadFallback('mismatch:getMembers');
					return primary;
				}
				for (let i = 0; i < orderedPrimary.length; i += 1) {
					const mismatch = compareMembers(orderedPrimary[i], shadow[i]);
					if (mismatch) {
						this.recordParityMismatch(`read_canary:getMembers(${channelId}) index=${i}: ${mismatch}`);
						this.stats.readSwitch.mismatches += 1;
						this.recordReadFallback('mismatch:getMembers');
						return primary;
					}
				}
				this.recordReadServedByShadow();
				return shadow;
			} catch (error) {
				this.recordReadShadowError('getMembers', error);
				return primary;
			}
		}
		if (!this.shouldRunParitySample()) return primary;

		this.recordParitySample();
		if (!this.seededChannels.has(channelId)) {
			const seeded = new Map<string, DbChannelMember>();
			for (const row of primary) {
				seeded.set(row.user_id, this.cloneMember(row));
			}
			this.shadowMembersByChannel.set(channelId, seeded);
			this.seededChannels.add(channelId);
			return primary;
		}

		const shadow = this.shadowMembers(channelId);
		const orderedPrimary = sortMembers(primary);
		if (orderedPrimary.length !== shadow.length) {
			this.recordParityMismatch(
				`getMembers(${channelId}): row_count_mismatch primary=${orderedPrimary.length} shadow=${shadow.length}`
			);
			return primary;
		}

		for (let i = 0; i < orderedPrimary.length; i += 1) {
			const mismatch = compareMembers(orderedPrimary[i], shadow[i]);
			if (mismatch) {
				this.recordParityMismatch(`getMembers(${channelId}) index=${i}: ${mismatch}`);
				break;
			}
		}
		return primary;
	}

	getMemberIds(channelId: string): string[] {
		this.recordReadAttempt();
		const primary = channelMemberRepository.getMemberIds(channelId);
		if (this.shouldRunReadCanary()) {
			this.recordReadCanaryRoute();
			this.recordParitySample();
			try {
				this.ensureSeededChannel(channelId);
				const shadowIds = this.shadowMembers(channelId).map((member) => member.user_id);
				const orderedPrimary = [...primary].sort();
				const orderedShadow = [...shadowIds].sort();
				if (orderedPrimary.length !== orderedShadow.length) {
					this.recordParityMismatch(
						`read_canary:getMemberIds(${channelId}): row_count_mismatch primary=${orderedPrimary.length} shadow=${orderedShadow.length}`
					);
					this.stats.readSwitch.mismatches += 1;
					this.recordReadFallback('mismatch:getMemberIds');
					return primary;
				}
				for (let i = 0; i < orderedPrimary.length; i += 1) {
					if (orderedPrimary[i] !== orderedShadow[i]) {
						this.recordParityMismatch(
							`read_canary:getMemberIds(${channelId}): user_id_mismatch index=${i} primary=${orderedPrimary[i]} shadow=${orderedShadow[i]}`
						);
						this.stats.readSwitch.mismatches += 1;
						this.recordReadFallback('mismatch:getMemberIds');
						return primary;
					}
				}
				this.recordReadServedByShadow();
				return shadowIds;
			} catch (error) {
				this.recordReadShadowError('getMemberIds', error);
				return primary;
			}
		}
		if (!this.shouldRunParitySample()) return primary;

		this.recordParitySample();
		this.ensureSeededChannel(channelId);
		const shadowIds = this.shadowMembers(channelId).map((member) => member.user_id);
		const orderedPrimary = [...primary].sort();
		const orderedShadow = [...shadowIds].sort();
		if (orderedPrimary.length !== orderedShadow.length) {
			this.recordParityMismatch(
				`getMemberIds(${channelId}): row_count_mismatch primary=${orderedPrimary.length} shadow=${orderedShadow.length}`
			);
			return primary;
		}
		for (let i = 0; i < orderedPrimary.length; i += 1) {
			if (orderedPrimary[i] !== orderedShadow[i]) {
				this.recordParityMismatch(
					`getMemberIds(${channelId}): user_id_mismatch index=${i} primary=${orderedPrimary[i]} shadow=${orderedShadow[i]}`
				);
				break;
			}
		}
		return primary;
	}

	isMember(channelId: string, userId: string): boolean {
		this.recordReadAttempt();
		const primary = channelMemberRepository.isMember(channelId, userId);
		if (this.shouldRunReadCanary()) {
			this.recordReadCanaryRoute();
			this.recordParitySample();
			try {
				this.ensureSeededChannel(channelId);
				const shadow = this.shadowMembersByChannel.get(channelId)?.has(userId) || false;
				if (primary !== shadow) {
					this.recordParityMismatch(`read_canary:isMember(${channelId},${userId}): bool_mismatch primary=${primary} shadow=${shadow}`);
					this.stats.readSwitch.mismatches += 1;
					this.recordReadFallback('mismatch:isMember');
					return primary;
				}
				this.recordReadServedByShadow();
				return shadow;
			} catch (error) {
				this.recordReadShadowError('isMember', error);
				return primary;
			}
		}
		if (!this.shouldRunParitySample()) return primary;

		this.recordParitySample();
		this.ensureSeededChannel(channelId);
		const shadow = this.shadowMembersByChannel.get(channelId)?.has(userId) || false;
		if (primary !== shadow) {
			this.recordParityMismatch(`isMember(${channelId},${userId}): bool_mismatch primary=${primary} shadow=${shadow}`);
		}
		return primary;
	}

	removeMember(channelId: string, userId: string): void {
		try {
			channelMemberRepository.removeMember(channelId, userId);
			this.trackPrimarySuccess('remove_member');
			this.shadowBestEffort('remove_member', () => {
				this.removeShadowMember(channelId, userId);
			});
			this.appendOutbox('remove_member', {
				channelId,
				userId
			});
		} catch (error) {
			this.trackPrimaryFailure('remove_member', error);
			throw error;
		}
	}

	getUserChannels(userId: string): { channel_id: string; role: string }[] {
		this.recordReadAttempt();
		const primary = channelMemberRepository.getUserChannels(userId);
		const shadow: { channel_id: string; role: string }[] = [];
		for (const [channelId, members] of this.shadowMembersByChannel.entries()) {
			const member = members.get(userId);
			if (!member) continue;
			shadow.push({ channel_id: channelId, role: member.role });
		}

		if (this.shouldRunReadCanary()) {
			this.recordReadCanaryRoute();
			this.recordParitySample();
			try {
				if (shadow.length === 0 && primary.length > 0) {
					this.recordReadFallback('cold:getUserChannels');
					return primary;
				}
				const orderedPrimary = sortUserChannels(primary);
				const orderedShadow = sortUserChannels(shadow);
				if (orderedPrimary.length !== orderedShadow.length) {
					this.recordParityMismatch(
						`read_canary:getUserChannels(${userId}): row_count_mismatch primary=${orderedPrimary.length} shadow=${orderedShadow.length}`
					);
					this.stats.readSwitch.mismatches += 1;
					this.recordReadFallback('mismatch:getUserChannels');
					return primary;
				}
				for (let i = 0; i < orderedPrimary.length; i += 1) {
					if (
						orderedPrimary[i].channel_id !== orderedShadow[i].channel_id ||
						orderedPrimary[i].role !== orderedShadow[i].role
					) {
						this.recordParityMismatch(
							`read_canary:getUserChannels(${userId}): row_mismatch index=${i} primary=${orderedPrimary[i].channel_id}:${orderedPrimary[i].role} shadow=${orderedShadow[i].channel_id}:${orderedShadow[i].role}`
						);
						this.stats.readSwitch.mismatches += 1;
						this.recordReadFallback('mismatch:getUserChannels');
						return primary;
					}
				}
				this.recordReadServedByShadow();
				return shadow;
			} catch (error) {
				this.recordReadShadowError('getUserChannels', error);
				return primary;
			}
		}

		if (!this.shouldRunParitySample()) return primary;

		// Only parity-check channels we have already seeded to avoid false drift on cold shadow state.
		if (shadow.length === 0 && primary.length > 0) {
			return primary;
		}

		this.recordParitySample();
		const orderedPrimary = sortUserChannels(primary);
		const orderedShadow = sortUserChannels(shadow);
		if (orderedPrimary.length !== orderedShadow.length) {
			this.recordParityMismatch(
				`getUserChannels(${userId}): row_count_mismatch primary=${orderedPrimary.length} shadow=${orderedShadow.length}`
			);
			return primary;
		}
		for (let i = 0; i < orderedPrimary.length; i += 1) {
			if (
				orderedPrimary[i].channel_id !== orderedShadow[i].channel_id ||
				orderedPrimary[i].role !== orderedShadow[i].role
			) {
				this.recordParityMismatch(
					`getUserChannels(${userId}): row_mismatch index=${i} primary=${orderedPrimary[i].channel_id}:${orderedPrimary[i].role} shadow=${orderedShadow[i].channel_id}:${orderedShadow[i].role}`
				);
				break;
			}
		}
		return primary;
	}

	updateMember(channelId: string, userId: string, updates: Partial<DbChannelMember>): void {
		try {
			channelMemberRepository.updateMember(channelId, userId, updates);
			this.trackPrimarySuccess('update_member');
			this.shadowBestEffort('update_member', () => {
				const members = this.shadowMembersByChannel.get(channelId);
				const existing = members?.get(userId);
				if (!existing) return;
				this.upsertShadowMember({
					...existing,
					...updates
				});
			});
			this.appendOutbox('update_member', {
				channelId,
				userId,
				updates
			});
		} catch (error) {
			this.trackPrimaryFailure('update_member', error);
			throw error;
		}
	}

	getMember(channelId: string, userId: string): DbChannelMember | null {
		this.recordReadAttempt();
		const primary = channelMemberRepository.getMember(channelId, userId);
		if (this.shouldRunReadCanary()) {
			this.recordReadCanaryRoute();
			this.recordParitySample();
			try {
				this.ensureSeededChannel(channelId);
				const shadow = this.shadowMembersByChannel.get(channelId)?.get(userId) || null;
				if (!primary && !shadow) return primary;
				if (!primary || !shadow) {
					this.recordParityMismatch(`read_canary:getMember(${channelId},${userId}): presence_mismatch`);
					this.stats.readSwitch.mismatches += 1;
					this.recordReadFallback('mismatch:getMember');
					return primary;
				}
				const mismatch = compareMembers(primary, shadow);
				if (mismatch) {
					this.recordParityMismatch(`read_canary:getMember(${channelId},${userId}): ${mismatch}`);
					this.stats.readSwitch.mismatches += 1;
					this.recordReadFallback('mismatch:getMember');
					return primary;
				}
				this.recordReadServedByShadow();
				return this.cloneMember(shadow);
			} catch (error) {
				this.recordReadShadowError('getMember', error);
				return primary;
			}
		}
		if (!this.shouldRunParitySample()) return primary;

		this.recordParitySample();
		this.ensureSeededChannel(channelId);
		const shadow = this.shadowMembersByChannel.get(channelId)?.get(userId) || null;
		if (!primary && !shadow) return primary;
		if (!primary || !shadow) {
			this.recordParityMismatch(`getMember(${channelId},${userId}): presence_mismatch`);
			return primary;
		}
		const mismatch = compareMembers(primary, shadow);
		if (mismatch) {
			this.recordParityMismatch(`getMember(${channelId},${userId}): ${mismatch}`);
		}
		return primary;
	}

	addMembers(members: Omit<DbChannelMember, 'id'>[]): void {
		try {
			channelMemberRepository.addMembers(members);
			this.trackPrimarySuccess('add_members_bulk');
			this.shadowBestEffort('add_members_bulk', () => {
				for (const member of members) {
					this.upsertShadowMember({
						...member
					});
					this.seededChannels.add(member.channel_id);
				}
			});
			this.appendOutbox('add_members_bulk', {
				count: members.length,
				channelIds: Array.from(new Set(members.map((member) => member.channel_id))).slice(0, 20)
			});
		} catch (error) {
			this.trackPrimaryFailure('add_members_bulk', error);
			throw error;
		}
	}

	warmFromPrimary(limit: number): number {
		if (!this.dualWriteEnabled) return 0;
		const safeLimit = Math.max(0, Math.floor(limit));
		if (safeLimit === 0) return 0;

		const rows = db.prepare(`
			SELECT * FROM channel_members
			ORDER BY channel_id ASC, joined_at ASC, user_id ASC
			LIMIT ?
		`).all(safeLimit) as DbChannelMember[];

		this.shadowBestEffort('warmup', () => {
			this.shadowMembersByChannel.clear();
			this.seededChannels.clear();
			for (const row of rows) {
				this.upsertShadowMember(row);
				this.seededChannels.add(row.channel_id);
			}
		});

		this.stats.operations.warmup = (this.stats.operations.warmup || 0) + 1;
		this.stats.operations.warmup_rows = rows.length;
		return rows.length;
	}

	getRuntimeStats(): ChannelMemberStoreRuntimeStats {
		return {
			mode: this.stats.mode,
			writesAttempted: this.stats.writesAttempted,
			writesSucceeded: this.stats.writesSucceeded,
			writesFailed: this.stats.writesFailed,
			lastError: this.stats.lastError,
			lastErrorAt: this.stats.lastErrorAt,
			operations: { ...this.stats.operations },
			shadow: { ...this.stats.shadow },
			parity: { ...this.stats.parity },
			readSwitch: { ...this.stats.readSwitch }
		};
	}
}
