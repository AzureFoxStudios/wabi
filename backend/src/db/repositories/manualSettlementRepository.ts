import { randomUUID } from 'crypto';
import { DEFAULT_WORKSPACE_ID } from '../../constants.js';
import { stdbPaymentIngest, stdbPaymentRows, stdbPaymentsEnabled, parseStdbRowJson, lookupStdbUsername } from '../../payments/stdbRuntime.js';
import { escapeSqlLiteral } from '../../state-plane/stdbSyncClient.js';
import db from '../database.js';

export type ManualSettlementKind = 'dm_cash' | 'offline_donation';
export type ManualSettlementStatus =
	| 'pending'
	| 'confirmed_by_creator'
	| 'confirmed_by_counterparty'
	| 'completed'
	| 'canceled'
	| 'disputed'
	| 'recorded'
	| 'voided';

export interface ManualSettlementRow {
	id: number;
	settlement_id: string;
	workspace_id: string;
	settlement_kind: ManualSettlementKind;
	channel_id: string | null;
	created_by_user_id: number;
	counterparty_user_id: number | null;
	donor_label: string | null;
	amount_minor: number;
	currency: string;
	description: string | null;
	status: ManualSettlementStatus;
	metadata_json: string | null;
	creator_confirmed_at: number | null;
	counterparty_confirmed_at: number | null;
	completed_at: number | null;
	voided_at: number | null;
	created_at: number;
	updated_at: number;
}

export interface ManualSettlementView extends Omit<ManualSettlementRow, 'metadata_json'> {
	metadata: Record<string, unknown> | null;
}

export interface ManualCashConversationRow extends ManualSettlementRow {
	creator_username: string | null;
	counterparty_username: string | null;
}

export interface OfflineDonationRecordRow extends ManualSettlementRow {
	recorded_by_username: string | null;
}

export interface CreateManualSettlementInput {
	settlementId?: string;
	workspaceId?: string;
	settlementKind: ManualSettlementKind;
	channelId?: string | null;
	createdByUserId: number;
	counterpartyUserId?: number | null;
	donorLabel?: string | null;
	amountMinor: number;
	currency: string;
	description?: string | null;
	status: ManualSettlementStatus;
	metadata?: Record<string, unknown> | null;
}

const MANUAL_SETTLEMENT_KINDS: ReadonlySet<ManualSettlementKind> = new Set(['dm_cash', 'offline_donation']);
const MANUAL_SETTLEMENT_STATUSES: ReadonlySet<ManualSettlementStatus> = new Set([
	'pending',
	'confirmed_by_creator',
	'confirmed_by_counterparty',
	'completed',
	'canceled',
	'disputed',
	'recorded',
	'voided'
]);

function generateSettlementId(): string {
	return `manual_${randomUUID().replace(/-/g, '')}`;
}

function safeParseJson(value: string | null): Record<string, unknown> | null {
	if (!value || value.trim().length === 0) return null;
	try {
		const parsed = JSON.parse(value);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}

function toView(row: ManualSettlementRow): ManualSettlementView {
	return {
		...row,
		metadata: safeParseJson(row.metadata_json)
	};
}

function toStringOrNull(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function toNumberOrNull(value: unknown): number | null {
	if (value == null) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSettlementKind(value: unknown): ManualSettlementKind | null {
	return typeof value === 'string' && MANUAL_SETTLEMENT_KINDS.has(value as ManualSettlementKind)
		? (value as ManualSettlementKind)
		: null;
}

function normalizeSettlementStatus(value: unknown): ManualSettlementStatus | null {
	return typeof value === 'string' && MANUAL_SETTLEMENT_STATUSES.has(value as ManualSettlementStatus)
		? (value as ManualSettlementStatus)
		: null;
}

function normalizeSettlementRow(
	row: Partial<ManualSettlementRow> | null | undefined
): ManualSettlementRow | null {
	const settlementId = toStringOrNull(row?.settlement_id);
	const workspaceId = toStringOrNull(row?.workspace_id);
	const settlementKind = normalizeSettlementKind(row?.settlement_kind);
	const status = normalizeSettlementStatus(row?.status);
	const currency = toStringOrNull(row?.currency);
	const createdByUserId = toNumberOrNull(row?.created_by_user_id);
	if (!settlementId || !workspaceId || !settlementKind || !status || !currency || createdByUserId == null) {
		return null;
	}

	return {
		id: Math.floor(toNumberOrNull(row?.id) || 0),
		settlement_id: settlementId,
		workspace_id: workspaceId,
		settlement_kind: settlementKind,
		channel_id: toStringOrNull(row?.channel_id),
		created_by_user_id: Math.floor(createdByUserId),
		counterparty_user_id: toNumberOrNull(row?.counterparty_user_id),
		donor_label: toStringOrNull(row?.donor_label),
		amount_minor: Math.floor(toNumberOrNull(row?.amount_minor) || 0),
		currency: currency.toUpperCase(),
		description: toStringOrNull(row?.description),
		status,
		metadata_json: typeof row?.metadata_json === 'string' ? row.metadata_json : null,
		creator_confirmed_at: toNumberOrNull(row?.creator_confirmed_at),
		counterparty_confirmed_at: toNumberOrNull(row?.counterparty_confirmed_at),
		completed_at: toNumberOrNull(row?.completed_at),
		voided_at: toNumberOrNull(row?.voided_at),
		created_at: Math.floor(toNumberOrNull(row?.created_at) || 0),
		updated_at: Math.floor(toNumberOrNull(row?.updated_at) || 0)
	};
}

function donationSortKey(row: Pick<ManualSettlementRow, 'voided_at' | 'completed_at' | 'created_at'>): number {
	return row.voided_at ?? row.completed_at ?? row.created_at;
}

function sortManualSettlementsByUpdatedAtDesc(
	left: Pick<ManualSettlementRow, 'updated_at' | 'settlement_id'>,
	right: Pick<ManualSettlementRow, 'updated_at' | 'settlement_id'>
): number {
	const diff = right.updated_at - left.updated_at;
	return diff !== 0 ? diff : right.settlement_id.localeCompare(left.settlement_id);
}

export class ManualSettlementRepository {
	private findBySettlementIdLegacy(settlementId: string): ManualSettlementRow | null {
		const row = db
			.prepare('SELECT * FROM manual_settlements WHERE settlement_id = ? LIMIT 1')
			.get(settlementId) as ManualSettlementRow | undefined;
		return row || null;
	}

	private findBySettlementIdStdb(settlementId: string): ManualSettlementRow | null {
		const rows = stdbPaymentRows(
			'manual_settlements.find_by_settlement_id',
			`SELECT row_json FROM state_manual_settlement WHERE settlement_id = ${escapeSqlLiteral(settlementId)} LIMIT 1`
		);
		return rows && rows.length > 0
			? normalizeSettlementRow(parseStdbRowJson<ManualSettlementRow>(rows[0]))
			: null;
	}

	private listDmCashForChannelLegacy(channelId: string, limit: number): ManualCashConversationRow[] {
		return db
			.prepare(`
				SELECT
					ms.*,
					creator.username AS creator_username,
					counterparty.username AS counterparty_username
				FROM manual_settlements ms
				LEFT JOIN users creator ON creator.user_id = ms.created_by_user_id
				LEFT JOIN users counterparty ON counterparty.user_id = ms.counterparty_user_id
				WHERE ms.channel_id = ?
					AND ms.settlement_kind = 'dm_cash'
				ORDER BY ms.updated_at DESC, ms.settlement_id DESC
				LIMIT ?
			`)
			.all(channelId, limit) as ManualCashConversationRow[];
	}

	private listDmCashForChannelStdb(channelId: string, limit: number): ManualCashConversationRow[] {
		const rows = stdbPaymentRows(
			'manual_settlements.list_dm_cash_for_channel',
			"SELECT row_json FROM state_manual_settlement WHERE settlement_kind = 'dm_cash'"
		);
		return (rows || [])
			.map((row) => normalizeSettlementRow(parseStdbRowJson<ManualSettlementRow>(row)))
			.filter((row): row is ManualSettlementRow => Boolean(row))
			.filter((row) => row.channel_id === channelId)
			.sort(sortManualSettlementsByUpdatedAtDesc)
			.slice(0, limit)
			.map((row) => ({
				...row,
				creator_username: lookupStdbUsername(row.created_by_user_id),
				counterparty_username: lookupStdbUsername(row.counterparty_user_id)
			}));
	}

	private summarizeOfflineDonationsLegacy(workspaceId: string): Array<{
		currency: string;
		amount_minor: number;
		payment_count: number;
	}> {
		return db
			.prepare(`
				SELECT
					currency,
					SUM(amount_minor) AS amount_minor,
					COUNT(*) AS payment_count
				FROM manual_settlements
				WHERE workspace_id = ?
					AND settlement_kind = 'offline_donation'
					AND status = 'recorded'
				GROUP BY currency
				ORDER BY currency ASC
			`)
			.all(workspaceId) as Array<{ currency: string; amount_minor: number; payment_count: number }>;
	}

	private summarizeOfflineDonationsStdb(workspaceId: string): Array<{
		currency: string;
		amount_minor: number;
		payment_count: number;
	}> {
		const rows = stdbPaymentRows(
			'manual_settlements.summarize_offline_donations',
			`SELECT row_json FROM state_manual_settlement WHERE workspace_id = ${escapeSqlLiteral(workspaceId)} AND settlement_kind = 'offline_donation'`
		);
		const totals = new Map<string, { currency: string; amount_minor: number; payment_count: number }>();
		for (const row of rows || []) {
			const parsed = normalizeSettlementRow(parseStdbRowJson<ManualSettlementRow>(row));
			if (!parsed) continue;
			if (parsed.status !== 'recorded') continue;
			const current = totals.get(parsed.currency) || {
				currency: parsed.currency,
				amount_minor: 0,
				payment_count: 0
			};
			current.amount_minor += parsed.amount_minor;
			current.payment_count += 1;
			totals.set(parsed.currency, current);
		}
		return [...totals.values()].sort((left, right) => left.currency.localeCompare(right.currency));
	}

	private listOfflineDonationsLegacy(workspaceId: string, limit: number): OfflineDonationRecordRow[] {
		return db
			.prepare(`
				SELECT
					ms.*,
					recorder.username AS recorded_by_username
				FROM manual_settlements ms
				LEFT JOIN users recorder ON recorder.user_id = ms.created_by_user_id
				WHERE ms.workspace_id = ?
					AND ms.settlement_kind = 'offline_donation'
					AND ms.status IN ('recorded', 'voided')
				ORDER BY COALESCE(ms.voided_at, ms.completed_at, ms.created_at) DESC, ms.settlement_id DESC
				LIMIT ?
			`)
			.all(workspaceId, limit) as OfflineDonationRecordRow[];
	}

	private listOfflineDonationsStdb(workspaceId: string, limit: number): OfflineDonationRecordRow[] {
		const rows = stdbPaymentRows(
			'manual_settlements.list_offline_donations',
			`SELECT row_json FROM state_manual_settlement WHERE workspace_id = ${escapeSqlLiteral(workspaceId)} AND settlement_kind = 'offline_donation'`
		);
		return (rows || [])
			.map((row) => normalizeSettlementRow(parseStdbRowJson<ManualSettlementRow>(row)))
			.filter((row): row is ManualSettlementRow => Boolean(row))
			.filter((row) => row.status === 'recorded' || row.status === 'voided')
			.sort((left, right) => {
				const diff = donationSortKey(right) - donationSortKey(left);
				return diff !== 0 ? diff : right.settlement_id.localeCompare(left.settlement_id);
			})
			.slice(0, limit)
			.map((row) => ({
				...row,
				recorded_by_username: lookupStdbUsername(row.created_by_user_id)
			}));
	}

	private upsertStdbSettlement(row: ManualSettlementRow): void {
		stdbPaymentIngest('manual_settlements.write', 'upsert_manual_settlement', {
			settlementId: row.settlement_id,
			row
		});
	}

	findBySettlementId(settlementId: string): ManualSettlementRow | null {
		if (stdbPaymentsEnabled()) {
			const shadow = this.findBySettlementIdStdb(settlementId);
			if (shadow) return shadow;
			const legacy = this.findBySettlementIdLegacy(settlementId);
			if (legacy) this.upsertStdbSettlement(legacy);
			return legacy;
		}
		return this.findBySettlementIdLegacy(settlementId);
	}

	findViewBySettlementId(settlementId: string): ManualSettlementView | null {
		const row = this.findBySettlementId(settlementId);
		return row ? toView(row) : null;
	}

	createSettlement(input: CreateManualSettlementInput): ManualSettlementView {
		const now = Date.now();
		const settlementId = input.settlementId || generateSettlementId();
		const row: Omit<ManualSettlementRow, 'id'> = {
			settlement_id: settlementId,
			workspace_id: input.workspaceId || DEFAULT_WORKSPACE_ID,
			settlement_kind: input.settlementKind,
			channel_id: input.channelId ?? null,
			created_by_user_id: Math.floor(input.createdByUserId),
			counterparty_user_id:
				input.counterpartyUserId == null ? null : Math.floor(input.counterpartyUserId),
			donor_label: input.donorLabel ?? null,
			amount_minor: Math.floor(input.amountMinor),
			currency: input.currency.toUpperCase(),
			description: input.description ?? null,
			status: input.status,
			metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
			creator_confirmed_at: null,
			counterparty_confirmed_at: null,
			completed_at: input.status === 'completed' || input.status === 'recorded' ? now : null,
			voided_at: input.status === 'voided' ? now : null,
			created_at: now,
			updated_at: now
		};

		db.prepare(`
			INSERT INTO manual_settlements (
				settlement_id,
				workspace_id,
				settlement_kind,
				channel_id,
				created_by_user_id,
				counterparty_user_id,
				donor_label,
				amount_minor,
				currency,
				description,
				status,
				metadata_json,
				creator_confirmed_at,
				counterparty_confirmed_at,
				completed_at,
				voided_at,
				created_at,
				updated_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			row.settlement_id,
			row.workspace_id,
			row.settlement_kind,
			row.channel_id,
			row.created_by_user_id,
			row.counterparty_user_id,
			row.donor_label,
			row.amount_minor,
			row.currency,
			row.description,
			row.status,
			row.metadata_json,
			row.creator_confirmed_at,
			row.counterparty_confirmed_at,
			row.completed_at,
			row.voided_at,
			row.created_at,
			row.updated_at
		);

		const created = this.findBySettlementIdLegacy(settlementId);
		if (!created) {
			throw new Error(`manual_settlement_create_failed:${settlementId}`);
		}
		if (stdbPaymentsEnabled()) {
			this.upsertStdbSettlement(created);
		}
		return toView(created);
	}

	updateSettlement(
		settlementId: string,
		updates: {
			status?: ManualSettlementStatus;
			description?: string | null;
			donorLabel?: string | null;
			metadata?: Record<string, unknown> | null;
			creatorConfirmedAt?: number | null;
			counterpartyConfirmedAt?: number | null;
			completedAt?: number | null;
			voidedAt?: number | null;
		}
	): boolean {
		const existing = this.findBySettlementId(settlementId);
		if (!existing) return false;
		const existingMetadata = safeParseJson(existing.metadata_json);
		const mergedMetadata =
			updates.metadata && existingMetadata
				? { ...existingMetadata, ...updates.metadata }
				: updates.metadata ?? existingMetadata;
		const result = db
			.prepare(`
				UPDATE manual_settlements
				SET
					status = COALESCE(?, status),
					description = COALESCE(?, description),
					donor_label = COALESCE(?, donor_label),
					metadata_json = ?,
					creator_confirmed_at = COALESCE(?, creator_confirmed_at),
					counterparty_confirmed_at = COALESCE(?, counterparty_confirmed_at),
					completed_at = COALESCE(?, completed_at),
					voided_at = COALESCE(?, voided_at),
					updated_at = ?
				WHERE settlement_id = ?
			`)
			.run(
				updates.status ?? null,
				updates.description ?? null,
				updates.donorLabel ?? null,
				mergedMetadata ? JSON.stringify(mergedMetadata) : null,
				updates.creatorConfirmedAt ?? null,
				updates.counterpartyConfirmedAt ?? null,
				updates.completedAt ?? null,
				updates.voidedAt ?? null,
				Date.now(),
				settlementId
			);
		const updated = (result.changes || 0) > 0;
		if (updated && stdbPaymentsEnabled()) {
			const row = this.findBySettlementIdLegacy(settlementId);
			if (row) this.upsertStdbSettlement(row);
		}
		return updated;
	}

	listDmCashForChannel(channelId: string, limit = 100): ManualCashConversationRow[] {
		const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
		if (stdbPaymentsEnabled()) {
			const shadow = this.listDmCashForChannelStdb(channelId, safeLimit);
			if (shadow.length > 0) return shadow;
			const legacy = this.listDmCashForChannelLegacy(channelId, safeLimit);
			for (const row of legacy) {
				this.upsertStdbSettlement(row);
			}
			return legacy;
		}
		return this.listDmCashForChannelLegacy(channelId, safeLimit);
	}

	summarizeOfflineDonations(workspaceId: string = DEFAULT_WORKSPACE_ID): Array<{
		currency: string;
		amount_minor: number;
		payment_count: number;
	}> {
		if (stdbPaymentsEnabled()) {
			const shadow = this.summarizeOfflineDonationsStdb(workspaceId);
			if (shadow.length > 0) return shadow;
			const legacy = this.summarizeOfflineDonationsLegacy(workspaceId);
			const backfill = this.listOfflineDonationsLegacy(workspaceId, 1000);
			for (const row of backfill) {
				this.upsertStdbSettlement(row);
			}
			return legacy;
		}
		return this.summarizeOfflineDonationsLegacy(workspaceId);
	}

	listOfflineDonations(
		workspaceId: string = DEFAULT_WORKSPACE_ID,
		limit = 50
	): OfflineDonationRecordRow[] {
		const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
		if (stdbPaymentsEnabled()) {
			const shadow = this.listOfflineDonationsStdb(workspaceId, safeLimit);
			if (shadow.length > 0) return shadow;
			const legacy = this.listOfflineDonationsLegacy(workspaceId, safeLimit);
			for (const row of legacy) {
				this.upsertStdbSettlement(row);
			}
			return legacy;
		}
		return this.listOfflineDonationsLegacy(workspaceId, safeLimit);
	}
}

export const manualSettlementRepository = new ManualSettlementRepository();
