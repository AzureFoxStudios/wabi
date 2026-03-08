import db from '../db/database.js';
import { DEFAULT_WORKSPACE_ID } from '../constants.js';

export interface PaymentAccountLink {
	userId: number;
	workspaceId: string;
	pluginId: string;
	providerAccountRef: string;
	displayLabel: string | null;
	metadata: Record<string, unknown> | null;
	linkedAt: number;
	updatedAt: number;
}

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

export function getPaymentAccountLink(
	userId: number,
	pluginId: string,
	workspaceId: string = DEFAULT_WORKSPACE_ID
): PaymentAccountLink | null {
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
	return row ? toPaymentAccountLink(row) : null;
}

export function listPaymentAccountLinks(
	userId: number,
	workspaceId: string = DEFAULT_WORKSPACE_ID
): PaymentAccountLink[] {
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
	return rows.map(toPaymentAccountLink);
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

	return getPaymentAccountLink(userId, pluginId, workspaceId);
}

export function deletePaymentAccountLink(
	userId: number,
	pluginId: string,
	workspaceId: string = DEFAULT_WORKSPACE_ID
): boolean {
	const result = db
		.prepare('DELETE FROM payment_account_links WHERE user_id = ? AND workspace_id = ? AND plugin_id = ?')
		.run(Math.floor(userId), workspaceId, pluginId);
	return (result.changes || 0) > 0;
}
