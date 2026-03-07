import db from '../db/database.js';
import { DEFAULT_WORKSPACE_ID } from '../constants.js';

export interface PaymentUserBlock {
	userId: number;
	workspaceId: string;
	reason: string | null;
	blockedByUserId: number | null;
	blockedByUsername: string | null;
	blockedUsername: string | null;
	blockedAt: number;
	expiresAt: number | null;
}

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
					pb.expires_at,
					u.username AS blocked_username,
					actor.username AS blocked_by_username
				FROM payment_user_blocks pb
				LEFT JOIN users u ON u.user_id = pb.user_id
				LEFT JOIN users actor ON actor.user_id = pb.blocked_by_user_id
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
	const rows = db
		.prepare(
			`
				SELECT
					pb.user_id,
					pb.workspace_id,
					pb.reason,
					pb.blocked_by_user_id,
					pb.blocked_at,
					pb.expires_at,
					u.username AS blocked_username,
					actor.username AS blocked_by_username
				FROM payment_user_blocks pb
				LEFT JOIN users u ON u.user_id = pb.user_id
				LEFT JOIN users actor ON actor.user_id = pb.blocked_by_user_id
				WHERE pb.workspace_id = ?
				ORDER BY pb.blocked_at DESC
				LIMIT ?
			`
		)
		.all(workspaceId, safeLimit) as PaymentUserBlockRow[];
	return rows.map(toPaymentUserBlock);
}

export function clearPaymentUserBlock(userId: number, workspaceId: string = DEFAULT_WORKSPACE_ID): boolean {
	const result = db
		.prepare('DELETE FROM payment_user_blocks WHERE user_id = ? AND workspace_id = ?')
		.run(Math.floor(userId), workspaceId);
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
	return created ? toPaymentUserBlock(created) : null;
}

export function getActivePaymentUserBlock(
	userId: number,
	workspaceId: string = DEFAULT_WORKSPACE_ID,
	now = Date.now()
): PaymentUserBlock | null {
	const row = fetchRawBlock(Math.floor(userId), workspaceId);
	if (!row) return null;
	if (row.expires_at != null && Number(row.expires_at) <= now) {
		clearPaymentUserBlock(Math.floor(userId), workspaceId);
		return null;
	}
	return toPaymentUserBlock(row);
}

