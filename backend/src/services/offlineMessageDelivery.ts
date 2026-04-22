interface OfflineMessageSocketLike {
  emit(event: string, payload: unknown): boolean;
}

interface OfflineMessageRecord {
  message_id?: number;
  channel_id: string;
  from_username: string;
  from_user_id?: number | null;
  message_content: string;
  created_at: number;
  message_type: string;
  gif_url?: string | null;
  file_url?: string | null;
  file_name?: string | null;
  file_size?: number | null;
  message_payload_json?: string | null;
}

interface OfflineMessageRepositoryLike {
  getByRecipient(dbUserId: number): OfflineMessageRecord[];
  markDelivered(messageIds: number[]): void;
}

export interface DeliveredOfflineMessage {
  id: string;
  user: string;
  userId: string;
  senderStableId?: string;
  text: string;
  timestamp: number;
  type: string;
  gifUrl?: string | null;
  fileUrl?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  [key: string]: unknown;
}

export function buildClientOfflineMessage(message: OfflineMessageRecord): DeliveredOfflineMessage {
  const fallbackSenderStableId =
    typeof message.from_user_id === 'number' && Number.isFinite(message.from_user_id)
      ? `user-${message.from_user_id}`
      : 'unknown';

  if (typeof message.message_payload_json === 'string' && message.message_payload_json.trim()) {
    try {
      const parsed = JSON.parse(message.message_payload_json) as Record<string, unknown>;
      if (
        typeof parsed.id === 'string' &&
        typeof parsed.user === 'string' &&
        typeof parsed.text === 'string' &&
        typeof parsed.timestamp === 'number' &&
        typeof parsed.type === 'string'
      ) {
        const parsedUserId =
          typeof parsed.userId === 'string' && parsed.userId.trim()
            ? parsed.userId
            : typeof parsed.senderStableId === 'string' && parsed.senderStableId.trim()
              ? parsed.senderStableId
              : fallbackSenderStableId;

        return {
          ...parsed,
          userId: parsedUserId,
          senderStableId:
            typeof parsed.senderStableId === 'string' && parsed.senderStableId.trim()
              ? parsed.senderStableId
              : parsedUserId
        } as DeliveredOfflineMessage;
      }
    } catch (error) {
      console.warn('[Offline] Failed to parse queued message payload JSON:', error);
    }
  }

  return {
    id: `offline-${message.message_id}`,
    user: message.from_username,
    userId: fallbackSenderStableId,
    senderStableId: fallbackSenderStableId,
    text: message.message_content,
    timestamp: message.created_at,
    type: message.message_type,
    gifUrl: message.gif_url,
    fileUrl: message.file_url,
    fileName: message.file_name,
    fileSize: message.file_size
  };
}

export async function deliverOfflineMessagesToSocket(
  socket: OfflineMessageSocketLike,
  dbUserId: number | null,
  offlineMessageRepository: OfflineMessageRepositoryLike
): Promise<void> {
  if (!dbUserId) return;

  try {
    const offlineMessages = offlineMessageRepository.getByRecipient(dbUserId);
    if (offlineMessages.length === 0) return;

    const messagesByChannel: Record<string, DeliveredOfflineMessage[]> = {};

    for (const message of offlineMessages) {
      if (!messagesByChannel[message.channel_id]) {
        messagesByChannel[message.channel_id] = [];
      }

      messagesByChannel[message.channel_id].push(buildClientOfflineMessage(message));
    }

    for (const [channelId, messages] of Object.entries(messagesByChannel)) {
      socket.emit('offline-messages', {
        channelId,
        messages
      });
    }

    const messageIds = offlineMessages
      .map((message) => message.message_id)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    if (messageIds.length > 0) {
      offlineMessageRepository.markDelivered(messageIds);
    }

    console.log(`[Offline] 📬 Delivered ${offlineMessages.length} offline messages to user ${dbUserId}`);
  } catch (error) {
    console.error('[Offline] Failed to deliver offline messages:', error);
  }
}
