import {
	channelRepository,
	type DbChannel
} from '../db/repositories/channelRepository.js';
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

export interface ChannelStoreRuntimeStats {
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

export interface StateChannelStoreOptions {
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

function normalizeString(value: unknown): string {
	if (value == null) return '';
	return String(value);
}

function normalizeNullableString(value: unknown): string | null {
	if (value == null) return null;
	return String(value);
}

function compareChannels(a: DbChannel | null, b: DbChannel | null): string | null {
	if (!a && !b) return null;
	if (!a || !b) return `presence_mismatch primary=${Boolean(a)} shadow=${Boolean(b)}`;

	if (a.channel_id !== b.channel_id) return 'channel_id_mismatch';
	if (a.channel_type !== b.channel_type) return `channel_type_mismatch primary=${a.channel_type} shadow=${b.channel_type}`;
	if (a.is_archived !== b.is_archived) return `is_archived_mismatch primary=${a.is_archived} shadow=${b.is_archived}`;
	if (a.name !== b.name) return 'name_mismatch';
	if (normalizeString(a.description) !== normalizeString(b.description)) return 'description_mismatch';
	if (normalizeString(a.min_role || 'guest') !== normalizeString(b.min_role || 'guest')) return 'min_role_mismatch';
	if (normalizeString(a.avatar) !== normalizeString(b.avatar)) return 'avatar_mismatch';
	if (normalizeNullableString(a.voice_settings_json) !== normalizeNullableString(b.voice_settings_json)) return 'voice_settings_mismatch';
	if (normalizeString(a.parent_channel_id) !== normalizeString(b.parent_channel_id)) return 'parent_channel_id_mismatch';
	if (normalizeString(a.parent_message_id) !== normalizeString(b.parent_message_id)) return 'parent_message_id_mismatch';
	if ((a.persist_messages ?? 0) !== (b.persist_messages ?? 0)) return 'persist_messages_mismatch';

	return null;
}

export class StateChannelStore {
	private readonly dualWriteEnabled: boolean;
	private readonly paritySampleRate: number;
	private readonly label: string;
	private readonly strictShadow: boolean;
	private readonly readShadowEnabled: boolean;
	private readonly readCanaryPercent: number;
	private shadowChannels = new Map<string, DbChannel>();
	private stats: ChannelStoreRuntimeStats = {
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
		options: StateChannelStoreOptions = {}
	) {
		this.dualWriteEnabled = options.dualWriteEnabled === true;
		this.label = options.label || 'channel-shadow';
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

	private cloneChannel(channel: DbChannel): DbChannel {
		return { ...channel };
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
				console.warn(`[StatePlane] Channel shadow operation failed (${op}); continuing with primary store`, error);
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
			console.warn(`[StatePlane] Channel shadow read failed (${op}); falling back to primary`, error);
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

	private upsertShadowChannel(channel: DbChannel): void {
		this.shadowChannels.set(channel.channel_id, this.cloneChannel(channel));
	}

	private shadowArchive(channelId: string): void {
		const existing = this.shadowChannels.get(channelId);
		if (!existing) return;
		existing.is_archived = 1;
		this.shadowChannels.set(channelId, this.cloneChannel(existing));
	}

	private shadowDelete(channelId: string): void {
		this.shadowChannels.delete(channelId);
	}

	private shadowWorkspaceChannels(): DbChannel[] {
		const rows = Array.from(this.shadowChannels.values()).filter((channel) => {
			if (channel.is_archived !== 0) return false;
			return (
				channel.channel_type === 'text' ||
				channel.channel_type === 'voice' ||
				channel.channel_type === 'public' ||
				channel.channel_type === 'thread_public'
			);
		});
		rows.sort((a, b) => a.created_at - b.created_at);
		return rows.map((row) => this.cloneChannel(row));
	}

	private appendOutbox(operation: string, payload: Record<string, unknown>): void {
		this.outbox?.append({
			timestamp: Date.now(),
			entity: 'channel',
			operation,
			payload
		});
	}

	create(channel: Omit<DbChannel, 'is_archived'>): DbChannel {
		try {
			const created = channelRepository.create(channel);
			this.trackPrimarySuccess('create');
			this.shadowBestEffort('create', () => {
				this.upsertShadowChannel(created);
			});
			this.appendOutbox('create', {
				channelId: created.channel_id,
				channelType: created.channel_type,
				createdAt: created.created_at
			});
			return created;
		} catch (error) {
			this.trackPrimaryFailure('create', error);
			throw error;
		}
	}

	findById(channelId: string): DbChannel | null {
		this.recordReadAttempt();
		const primary = channelRepository.findById(channelId);
		if (this.shouldRunReadCanary()) {
			this.recordReadCanaryRoute();
			this.recordParitySample();
			try {
				const shadow = this.shadowChannels.get(channelId) || null;
				if (!shadow && primary) {
					this.upsertShadowChannel(primary);
					this.recordReadFallback('cold:findById');
					return primary;
				}

				const mismatch = compareChannels(primary, shadow);
				if (mismatch) {
					this.recordParityMismatch(`read_canary:findById(${channelId}): ${mismatch}`);
					this.stats.readSwitch.mismatches += 1;
					this.recordReadFallback('mismatch:findById');
					return primary;
				}

				if (shadow) {
					this.recordReadServedByShadow();
					return this.cloneChannel(shadow);
				}
				return shadow;
			} catch (error) {
				this.recordReadShadowError('findById', error);
				return primary;
			}
		}

		if (!this.shouldRunParitySample()) return primary;

		this.recordParitySample();
		const shadow = this.shadowChannels.get(channelId) || null;
		if (!shadow && primary) {
			this.upsertShadowChannel(primary);
			return primary;
		}
		const mismatch = compareChannels(primary, shadow);
		if (mismatch) {
			this.recordParityMismatch(`findById(${channelId}): ${mismatch}`);
		}
		return primary;
	}

	findByUserId(userId: string): DbChannel[] {
		return channelRepository.findByUserId(userId);
	}

	findDMBetween(userId1: string, userId2: string): DbChannel | null {
		return channelRepository.findDMBetween(userId1, userId2);
	}

	getWorkspaceChannels(): DbChannel[] {
		this.recordReadAttempt();
		const primary = channelRepository.getWorkspaceChannels();
		if (this.shouldRunReadCanary()) {
			this.recordReadCanaryRoute();
			this.recordParitySample();
			try {
				const shadow = this.shadowWorkspaceChannels();
				if (shadow.length === 0 && primary.length > 0) {
					for (const row of primary) {
						this.upsertShadowChannel(row);
					}
					this.recordReadFallback('cold:getWorkspaceChannels');
					return primary;
				}

				if (primary.length !== shadow.length) {
					this.recordParityMismatch(
						`read_canary:getWorkspaceChannels: row_count_mismatch primary=${primary.length} shadow=${shadow.length}`
					);
					this.stats.readSwitch.mismatches += 1;
					this.recordReadFallback('mismatch:getWorkspaceChannels');
					return primary;
				}

				for (let i = 0; i < primary.length; i += 1) {
					const mismatch = compareChannels(primary[i], shadow[i]);
					if (mismatch) {
						this.recordParityMismatch(`read_canary:getWorkspaceChannels index=${i}: ${mismatch}`);
						this.stats.readSwitch.mismatches += 1;
						this.recordReadFallback('mismatch:getWorkspaceChannels');
						return primary;
					}
				}

				this.recordReadServedByShadow();
				return shadow;
			} catch (error) {
				this.recordReadShadowError('getWorkspaceChannels', error);
				return primary;
			}
		}

		if (!this.shouldRunParitySample()) return primary;

		this.recordParitySample();
		const shadow = this.shadowWorkspaceChannels();
		if (shadow.length === 0 && primary.length > 0) {
			for (const row of primary) {
				this.upsertShadowChannel(row);
			}
			return primary;
		}

		if (primary.length !== shadow.length) {
			this.recordParityMismatch(
				`getWorkspaceChannels: row_count_mismatch primary=${primary.length} shadow=${shadow.length}`
			);
			return primary;
		}

		for (let i = 0; i < primary.length; i += 1) {
			const mismatch = compareChannels(primary[i], shadow[i]);
			if (mismatch) {
				this.recordParityMismatch(`getWorkspaceChannels index=${i}: ${mismatch}`);
				break;
			}
		}
		return primary;
	}

	archive(channelId: string): void {
		try {
			channelRepository.archive(channelId);
			this.trackPrimarySuccess('archive');
			this.shadowBestEffort('archive', () => {
				this.shadowArchive(channelId);
			});
			this.appendOutbox('archive', { channelId });
		} catch (error) {
			this.trackPrimaryFailure('archive', error);
			throw error;
		}
	}

	ensureBaseChannelsExist(): void {
		channelRepository.ensureBaseChannelsExist();
		if (!this.dualWriteEnabled) return;

		this.shadowBestEffort('ensure_base_channels', () => {
			const general = channelRepository.findById('general');
			const voice = channelRepository.findById('voice');
			if (general) this.upsertShadowChannel(general);
			if (voice) this.upsertShadowChannel(voice);
		});
	}

	updateSettings(
		channelId: string,
		settings: {
			persist_messages?: number;
			description?: string;
			min_role?: string;
			voice_settings_json?: string | null;
		}
	): void {
		try {
			channelRepository.updateSettings(channelId, settings);
			this.trackPrimarySuccess('update_settings');
			this.shadowBestEffort('update_settings', () => {
				const existing = this.shadowChannels.get(channelId);
				if (!existing) return;
				const updated: DbChannel = {
					...existing,
					persist_messages: settings.persist_messages ?? existing.persist_messages,
					description: settings.description ?? existing.description,
					min_role: settings.min_role ?? existing.min_role,
					voice_settings_json:
						settings.voice_settings_json !== undefined ? settings.voice_settings_json : existing.voice_settings_json
				};
				this.upsertShadowChannel(updated);
			});
			this.appendOutbox('update_settings', {
				channelId,
				settings
			});
		} catch (error) {
			this.trackPrimaryFailure('update_settings', error);
			throw error;
		}
	}

	delete(channelId: string): void {
		try {
			channelRepository.delete(channelId);
			this.trackPrimarySuccess('delete');
			this.shadowBestEffort('delete', () => {
				this.shadowDelete(channelId);
			});
			this.appendOutbox('delete', { channelId });
		} catch (error) {
			this.trackPrimaryFailure('delete', error);
			throw error;
		}
	}

	exists(channelId: string): boolean {
		this.recordReadAttempt();
		const primary = channelRepository.exists(channelId);
		if (this.shouldRunReadCanary()) {
			this.recordReadCanaryRoute();
			this.recordParitySample();
			try {
				const shadow = this.shadowChannels.get(channelId);
				if (!shadow) {
					if (primary) {
						const hydrated = channelRepository.findById(channelId);
						if (hydrated) {
							this.upsertShadowChannel(hydrated);
						}
					}
					this.recordReadFallback('cold:exists');
					return primary;
				}

				const shadowExists = shadow.is_archived === 0;
				if (primary !== shadowExists) {
					this.recordParityMismatch(`read_canary:exists(${channelId}): bool_mismatch primary=${primary} shadow=${shadowExists}`);
					this.stats.readSwitch.mismatches += 1;
					this.recordReadFallback('mismatch:exists');
					return primary;
				}
				this.recordReadServedByShadow();
				return shadowExists;
			} catch (error) {
				this.recordReadShadowError('exists', error);
				return primary;
			}
		}

		if (!this.shouldRunParitySample()) return primary;

		this.recordParitySample();
		const shadow = this.shadowChannels.get(channelId);
		if (!shadow) {
			if (!primary) return primary;
			const hydrated = channelRepository.findById(channelId);
			if (hydrated) {
				this.upsertShadowChannel(hydrated);
			}
			return primary;
		}

		const shadowExists = shadow.is_archived === 0;
		if (primary !== shadowExists) {
			this.recordParityMismatch(`exists(${channelId}): bool_mismatch primary=${primary} shadow=${shadowExists}`);
		}
		return primary;
	}

	updateAvatar(channelId: string, avatarUrl: string | null): void {
		try {
			channelRepository.updateAvatar(channelId, avatarUrl);
			this.trackPrimarySuccess('update_avatar');
			this.shadowBestEffort('update_avatar', () => {
				const existing = this.shadowChannels.get(channelId);
				if (!existing) return;
				this.upsertShadowChannel({
					...existing,
					avatar: avatarUrl || undefined
				});
			});
			this.appendOutbox('update_avatar', {
				channelId,
				avatarUrl
			});
		} catch (error) {
			this.trackPrimaryFailure('update_avatar', error);
			throw error;
		}
	}

	warmFromPrimary(limit: number): number {
		if (!this.dualWriteEnabled) return 0;
		const safeLimit = Math.max(0, Math.floor(limit));
		if (safeLimit === 0) return 0;

		const rows = db.prepare(`
			SELECT * FROM channels
			WHERE is_archived = 0
			ORDER BY created_at ASC
			LIMIT ?
		`).all(safeLimit) as DbChannel[];

		this.shadowBestEffort('warmup', () => {
			this.shadowChannels.clear();
			for (const row of rows) {
				this.upsertShadowChannel(row);
			}
		});

		this.stats.operations.warmup = (this.stats.operations.warmup || 0) + 1;
		this.stats.operations.warmup_rows = rows.length;
		return rows.length;
	}

	getRuntimeStats(): ChannelStoreRuntimeStats {
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
