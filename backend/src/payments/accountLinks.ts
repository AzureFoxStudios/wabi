import db from '../db/database.js';
import { DEFAULT_WORKSPACE_ID } from '../constants.js';
import { stdbPaymentIngest, stdbPaymentRows, stdbPaymentsEnabled, parseStdbRowJson } from './stdbRuntime.js';
import { escapeSqlLiteral } from '../state-plane/stdbSyncClient.js';
import type { PaymentAccountLink } from '../../../shared/adminPolicyContracts.js';

export type { PaymentAccountLink } from '../../../shared/adminPolicyContracts.js';

interface PaymentAccountLinkRow {
	user_id: number;
	workspace_id: string;
	plugin_id: string;
	provider_account_ref: string;
	display_label: string | null;
	metadata_json: string | null;
	linked_at: number;
	updated_at: number;
}

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

function toPaymentAccountLink(row: PaymentAccountLinkRow): PaymentAccountLink {
	return {
		userId: Number(row.user_id),
		workspaceId: String(row.workspace_id || DEFAULT_WORKSPACE_ID),
		pluginId: String(row.plugin_id || ''),
		providerAccountRef: String(row.provider_account_ref || ''),
		displayLabel:
			typeof row.display_label === 'string' && row.display_label.trim().length > 0
				? row.display_label
				: null,
		metadata: safeParseMetadata(row.metadata_json),
		linkedAt: Number(row.linked_at || 0),
		updatedAt: Number(row.updated_at || 0)
	};
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
	if (stdbPaymentsEnabled()) {
		const shadow = getPaymentAccountLinkStdb(userId, pluginId, workspaceId);
		if (shadow) return shadow;
	}
	const row = db
		.prepare(
			`
				SELECT
					user_id,
					workspace_id,
					plugin_id,
					provider_account_ref,
					display_label,
					metadata_json,
					linked_at,
					updated_at
				FROM payment_account_links
				WHERE user_id = ? AND workspace_id = ? AND plugin_id = ?
				LIMIT 1
			`
		)
		.get(Math.floor(userId), workspaceId, pluginId) as PaymentAccountLinkRow | undefined;
	const legacy = row ? toPaymentAccountLink(row) : null;
	if (legacy && stdbPaymentsEnabled()) {
		upsertPaymentAccountLinkStdb(legacy);
	}
	return legacy;
}

export function listPaymentAccountLinks(
	userId: number,
	workspaceId: string = DEFAULT_WORKSPACE_ID
): PaymentAccountLink[] {
	if (stdbPaymentsEnabled()) {
		const shadow = listPaymentAccountLinksStdb(userId, workspaceId);
		if (shadow.length > 0) return shadow;
	}
	const rows = db
		.prepare(
			`
				SELECT
					user_id,
					workspace_id,
					plugin_id,
					provider_account_ref,
					display_label,
					metadata_json,
					linked_at,
					updated_at
				FROM payment_account_links
				WHERE user_id = ? AND workspace_id = ?
				ORDER BY updated_at DESC
			`
		)
		.all(Math.floor(userId), workspaceId) as PaymentAccountLinkRow[];
	const legacy = rows.map(toPaymentAccountLink);
	if (stdbPaymentsEnabled()) {
		for (const row of legacy) {
			upsertPaymentAccountLinkStdb(row);
		}
	}
	return legacy;
}

export function upsertPaymentAccountLink(input: {
	userId: number;
	workspaceId?: string;
	pluginId: string;
	providerAccountRef: string;
	displayLabel?: string | null;
	metadata?: Record<string, unknown> | null;
}): PaymentAccountLink | null {
	const userId = Math.floor(input.userId);
	const workspaceId = input.workspaceId || DEFAULT_WORKSPACE_ID;
	const pluginId = String(input.pluginId || '').trim();
	const providerAccountRef = String(input.providerAccountRef || '').trim();
	const displayLabel = typeof input.displayLabel === 'string' ? input.displayLabel.trim().slice(0, 160) : null;
	const metadataJson =
		input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
			? JSON.stringify(input.metadata)
			: null;
	const now = Date.now();

	if (!pluginId || !providerAccountRef) return null;

	db.prepare(
		`
			INSERT INTO payment_account_links (
				user_id,
				workspace_id,
				plugin_id,
				provider_account_ref,
				display_label,
				metadata_json,
				linked_at,
				updated_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(user_id, workspace_id, plugin_id) DO UPDATE SET
				provider_account_ref = excluded.provider_account_ref,
				display_label = excluded.display_label,
				metadata_json = excluded.metadata_json,
				updated_at = excluded.updated_at
		`
	).run(userId, workspaceId, pluginId, providerAccountRef, displayLabel, metadataJson, now, now);

	const link = getPaymentAccountLink(userId, pluginId, workspaceId);
	if (link && stdbPaymentsEnabled()) {
		upsertPaymentAccountLinkStdb(link);
	}
	return link;
}

export function deletePaymentAccountLink(
	userId: number,
	pluginId: string,
	workspaceId: string = DEFAULT_WORKSPACE_ID
): boolean {
	const result = db
		.prepare('DELETE FROM payment_account_links WHERE user_id = ? AND workspace_id = ? AND plugin_id = ?')
		.run(Math.floor(userId), workspaceId, pluginId);
	if (stdbPaymentsEnabled()) {
		deletePaymentAccountLinkStdb(userId, pluginId, workspaceId);
	}
	return (result.changes || 0) > 0;
}
