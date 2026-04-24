import { stdbOfflineMessageIngest, stdbOfflineMessageRows, stdbOfflineMessagesEnabled } from './stdbOfflineMessageRuntime.js';
import { escapeSqlLiteral } from '../../state-plane/stdbSyncClient.js';

export interface OfflineMessage {
	message_id?: number;
	from_user_id?: number;
	from_username: string;
	to_user_id: number;
	channel_id: string;
	message_content: string;
	message_type: string;
	gif_url?: string;
	file_url?: string;
	file_name?: string;
	file_size?: number;
	message_payload_json?: string;
	created_at: number;
	expires_at: number;
	delivered: boolean;
}

function normalizeOfflineMessage(row: Record<string, unknown>): OfflineMessage | null {
	const toUserId = Number(row.to_user_id);
	if (!Number.isFinite(toUserId) || toUserId <= 0) return null;
	return {
		message_id: row.message_id != null ? Number(row.message_id) : undefined,
		from_user_id: row.from_user_id != null ? Number(row.from_user_id) : undefined,
		from_username: String(row.from_username || ''),
		to_user_id: toUserId,
		channel_id: String(row.channel_id || ''),
		message_content: String(row.message_content || ''),
		message_type: String(row.message_type || 'text'),
		gif_url: row.gif_url != null ? String(row.gif_url) : undefined,
		file_url: row.file_url != null ? String(row.file_url) : undefined,
		file_name: row.file_name != null ? String(row.file_name) : undefined,
		file_size: row.file_size != null ? Number(row.file_size) : undefined,
		message_payload_json: row.message_payload_json != null ? String(row.message_payload_json) : undefined,
		created_at: Number(row.created_at) || 0,
		expires_at: Number(row.expires_at) || 0,
		delivered: Boolean(row.delivered)
	};
}

export class OfflineMessageRepository {
	queue(message: Omit<OfflineMessage, 'message_id' | 'delivered'>): OfflineMessage {
		if (!stdbOfflineMessagesEnabled()) {
			return { ...message, delivered: false } as OfflineMessage;
		}
		const now = Date.now();
		stdbOfflineMessageIngest('offline_messages.write', 'create', {
			...message,
			messageId: now,
			delivered: false
		});
		return { ...message, message_id: now, delivered: false };
	}

	getByRecipient(toUserId: number): OfflineMessage[] {
		if (!stdbOfflineMessagesEnabled()) return [];
		const rows = stdbOfflineMessageRows(
			'offline_messages.list',
			`SELECT * FROM state_offline_message WHERE to_user_id = ${Math.floor(toUserId)} AND delivered = false ORDER BY created_at ASC`
		);
		return rows
			.map(row => normalizeOfflineMessage(row))
			.filter((m): m is OfflineMessage => m !== null);
	}

	markDelivered(messageIds: number[]): void {
		if (!stdbOfflineMessagesEnabled() || messageIds.length === 0) return;
		for (const id of messageIds) {
			stdbOfflineMessageIngest('offline_messages.deliver', 'mark_delivered', { messageId: id });
		}
	}

	deleteExpired(): number {
		if (!stdbOfflineMessagesEnabled()) return 0;
		const now = Date.now();
		const rows = stdbOfflineMessageRows(
			'offline_messages.expired',
			`SELECT message_id FROM state_offline_message WHERE expires_at < ${now}`
		);
		let deleted = 0;
		for (const row of rows) {
			stdbOfflineMessageIngest('offline_messages.delete', 'delete', { messageId: Number(row.message_id) });
			deleted++;
		}
		return deleted;
	}

	clearAll(): number {
		return 0;
	}

	getCountByRecipient(toUserId: number): number {
		if (!stdbOfflineMessagesEnabled()) return 0;
		const rows = stdbOfflineMessageRows(
			'offline_messages.count',
			`SELECT COUNT(*) as count FROM state_offline_message WHERE to_user_id = ${Math.floor(toUserId)} AND delivered = false`
		);
		return rows.length > 0 ? Number(rows[0].count) : 0;
	}
}

export const offlineMessageRepository = new OfflineMessageRepository();