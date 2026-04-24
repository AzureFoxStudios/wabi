export interface RegisteredUser {
	user_id?: number;
	username: string;
	handle?: string;
	password_hash: string;
	created_at: number;
	color: string;
	profile_picture?: string;
	bio?: string;
	is_active?: number;
	username_font_family?: string;
	username_font_size?: string;
	username_font_weight?: string;
	username_font_style?: string;
}

export interface Session {
	session_id: string;
	user_id: number | null;
	username: string;
	color: string;
	profile_picture?: string;
	created_at: number;
	expires_at?: number;
	is_temporary: number;
	socket_id?: string;
	last_seen?: number;
}

export interface DbChannel {
	channel_id: string;
	channel_type: 'text' | 'voice' | 'public' | 'dm' | 'group' | 'thread_public' | 'thread_private';
	name: string;
	description: string;
	min_role?: string;
	voice_settings_json?: string | null;
	watch_queue_enabled?: number;
	created_at: number;
	created_by?: string;
	persist_messages: number;
	auto_delete_after?: string | null;
	is_archived: number;
	avatar?: string;
	parent_channel_id?: string | null;
	is_breakout?: number;
	breakout_index?: number | null;
	parent_message_id?: string | null;
	thread_archived?: number;
	thread_locked?: number;
	thread_auto_archive_minutes?: number;
	thread_last_activity_at?: number | null;
}

export interface DbChannelMember {
	id?: number;
	channel_id: string;
	user_id: string;
	username: string;
	registered_user_id?: number;
	joined_at: number;
	role: 'owner' | 'admin' | 'member';
}

export interface DbMessage {
	id?: number;
	message_id: string;
	channel_id: string;
	sender_id: string;
	sender_username: string;
	sender_color?: string;
	message_type: 'text' | 'gif' | 'file' | 'emoji' | 'role_gate';
	content: string;
	gif_url?: string;
	file_url?: string;
	file_name?: string;
	file_size?: number;
	files_json?: string;
	entities_json?: string;
	attachment_encryption_json?: string;
	attachment_storage_json?: string;
	reply_to_id?: string;
	is_spoiler: number;
	is_pinned: number;
	is_edited: number;
	reactions_json?: string;
	is_encrypted?: number;
	encryption_iv?: string;
	expires_at?: number | null;
	created_at: number;
	deleted_at?: number;
}

export interface PaginationOptions {
	limit?: number;
	beforeMessageId?: string;
	afterMessageId?: string;
}

export interface PlaceMessageEntity {
	kind: 'place';
	start: number;
	end: number;
	placeId: string;
	layerId?: string;
	poiId?: string;
	label: string;
	displayText?: string;
}

export type MessageEntity = PlaceMessageEntity;

export interface ClientMessage {
	id: string;
	user: string;
	userId: string;
	text: string;
	timestamp: number;
	type: 'text' | 'gif' | 'file' | 'emoji' | 'role_gate';
	gifUrl?: string;
	fileUrl?: string;
	fileName?: string;
	fileSize?: number;
	files?: {
		fileUrl: string;
		fileName: string;
		fileSize: number;
		attachmentEncryption?: {
			scheme: 'dm-e2ee-v1';
			iv: string;
			mimeType?: string;
			originalSize?: number;
		};
		attachmentStorage?: {
			scheme: 'wabi-storage-v1';
			compressed: boolean;
			codec: 'identity' | 'gzip';
			originalSize: number;
			storedSize: number;
			atRestEncrypted: boolean;
		};
	}[];
	entities?: MessageEntity[];
	attachmentEncryption?: {
		scheme: 'dm-e2ee-v1';
		iv: string;
		mimeType?: string;
		originalSize?: number;
	};
	attachmentStorage?: {
		scheme: 'wabi-storage-v1';
		compressed: boolean;
		codec: 'identity' | 'gzip';
		originalSize: number;
		storedSize: number;
		atRestEncrypted: boolean;
	};
	replyTo?: string;
	isSpoiler?: boolean;
	isPinned?: boolean;
	isEdited?: boolean;
	encrypted?: boolean;
	iv?: string;
	scheduledDeletionTime?: number;
	reactions?: Record<string, string[]>;
	color?: string;
}

export function toClientMessage(dbMsg: DbMessage): ClientMessage {
	const msg: ClientMessage = {
		id: dbMsg.message_id,
		user: dbMsg.sender_username,
		userId: dbMsg.sender_id,
		text: dbMsg.content,
		timestamp: dbMsg.created_at,
		type: dbMsg.message_type
	};

	if (dbMsg.gif_url) msg.gifUrl = dbMsg.gif_url;
	if (dbMsg.file_url) msg.fileUrl = dbMsg.file_url;
	if (dbMsg.file_name) msg.fileName = dbMsg.file_name;
	if (dbMsg.file_size) msg.fileSize = dbMsg.file_size;
	if (dbMsg.files_json) {
		try {
			msg.files = JSON.parse(dbMsg.files_json);
		} catch {
			// Ignore parse errors
		}
	}
	if (dbMsg.entities_json) {
		try {
			msg.entities = JSON.parse(dbMsg.entities_json);
		} catch {
			// Ignore parse errors
		}
	}
	if (dbMsg.attachment_encryption_json) {
		try {
			msg.attachmentEncryption = JSON.parse(dbMsg.attachment_encryption_json);
		} catch {
			// Ignore parse errors
		}
	}
	if (dbMsg.attachment_storage_json) {
		try {
			msg.attachmentStorage = JSON.parse(dbMsg.attachment_storage_json);
		} catch {
			// Ignore parse errors
		}
	}
	if (dbMsg.reply_to_id) msg.replyTo = dbMsg.reply_to_id;
	if (dbMsg.is_spoiler) msg.isSpoiler = true;
	if (dbMsg.is_pinned) msg.isPinned = true;
	if (dbMsg.is_edited) msg.isEdited = true;
	if (dbMsg.is_encrypted) msg.encrypted = true;
	if (dbMsg.encryption_iv) msg.iv = dbMsg.encryption_iv;
	if (typeof dbMsg.expires_at === 'number' && Number.isFinite(dbMsg.expires_at)) {
		msg.scheduledDeletionTime = dbMsg.expires_at;
	}
	if (dbMsg.sender_color) msg.color = dbMsg.sender_color;

	if (dbMsg.reactions_json) {
		try {
			msg.reactions = JSON.parse(dbMsg.reactions_json);
		} catch {
			// Ignore parse errors
		}
	}

	return msg;
}
