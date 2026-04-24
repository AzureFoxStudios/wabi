import type { IncomingMessage, ServerResponse } from 'http';
import { getAuthenticatedUserIdFromRequest } from '../auth/requestAuth.js';
import { DEFAULT_WORKSPACE_ID } from '../constants.js';
import {
	stateChannelMemberStore,
	stateChannelStore
} from '../state-plane/index.js';
import {
	manualSettlementRepository,
	type ManualCashConversationRow,
	type ManualSettlementStatus
} from '../db/repositories/manualSettlementRepository.js';
import { notifyManualCashUpdated } from '../payments/realtime.js';
import {
	isInvalidJsonBodyError as isJsonParseError,
	isRequestBodyTooLargeError as isPayloadTooLargeError,
	readJsonObjectBody
} from '../utils/requestBodies.js';

const MAX_MANUAL_SETTLEMENT_BODY_BYTES = Math.max(
	1024,
	Math.min(256 * 1024, Number(process.env.MANUAL_SETTLEMENT_MAX_BODY_BYTES || 64 * 1024))
);

const DM_CASH_TERMINAL_STATUSES = new Set<ManualSettlementStatus>(['completed', 'canceled', 'disputed']);

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(payload));
}

async function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	return await readJsonObjectBody(req, MAX_MANUAL_SETTLEMENT_BODY_BYTES);
}

function clampPositiveInteger(value: unknown, max: number): number | null {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return null;
	const rounded = Math.floor(parsed);
	if (rounded <= 0 || rounded > max) return null;
	return rounded;
}

function normalizeOptionalString(value: unknown, maxLen: number): string | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim();
	if (!normalized) return null;
	return normalized.slice(0, maxLen);
}

function toUpperCode(value: unknown, expectedLen: number): string | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim().toUpperCase();
	if (normalized.length !== expectedLen || !/^[A-Z]+$/.test(normalized)) {
		return null;
	}
	return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeMetadata(value: unknown): Record<string, unknown> | null {
	if (!isRecord(value)) return null;
	return value;
}

function resolveDmCashChannelContext(
	userId: number,
	channelId: string
): { otherUserId: number; otherUsername: string | null } | { error: string; status: number } {
	const channel = stateChannelStore.findById(channelId);
	if (!channel) {
		return { status: 404, error: 'DM channel not found' };
	}
	if (channel.channel_type !== 'dm') {
		return { status: 400, error: 'Manual cash trades are only available in direct messages' };
	}

	const stableUserId = `user-${userId}`;
	if (!stateChannelMemberStore.isMember(channelId, stableUserId)) {
		return { status: 403, error: 'You are not a member of this DM' };
	}

	const members = stateChannelMemberStore.getMembers(channelId);
	const otherMember = members.find(
		(member) => member.user_id !== stableUserId && Number.isFinite(member.registered_user_id)
	);
	if (!otherMember || !otherMember.registered_user_id) {
		return { status: 409, error: 'This DM does not have a registered counterparty for manual cash confirmation' };
	}

	return {
		otherUserId: Math.floor(otherMember.registered_user_id),
		otherUsername: typeof otherMember.username === 'string' ? otherMember.username : null
	};
}

function toManualCashResponse(row: ManualCashConversationRow, viewerUserId: number): Record<string, unknown> {
	const isCreator = row.created_by_user_id === viewerUserId;
	const isCounterparty = row.counterparty_user_id === viewerUserId;
	const canConfirm =
		!DM_CASH_TERMINAL_STATUSES.has(row.status) &&
		((isCreator && !row.creator_confirmed_at) || (isCounterparty && !row.counterparty_confirmed_at));
	const canCancel = !DM_CASH_TERMINAL_STATUSES.has(row.status) && (isCreator || isCounterparty);
	const canDispute = row.status !== 'canceled' && row.status !== 'disputed';

	return {
		settlementId: row.settlement_id,
		channelId: row.channel_id,
		amountMinor: Number(row.amount_minor || 0),
		currency: row.currency,
		description: row.description,
		status: row.status,
		createdByUserId: row.created_by_user_id,
		counterpartyUserId: row.counterparty_user_id,
		creatorLabel: row.creator_username || 'Unknown',
		counterpartyLabel: row.counterparty_username || 'Unknown',
		creatorConfirmedAt: row.creator_confirmed_at,
		counterpartyConfirmedAt: row.counterparty_confirmed_at,
		completedAt: row.completed_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		viewerRole: isCreator ? 'creator' : isCounterparty ? 'counterparty' : 'observer',
		canConfirm,
		canCancel,
		canDispute
	};
}

function getNextConfirmationState(row: ManualCashConversationRow, actorUserId: number): {
	status: ManualSettlementStatus;
	creatorConfirmedAt?: number | null;
	counterpartyConfirmedAt?: number | null;
	completedAt?: number | null;
} {
	const now = Date.now();
	const creatorConfirmedAt =
		row.created_by_user_id === actorUserId ? row.creator_confirmed_at || now : row.creator_confirmed_at;
	const counterpartyConfirmedAt =
		row.counterparty_user_id === actorUserId ? row.counterparty_confirmed_at || now : row.counterparty_confirmed_at;

	if (creatorConfirmedAt && counterpartyConfirmedAt) {
		return {
			status: 'completed',
			creatorConfirmedAt,
			counterpartyConfirmedAt,
			completedAt: row.completed_at || now
		};
	}

	return {
		status: row.created_by_user_id === actorUserId ? 'confirmed_by_creator' : 'confirmed_by_counterparty',
		creatorConfirmedAt,
		counterpartyConfirmedAt
	};
}

export async function handleListManualCashSettlements(
	req: IncomingMessage,
	res: ServerResponse,
	channelId: string,
	url: URL
): Promise<void> {
	const userId = getAuthenticatedUserIdFromRequest(req);
	if (!userId) {
		writeJson(res, 401, { success: false, error: 'Unauthorized' });
		return;
	}

	const context = resolveDmCashChannelContext(userId, channelId);
	if ('error' in context) {
		writeJson(res, context.status, { success: false, error: context.error });
		return;
	}

	try {
		const limit = clampPositiveInteger(url.searchParams.get('limit'), 500) ?? 100;
		const items = manualSettlementRepository
			.listDmCashForChannel(channelId, limit)
			.filter(
				(row) =>
					row.created_by_user_id === userId ||
					row.counterparty_user_id === userId ||
					row.counterparty_user_id === context.otherUserId
			)
			.map((row) => toManualCashResponse(row, userId));
		writeJson(res, 200, {
			success: true,
			count: items.length,
			items
		});
	} catch (error) {
		console.error('[ManualCash] Failed to list settlements:', error);
		writeJson(res, 500, { success: false, error: 'Failed to load manual cash history' });
	}
}

export async function handleCreateManualCashSettlement(
	req: IncomingMessage,
	res: ServerResponse
): Promise<void> {
	const userId = getAuthenticatedUserIdFromRequest(req);
	if (!userId) {
		writeJson(res, 401, { success: false, error: 'Unauthorized' });
		return;
	}

	let body: Record<string, unknown>;
	try {
		body = await parseJsonBody(req);
	} catch (error) {
		if (isPayloadTooLargeError(error)) {
			writeJson(res, 413, { success: false, error: 'Payload too large' });
			return;
		}
		if (isJsonParseError(error)) {
			writeJson(res, 400, { success: false, error: 'Invalid JSON' });
			return;
		}
		writeJson(res, 400, { success: false, error: 'Invalid manual cash payload' });
		return;
	}

	const channelId = normalizeOptionalString(body.channelId, 120);
	const amountMinor = clampPositiveInteger(body.amountMinor, 1_000_000_000);
	const currency = toUpperCode(body.currency, 3);
	const description = normalizeOptionalString(body.description, 280);
	const metadata = normalizeMetadata(body.metadata);

	if (!channelId || !amountMinor || !currency) {
		writeJson(res, 400, { success: false, error: 'channelId, amountMinor, and currency are required' });
		return;
	}

	const context = resolveDmCashChannelContext(userId, channelId);
	if ('error' in context) {
		writeJson(res, context.status, { success: false, error: context.error });
		return;
	}

	try {
		const created = manualSettlementRepository.createSettlement({
			workspaceId: DEFAULT_WORKSPACE_ID,
			settlementKind: 'dm_cash',
			channelId,
			createdByUserId: userId,
			counterpartyUserId: context.otherUserId,
			amountMinor,
			currency,
			description,
			status: 'pending',
			metadata
		});
		const row = manualSettlementRepository.listDmCashForChannel(channelId, 1).find(
			(item) => item.settlement_id === created.settlement_id
		);
		writeJson(res, 201, {
			success: true,
			settlement: row
				? toManualCashResponse(row, userId)
				: {
						settlementId: created.settlement_id,
						channelId: created.channel_id,
						amountMinor: created.amount_minor,
						currency: created.currency,
						description: created.description,
						status: created.status,
						createdByUserId: created.created_by_user_id,
						counterpartyUserId: created.counterparty_user_id,
						creatorConfirmedAt: created.creator_confirmed_at,
						counterpartyConfirmedAt: created.counterparty_confirmed_at,
						completedAt: created.completed_at,
						createdAt: created.created_at,
						updatedAt: created.updated_at,
						viewerRole: 'creator',
						canConfirm: true,
						canCancel: true,
						canDispute: true
				  }
		});
		notifyManualCashUpdated({
			workspaceId: DEFAULT_WORKSPACE_ID,
			settlementId: created.settlement_id,
			channelId,
			participantUserIds: [userId, context.otherUserId],
			status: created.status
		});
	} catch (error) {
		console.error('[ManualCash] Failed to create settlement:', error);
		writeJson(res, 500, { success: false, error: 'Failed to create manual cash trade' });
	}
}

async function handleManualCashStateMutation(
	req: IncomingMessage,
	res: ServerResponse,
	settlementId: string,
	action: 'confirm' | 'cancel' | 'dispute'
): Promise<void> {
	const userId = getAuthenticatedUserIdFromRequest(req);
	if (!userId) {
		writeJson(res, 401, { success: false, error: 'Unauthorized' });
		return;
	}

	const settlement = manualSettlementRepository.findViewBySettlementId(settlementId);
	if (!settlement || settlement.settlement_kind !== 'dm_cash') {
		writeJson(res, 404, { success: false, error: 'Manual cash trade not found' });
		return;
	}
	if (settlement.created_by_user_id !== userId && settlement.counterparty_user_id !== userId) {
		writeJson(res, 403, { success: false, error: 'Not a participant in this manual cash trade' });
		return;
	}

	const context = resolveDmCashChannelContext(userId, settlement.channel_id || '');
	if ('error' in context) {
		writeJson(res, context.status, { success: false, error: context.error });
		return;
	}

	const row = manualSettlementRepository
		.listDmCashForChannel(settlement.channel_id || '', 250)
		.find((item) => item.settlement_id === settlementId);
	if (!row) {
		writeJson(res, 404, { success: false, error: 'Manual cash trade not found' });
		return;
	}

	let metadata: Record<string, unknown> | null = null;
	try {
		const body = await parseJsonBody(req);
		const reason = normalizeOptionalString(body.reason, 280);
		metadata = reason ? { lastActionReason: reason, lastActionByUserId: userId } : { lastActionByUserId: userId };
	} catch (error) {
		if (isPayloadTooLargeError(error)) {
			writeJson(res, 413, { success: false, error: 'Payload too large' });
			return;
		}
		if (!isJsonParseError(error)) {
			writeJson(res, 400, { success: false, error: 'Invalid manual cash action payload' });
			return;
		}
	}

	if (action === 'confirm') {
		if (DM_CASH_TERMINAL_STATUSES.has(row.status)) {
			writeJson(res, 409, { success: false, error: `Manual cash trade cannot be confirmed from status ${row.status}` });
			return;
		}
		const next = getNextConfirmationState(row, userId);
		manualSettlementRepository.updateSettlement(settlementId, {
			status: next.status,
			creatorConfirmedAt: next.creatorConfirmedAt,
			counterpartyConfirmedAt: next.counterpartyConfirmedAt,
			completedAt: next.completedAt,
			metadata
		});
	} else if (action === 'cancel') {
		if (DM_CASH_TERMINAL_STATUSES.has(row.status)) {
			writeJson(res, 409, { success: false, error: `Manual cash trade cannot be canceled from status ${row.status}` });
			return;
		}
		manualSettlementRepository.updateSettlement(settlementId, {
			status: 'canceled',
			metadata
		});
	} else {
		if (row.status === 'canceled' || row.status === 'disputed') {
			writeJson(res, 409, { success: false, error: `Manual cash trade cannot be disputed from status ${row.status}` });
			return;
		}
		manualSettlementRepository.updateSettlement(settlementId, {
			status: 'disputed',
			metadata
		});
	}

	const updatedRow = manualSettlementRepository
		.listDmCashForChannel(settlement.channel_id || '', 250)
		.find((item) => item.settlement_id === settlementId);
	if (!updatedRow) {
		writeJson(res, 500, { success: false, error: 'Manual cash trade disappeared after update' });
		return;
	}

	writeJson(res, 200, {
		success: true,
		settlement: toManualCashResponse(updatedRow, userId)
	});
	notifyManualCashUpdated({
		workspaceId: DEFAULT_WORKSPACE_ID,
		settlementId,
		channelId: updatedRow.channel_id || '',
		participantUserIds: [updatedRow.created_by_user_id, updatedRow.counterparty_user_id || 0].filter(
			(value): value is number => Number.isFinite(value) && value > 0
		),
		status: updatedRow.status
	});
}

export async function handleConfirmManualCashSettlement(
	req: IncomingMessage,
	res: ServerResponse,
	settlementId: string
): Promise<void> {
	await handleManualCashStateMutation(req, res, settlementId, 'confirm');
}

export async function handleCancelManualCashSettlement(
	req: IncomingMessage,
	res: ServerResponse,
	settlementId: string
): Promise<void> {
	await handleManualCashStateMutation(req, res, settlementId, 'cancel');
}

export async function handleDisputeManualCashSettlement(
	req: IncomingMessage,
	res: ServerResponse,
	settlementId: string
): Promise<void> {
	await handleManualCashStateMutation(req, res, settlementId, 'dispute');
}
