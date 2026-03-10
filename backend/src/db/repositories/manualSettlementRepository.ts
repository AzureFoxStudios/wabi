import { randomUUID } from 'crypto';
import db from '../database.js';
import { DEFAULT_WORKSPACE_ID } from '../../constants.js';

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

export class ManualSettlementRepository {
	findBySettlementId(settlementId: string): ManualSettlementRow | null {
		const row = db
			.prepare('SELECT * FROM manual_settlements WHERE settlement_id = ? LIMIT 1')
			.get(settlementId) as ManualSettlementRow | undefined;
		return row || null;
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

		const created = this.findViewBySettlementId(settlementId);
		if (!created) {
			throw new Error(`manual_settlement_create_failed:${settlementId}`);
		}
		return created;
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
		const mergedMetadata =
			updates.metadata && safeParseJson(existing.metadata_json)
				? { ...safeParseJson(existing.metadata_json), ...updates.metadata }
				: updates.metadata ?? safeParseJson(existing.metadata_json);
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
		return (result.changes || 0) > 0;
	}

	listDmCashForChannel(channelId: string, limit = 100): ManualCashConversationRow[] {
		const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
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
			.all(channelId, safeLimit) as ManualCashConversationRow[];
	}

	summarizeOfflineDonations(workspaceId: string = DEFAULT_WORKSPACE_ID): Array<{
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

	listOfflineDonations(
		workspaceId: string = DEFAULT_WORKSPACE_ID,
		limit = 50
	): OfflineDonationRecordRow[] {
		const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
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
			.all(workspaceId, safeLimit) as OfflineDonationRecordRow[];
	}
}

export const manualSettlementRepository = new ManualSettlementRepository();
