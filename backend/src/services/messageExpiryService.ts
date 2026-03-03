/**
 * Message Expiry Service
 * 
 * Handles scheduled message deletion (auto-delete after configured duration).
 * This service manages the lifecycle of message deletion timers and provides
 * functions to schedule, cancel, and execute message deletions.
 * 
 * Previously, deleteMessageById was declared as null and assigned later in server.ts,
 * creating a fragile temporal coupling. This service provides proper initialization.
 */

import { stateMessageStore } from '../state-plane/index.js';
import { UPLOADS_DIR } from '../constants.js';
import { existsSync, unlinkSync } from 'fs';
import { basename, resolve, sep } from 'path';

// Timer storage
const messageDeletionTimers = new Map<string, NodeJS.Timeout>();

// Helper function to convert auto-delete duration to milliseconds
export function getAutoDeleteMs(duration: string): number {
  const durations: Record<string, number> = {
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '12h': 12 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '3d': 3 * 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '14d': 14 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  };
  return durations[duration] || 0;
}

// Interface for message type used in channelMessages
interface Message {
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
  isPinned?: boolean;
  isEdited?: boolean;
  replyTo?: string;
  isSpoiler?: boolean;
  scheduledDeletionTime?: number;
  reactions?: Record<string, string[]>;
  files?: { fileUrl: string; fileName: string; fileSize: number }[];
}

// Callback type for emitting events to clients
type EmitToChannelFn = (channelId: string, event: string, data: any) => void;

function normalizeUploadFileIdFromUrl(fileUrl: string | undefined): string | null {
  if (typeof fileUrl !== 'string' || !fileUrl.startsWith('/uploads/')) return null;
  const raw = fileUrl.slice('/uploads/'.length);
  if (!raw) return null;

  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }

  const normalized = decoded.replace(/\\/g, '/');
  if (normalized.includes('/')) return null;
  const fileId = basename(normalized);
  if (!fileId || fileId === '.' || fileId === '..') return null;
  return fileId;
}

function resolveUploadPath(fileId: string): string | null {
  const uploadsRoot = resolve(UPLOADS_DIR);
  const candidate = resolve(uploadsRoot, basename(fileId));
  if (candidate !== uploadsRoot && !candidate.startsWith(`${uploadsRoot}${sep}`)) {
    return null;
  }
  return candidate;
}

function deleteUploadFile(fileUrl: string | undefined): void {
  const fileId = normalizeUploadFileIdFromUrl(fileUrl);
  if (!fileId) return;
  const filePath = resolveUploadPath(fileId);
  if (!filePath) return;

  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch (err) {
    console.error(`Failed to delete file: ${fileId}`, err);
  }
}

/**
 * Delete a message by ID from a channel
 * Removes message from in-memory store, deletes associated files,
 * soft-deletes from database, and notifies clients
 */
export function deleteMessageById(
  channelMessages: Map<string, Message[]>,
  channelId: string,
  messageId: string,
  emitToChannel: EmitToChannelFn,
  enableLogging: boolean = false
): void {
  const messages = channelMessages.get(channelId) || [];
  const messageIndex = messages.findIndex(m => m.id === messageId);

  if (messageIndex === -1) return;

  const message = messages[messageIndex];

  // Delete associated files from filesystem
  if (message.fileUrl) {
    deleteUploadFile(message.fileUrl);
  }

  // Delete multiple files if present
  if (message.files && message.files.length > 0) {
    for (const file of message.files) {
      deleteUploadFile(file.fileUrl);
    }
  }

  // Remove message from in-memory store
  messages.splice(messageIndex, 1);
  channelMessages.set(channelId, messages);

  // Soft-delete from database
  try { 
    stateMessageStore.softDelete(messageId); 
  } catch (err) {
    console.error('[MessageRepository] Failed to soft-delete message:', err);
  }

  // Cancel timer if exists
  const timer = messageDeletionTimers.get(messageId);
  if (timer) {
    clearTimeout(timer);
    messageDeletionTimers.delete(messageId);
  }

  // Notify clients
  emitToChannel(channelId, "message-deleted", { channelId, messageId });

  if (enableLogging) {
    console.log(`🗑️ Auto-deleted message ${messageId} from channel ${channelId}`);
  }
}

/**
 * Schedule a message for automatic deletion after the specified duration
 */
export function scheduleMessageDeletion(
  channelMessages: Map<string, Message[]>,
  channelId: string,
  messageId: string,
  duration: string,
  emitToChannel: EmitToChannelFn,
  enableLogging: boolean = false
): void {
  const ms = getAutoDeleteMs(duration);
  if (ms === 0) return;

  const timer = setTimeout(() => {
    deleteMessageById(channelMessages, channelId, messageId, emitToChannel, enableLogging);
  }, ms);

  messageDeletionTimers.set(messageId, timer);
}

/**
 * Cancel a scheduled message deletion
 */
export function cancelMessageDeletion(messageId: string): void {
  const timer = messageDeletionTimers.get(messageId);
  if (timer) {
    clearTimeout(timer);
    messageDeletionTimers.delete(messageId);
  }
}

/**
 * Restore deletion timers for messages that were scheduled before server restart
 * This is called during server startup to恢复 persisted deletion schedules
 */
export function restoreMessageDeletionTimers(
  channelMessages: Map<string, Message[]>,
  channels: Map<string, { autoDeleteAfter?: string }>,
  emitToChannel: EmitToChannelFn,
  enableLogging: boolean = false
): void {
  channelMessages.forEach((messages, channelId) => {
    const channel = channels.get(channelId);

    messages.forEach(message => {
      if (message.scheduledDeletionTime && channel?.autoDeleteAfter) {
        const timeRemaining = message.scheduledDeletionTime - Date.now();

        if (timeRemaining <= 0) {
          // Message should have been deleted, delete now
          deleteMessageById(channelMessages, channelId, message.id, emitToChannel, enableLogging);
        } else {
          // Schedule deletion for remaining time
          const timer = setTimeout(() => {
            deleteMessageById(channelMessages, channelId, message.id, emitToChannel, enableLogging);
          }, timeRemaining);
          messageDeletionTimers.set(message.id, timer);

          if (enableLogging) {
            console.log(`⏱️  Restored deletion timer for message ${message.id} (${Math.round(timeRemaining / 1000)}s remaining)`);
          }
        }
      }
    });
  });
}

/**
 * Get all active deletion timers (for debugging/monitoring)
 */
export function getActiveDeletionTimers(): string[] {
  return Array.from(messageDeletionTimers.keys());
}

/**
 * Clear all deletion timers (for testing)
 */
export function clearAllDeletionTimers(): void {
  messageDeletionTimers.forEach(timer => clearTimeout(timer));
  messageDeletionTimers.clear();
}
