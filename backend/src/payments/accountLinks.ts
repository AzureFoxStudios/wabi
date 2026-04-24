import { DEFAULT_WORKSPACE_ID } from '../constants.js';
import { stdbPaymentIngest, stdbPaymentRows, stdbPaymentsEnabled, parseStdbRowJson } from './stdbRuntime.js';
import { escapeSqlLiteral } from '../state-plane/stdbSyncClient.js';
import type { PaymentAccountLink } from '../../../shared/adminPolicyContracts.js';

export type { PaymentAccountLink } from '../../../shared/adminPolicyContracts.js';

function safeParseMetadata(value: string | null): Record<string, unknown> | null {
	if (!value) return null;
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

function normalizeStdbPaymentAccountLink(row: Partial<PaymentAccountLink> | null | undefined): PaymentAccountLink | null {
	const userId = Number(row?.userId);
	const workspaceId = typeof row?.workspaceId === 'string' ? row.workspaceId : DEFAULT_WORKSPACE_ID;
	const pluginId = typeof row?.pluginId === 'string' ? row.pluginId.trim() : '';
	const providerAccountRef =
		typeof row?.providerAccountRef === 'string' ? row.providerAccountRef.trim() : '';
	if (!Number.isFinite(userId) || userId <= 0 || !pluginId || !providerAccountRef) {
		return null;
	}
	return {
		userId: Math.floor(userId),
		workspaceId,
		pluginId,
		providerAccountRef,
		displayLabel:
			typeof row?.displayLabel === 'string' && row.displayLabel.trim().length > 0
				? row.displayLabel
				: null,
		metadata:
			row?.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
				? row.metadata
				: null,
		linkedAt: Number(row?.linkedAt || 0),
		updatedAt: Number(row?.updatedAt || 0)
	};
}

function sortPaymentAccountLinksByUpdatedAtDesc(left: PaymentAccountLink, right: PaymentAccountLink): number {
	const diff = right.updatedAt - left.updatedAt;
	if (diff !== 0) return diff;
	return left.pluginId.localeCompare(right.pluginId);
}

function getPaymentAccountLinkStdb(
	userId: number,
	pluginId: string,
	workspaceId: string
): PaymentAccountLink | null {
	const rows = stdbPaymentRows(
		'payment_account_links.read_single',
		`SELECT row_json FROM state_payment_account_link WHERE user_id = ${Math.floor(userId)} AND workspace_id = ${escapeSqlLiteral(workspaceId)} AND plugin_id = ${escapeSqlLiteral(pluginId)} LIMIT 1`
	);
	return rows && rows.length > 0
		? normalizeStdbPaymentAccountLink(parseStdbRowJson<PaymentAccountLink>(rows[0]))
		: null;
}

function listPaymentAccountLinksStdb(userId: number, workspaceId: string): PaymentAccountLink[] {
	const rows = stdbPaymentRows(
		'payment_account_links.list',
		`SELECT row_json FROM state_payment_account_link WHERE user_id = ${Math.floor(userId)} AND workspace_id = ${escapeSqlLiteral(workspaceId)}`
	);
	return (rows || [])
		.map((row) => normalizeStdbPaymentAccountLink(parseStdbRowJson<PaymentAccountLink>(row)))
		.filter((row): row is PaymentAccountLink => Boolean(row))
		.sort(sortPaymentAccountLinksByUpdatedAtDesc);
}

function upsertPaymentAccountLinkStdb(link: PaymentAccountLink): void {
	stdbPaymentIngest('payment_account_links.write', 'upsert_account_link', {
		userId: link.userId,
		pluginId: link.pluginId,
		workspaceId: link.workspaceId,
		row: link
	});
}

function deletePaymentAccountLinkStdb(userId: number, pluginId: string, workspaceId: string): void {
	stdbPaymentIngest('payment_account_links.delete', 'delete_account_link', {
		userId: Math.floor(userId),
		pluginId,
		workspaceId
	});
}

export function getPaymentAccountLink(
	userId: number,
	pluginId: string,
	workspaceId: string = DEFAULT_WORKSPACE_ID
): PaymentAccountLink | null {
	if (!stdbPaymentsEnabled()) {
		return null;
	}
	return getPaymentAccountLinkStdb(userId, pluginId, workspaceId);
}

export function listPaymentAccountLinks(
	userId: number,
	workspaceId: string = DEFAULT_WORKSPACE_ID
): PaymentAccountLink[] {
	if (!stdbPaymentsEnabled()) {
		return [];
	}
	return listPaymentAccountLinksStdb(userId, workspaceId);
}

export function upsertPaymentAccountLink(input: {
	userId: number;
	pluginId: string;
	providerAccountRef: string;
	displayLabel?: string | null;
	metadata?: Record<string, unknown> | null;
}): PaymentAccountLink | null {
	const userId = Math.floor(input.userId);
	const workspaceId = DEFAULT_WORKSPACE_ID;
	const pluginId = String(input.pluginId || '').trim();
	const providerAccountRef = String(input.providerAccountRef || '').trim();
	const displayLabel = typeof input.displayLabel === 'string' ? input.displayLabel.trim().slice(0, 160) : null;
	const metadataJson =
		input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
			? JSON.stringify(input.metadata)
			: null;

	if (!pluginId || !providerAccountRef) return null;
	if (!stdbPaymentsEnabled()) return null;

	upsertPaymentAccountLinkStdb({
		userId,
		workspaceId,
		pluginId,
		providerAccountRef,
		displayLabel,
		metadata: input.metadata || null,
		linkedAt: Date.now(),
		updatedAt: Date.now()
	});

	return getPaymentAccountLink(userId, pluginId, workspaceId);
}

export function deletePaymentAccountLink(
	userId: number,
	pluginId: string,
	workspaceId: string = DEFAULT_WORKSPACE_ID
): boolean {
	if (!stdbPaymentsEnabled()) return false;
	deletePaymentAccountLinkStdb(userId, pluginId, workspaceId);
	return true;
}