import db from '../db/database.js';
import { DEFAULT_WORKSPACE_ID } from '../constants.js';
import { stdbPaymentIngest, stdbPaymentRows, stdbPaymentsEnabled, parseStdbRowJson, lookupStdbUsername } from './stdbRuntime.js';
import { escapeSqlLiteral } from '../state-plane/stdbSyncClient.js';
import { stateUserStore } from '../state-plane/index.js';
import type { PaymentUserBlock } from '../../../shared/paymentContracts.js';

interface PaymentUserBlockRow {
	user_id: number;
	workspace_id: string;
	reason: string | null;
	blocked_by_user_id: number | null;
	blocked_by_username?: string | null;
	blocked_username?: string | null;
	blocked_at: number;
	expires_at: number | null;
}

function toPaymentUserBlock(row: PaymentUserBlockRow): PaymentUserBlock {
	return {
		userId: Number(row.user_id),
		workspaceId: String(row.workspace_id || DEFAULT_WORKSPACE_ID),
		reason: typeof row.reason === 'string' && row.reason.trim().length > 0 ? row.reason : null,
		blockedByUserId: row.blocked_by_user_id == null ? null : Number(row.blocked_by_user_id),
		blockedByUsername:
			typeof row.blocked_by_username === 'string' && row.blocked_by_username.trim().length > 0
				? row.blocked_by_username
				: null,
		blockedUsername:
			typeof row.blocked_username === 'string' && row.blocked_username.trim().length > 0
				? row.blocked_username
				: null,
		blockedAt: Number(row.blocked_at || 0),
		expiresAt: row.expires_at == null ? null : Number(row.expires_at)
	};
}

function normalizeStdbPaymentUserBlock(
	row: Partial<PaymentUserBlock> | null | undefined
): PaymentUserBlock | null {
	const userId = Number(row?.userId);
	const workspaceId = typeof row?.workspaceId === 'string' ? row.workspaceId : DEFAULT_WORKSPACE_ID;
	if (!Number.isFinite(userId) || userId <= 0) return null;
	return {
		userId: Math.floor(userId),
		workspaceId,
		reason: typeof row?.reason === 'string' && row.reason.trim().length > 0 ? row.reason : null,
		blockedByUserId:
			row?.blockedByUserId == null || !Number.isFinite(row.blockedByUserId)
				? null
				: Math.floor(Number(row.blockedByUserId)),
		blockedByUsername:
			typeof row?.blockedByUsername === 'string' && row.blockedByUsername.trim().length > 0
				? row.blockedByUsername
				: null,
		blockedUsername:
			typeof row?.blockedUsername === 'string' && row.blockedUsername.trim().length > 0
				? row.blockedUsername
				: null,
		blockedAt: Number(row?.blockedAt || 0),
		expiresAt: row?.expiresAt == null || !Number.isFinite(row.expiresAt) ? null : Number(row.expiresAt)
	};
}

function hydrateStdbUsernames(block: PaymentUserBlock): PaymentUserBlock {
	return {
		...block,
		blockedByUsername: block.blockedByUsername || lookupStdbUsername(block.blockedByUserId),
		blockedUsername: block.blockedUsername || lookupStdbUsername(block.userId)
	};
}

function lookupLocalUsername(userId: number | null | undefined): string | null {
	if (!Number.isFinite(userId) || !userId || userId <= 0) return null;
	const user = stateUserStore.findById(Math.floor(userId));
	return typeof user?.username === 'string' && user.username.trim().length > 0 ? user.username : null;
}

function hydrateLocalUsernames(block: PaymentUserBlock): PaymentUserBlock {
	return {
		...block,
		blockedByUsername: block.blockedByUsername || lookupLocalUsername(block.blockedByUserId),
		blockedUsername: block.blockedUsername || lookupLocalUsername(block.userId)
	};
}

function sortPaymentUserBlocksByBlockedAtDesc(left: PaymentUserBlock, right: PaymentUserBlock): number {
	const diff = right.blockedAt - left.blockedAt;
	if (diff !== 0) return diff;
	return right.userId - left.userId;
}

function fetchRawBlockStdb(userId: number, workspaceId: string): PaymentUserBlock | null {
	const rows = stdbPaymentRows(
		'payment_user_blocks.read_single',
		`SELECT row_json FROM state_payment_user_block WHERE user_id = ${Math.floor(userId)} AND workspace_id = ${escapeSqlLiteral(workspaceId)} LIMIT 1`
	);
	if (!rows || rows.length === 0) return null;
	const parsed = normalizeStdbPaymentUserBlock(parseStdbRowJson<PaymentUserBlock>(rows[0]));
	return parsed ? hydrateStdbUsernames(parsed) : null;
}

function listPaymentUserBlocksStdb(
	workspaceId: string,
	limit: number
): PaymentUserBlock[] {
	const rows = stdbPaymentRows(
		'payment_user_blocks.list',
		`SELECT row_json FROM state_payment_user_block WHERE workspace_id = ${escapeSqlLiteral(workspaceId)}`
	);
	return (rows || [])
		.map((row) => normalizeStdbPaymentUserBlock(parseStdbRowJson<PaymentUserBlock>(row)))
		.filter((row): row is PaymentUserBlock => Boolean(row))
		.map(hydrateStdbUsernames)
		.sort(sortPaymentUserBlocksByBlockedAtDesc)
		.slice(0, limit);
}

function upsertPaymentUserBlockStdb(block: PaymentUserBlock): void {
	stdbPaymentIngest('payment_user_blocks.write', 'upsert_user_block', {
		userId: block.userId,
		workspaceId: block.workspaceId,
		row: block
	});
}

function deletePaymentUserBlockStdb(userId: number, workspaceId: string): void {
	stdbPaymentIngest('payment_user_blocks.delete', 'delete_user_block', {
		userId: Math.floor(userId),
		workspaceId
	});
}

function fetchRawBlock(userId: number, workspaceId: string): PaymentUserBlockRow | null {
	const row = db
		.prepare(
			`
				SELECT
					pb.user_id,
					pb.workspace_id,
					pb.reason,
					pb.blocked_by_user_id,
					pb.blocked_at,
					pb.expires_at
				FROM payment_user_blocks pb
				WHERE pb.user_id = ? AND pb.workspace_id = ?
				LIMIT 1
			`
		)
		.get(userId, workspaceId) as PaymentUserBlockRow | undefined;
	return row || null;
}

export function listPaymentUserBlocks(
	workspaceId: string = DEFAULT_WORKSPACE_ID,
	limit = 500
): PaymentUserBlock[] {
	const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(5000, Math.floor(limit))) : 500;
	if (stdbPaymentsEnabled()) {
		const shadow = listPaymentUserBlocksStdb(workspaceId, safeLimit);
		if (shadow.length > 0) return shadow;
	}
	const rows = db
		.prepare(
			`
				SELECT
					pb.user_id,
					pb.workspace_id,
					pb.reason,
					pb.blocked_by_user_id,
					pb.blocked_at,
					pb.expires_at
				FROM payment_user_blocks pb
				WHERE pb.workspace_id = ?
				ORDER BY pb.blocked_at DESC
				LIMIT ?
			`
		)
		.all(workspaceId, safeLimit) as PaymentUserBlockRow[];
	const legacy = rows.map((row) => hydrateLocalUsernames(toPaymentUserBlock(row)));
	if (stdbPaymentsEnabled()) {
		for (const row of legacy) {
			upsertPaymentUserBlockStdb(row);
		}
	}
	return legacy;
}

export function clearPaymentUserBlock(userId: number, workspaceId: string = DEFAULT_WORKSPACE_ID): boolean {
	const result = db
		.prepare('DELETE FROM payment_user_blocks WHERE user_id = ? AND workspace_id = ?')
		.run(Math.floor(userId), workspaceId);
	if (stdbPaymentsEnabled()) {
		deletePaymentUserBlockStdb(userId, workspaceId);
	}
	return (result.changes || 0) > 0;
}

export function upsertPaymentUserBlock(input: {
	userId: number;
	workspaceId?: string;
	blockedByUserId?: number | null;
	reason?: string | null;
	expiresAt?: number | null;
}): PaymentUserBlock | null {
	const userId = Math.floor(input.userId);
	const workspaceId = input.workspaceId || DEFAULT_WORKSPACE_ID;
	const blockedAt = Date.now();
	const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 512) : null;
	const blockedByUserId =
		input.blockedByUserId == null || !Number.isFinite(input.blockedByUserId)
			? null
			: Math.floor(input.blockedByUserId);
	const expiresAt =
		input.expiresAt == null || !Number.isFinite(input.expiresAt)
			? null
			: Math.floor(input.expiresAt);

	db.prepare(
		`
			INSERT INTO payment_user_blocks (
				user_id,
				workspace_id,
				reason,
				blocked_by_user_id,
				blocked_at,
				expires_at
			)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(user_id, workspace_id) DO UPDATE SET
				reason = excluded.reason,
				blocked_by_user_id = excluded.blocked_by_user_id,
				blocked_at = excluded.blocked_at,
				expires_at = excluded.expires_at
		`
	).run(userId, workspaceId, reason, blockedByUserId, blockedAt, expiresAt);

	const created = fetchRawBlock(userId, workspaceId);
	const block = created ? hydrateLocalUsernames(toPaymentUserBlock(created)) : null;
	if (block && stdbPaymentsEnabled()) {
		upsertPaymentUserBlockStdb(block);
	}
	return block;
}

export function getActivePaymentUserBlock(
	userId: number,
	workspaceId: string = DEFAULT_WORKSPACE_ID,
	now = Date.now()
): PaymentUserBlock | null {
	if (stdbPaymentsEnabled()) {
		const shadow = fetchRawBlockStdb(Math.floor(userId), workspaceId);
		if (shadow) {
			if (shadow.expiresAt != null && Number(shadow.expiresAt) <= now) {
				clearPaymentUserBlock(Math.floor(userId), workspaceId);
				return null;
			}
			return shadow;
		}
	}
	const row = fetchRawBlock(Math.floor(userId), workspaceId);
	if (!row) return null;
	if (row.expires_at != null && Number(row.expires_at) <= now) {
		clearPaymentUserBlock(Math.floor(userId), workspaceId);
		return null;
	}
	const legacy = hydrateLocalUsernames(toPaymentUserBlock(row));
	if (stdbPaymentsEnabled()) {
		upsertPaymentUserBlockStdb(legacy);
	}
	return legacy;
}
