import type { ClientMessage } from "../db/repositories/messageRepository.js";
import { messageRetentionToMs, type MessageRetentionDuration } from "../../../shared/messageRetention.js";

export type RealtimeChannelMessage = ClientMessage & {
	senderStableId?: string;
	scheduledDeletionTime?: number;
};

interface DeleteMessageOptions {
	deleteReason: string;
	emitDeletedEvent?: boolean;
	logMessage?: string;
}

interface CreateMessageLifecycleOptions {
	channelMessages: Map<string, RealtimeChannelMessage[]>;
	pinnedMessages: Map<string, Set<string>>;
	deleteUploadFileByUrl: (fileUrl: string | undefined, reason: string) => void;
	softDeleteMessage: (messageId: string) => void;
	emitToChannel: (channelId: string, event: string, payload: unknown) => void;
	onMessageRemoved?: (channelId: string, messageId: string, message: RealtimeChannelMessage) => void;
	enableLogging?: boolean;
}

export function createMessageLifecycle({
	channelMessages,
	pinnedMessages,
	deleteUploadFileByUrl,
	softDeleteMessage,
	emitToChannel,
	onMessageRemoved,
	enableLogging = false
}: CreateMessageLifecycleOptions) {
	const messageDeletionTimers = new Map<string, NodeJS.Timeout>();

	const getAutoDeleteMs = (duration: MessageRetentionDuration | null | undefined): number => {
		return messageRetentionToMs(duration) ?? 0;
	};

	const cancelMessageDeletion = (messageId: string): void => {
		const timer = messageDeletionTimers.get(messageId);
		if (!timer) return;
		clearTimeout(timer);
		messageDeletionTimers.delete(messageId);
	};

	const deleteMessageFiles = (message: RealtimeChannelMessage, reason: string): void => {
		deleteUploadFileByUrl(message.fileUrl, reason);
		if (!Array.isArray(message.files)) return;
		for (const file of message.files) {
			deleteUploadFileByUrl(file.fileUrl, reason);
		}
	};

	const deleteMessage = (
		channelId: string,
		messageId: string,
		{ deleteReason, emitDeletedEvent = true, logMessage }: DeleteMessageOptions
	): boolean => {
		const messages = channelMessages.get(channelId);
		if (!messages) return false;

		const messageIndex = messages.findIndex((message) => message.id === messageId);
		if (messageIndex === -1) return false;

		const message = messages[messageIndex];
		deleteMessageFiles(message, deleteReason);
		messages.splice(messageIndex, 1);

		const channelPins = pinnedMessages.get(channelId);
		if (channelPins) {
			channelPins.delete(messageId);
		}

		cancelMessageDeletion(messageId);

		try {
			onMessageRemoved?.(channelId, messageId, message);
		} catch (error) {
			console.error('[Messages] Failed to run deletion cleanup hook:', error);
		}

		try {
			softDeleteMessage(messageId);
		} catch (error) {
			console.error(`[Messages] Failed to soft-delete deleted message ${messageId}:`, error);
		}

		if (emitDeletedEvent) {
			emitToChannel(channelId, "message-deleted", { channelId, messageId });
		}

		if (enableLogging && logMessage) {
			console.log(logMessage);
		}

		return true;
	};

	const scheduleMessageDeletion = (
		channelId: string,
		messageId: string,
		duration: MessageRetentionDuration | null | undefined
	): void => {
		const ms = getAutoDeleteMs(duration);
		if (ms === 0) return;

		cancelMessageDeletion(messageId);
		const timer = setTimeout(() => {
			deleteMessage(channelId, messageId, {
				deleteReason: 'auto-delete',
				logMessage: `Auto-deleted message ${messageId} from channel ${channelId}`
			});
		}, ms);

		messageDeletionTimers.set(messageId, timer);
	};

	const clearAllDeletionTimers = (): void => {
		for (const timer of messageDeletionTimers.values()) {
			clearTimeout(timer);
		}
		messageDeletionTimers.clear();
	};

	return {
		getAutoDeleteMs,
		scheduleMessageDeletion,
		cancelMessageDeletion,
		deleteMessage,
		clearAllDeletionTimers
	};
}
