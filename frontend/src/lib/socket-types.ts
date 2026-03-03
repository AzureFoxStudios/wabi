export interface FileAttachment {
  fileUrl: string;
  fileName: string;
  fileSize: number;
  attachmentStorage?: {
    scheme: 'wabi-storage-v1';
    compressed: boolean;
    codec: 'identity' | 'gzip';
    originalSize: number;
    storedSize: number;
    atRestEncrypted: boolean;
  };
  attachmentEncryption?: {
    scheme: 'dm-e2ee-v1';
    iv: string;
    mimeType?: string;
    originalSize?: number;
  };
}

export interface Message {
  id: string;
  user: string;
  userId: string;
  text: string;
  timestamp: number;
  scheduledDeletionTime?: number;
  type: 'text' | 'gif' | 'file' | 'emoji' | 'role_gate';
  gifUrl?: string;
  emojiUrl?: string;
  emojiName?: string;
  fileUrl?: string;
  fileName?: string;
  fileSize?: number;
  files?: FileAttachment[];
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
  isPinned?: boolean;
  isEdited?: boolean;
  encrypted?: boolean;
  iv?: string;
  replyTo?: string;
  isSpoiler?: boolean;
  reactions?: Record<string, string[]>;
}

export interface Emoji {
  id: string;
  name: string;
  displayName?: string;
  artist?: string;
  url: string;
  category: string;
  isCustom: boolean;
  type?: 'emoji' | 'sticker';
  source?: 'default' | 'openmoji' | 'custom';
}

export interface User {
  id: string;
  username: string;
  handle?: string;
  color: string;
  status: 'active' | 'away' | 'busy' | 'offline';
  profilePicture?: string;
  bio?: string;
  joinedAt?: number;
  dbUserId?: number; // Stable registered user ID (undefined for guests)
  roles?: string[];
  highestRole?: string;
  roleColor?: string | null;
  usernameFont?: {
    family?: string;
    size?: string;
    weight?: string;
    style?: string;
  };
}

export interface Channel {
  id: string;
  name: string;
  description?: string;
  watchQueueEnabled?: boolean;
  minRole?: string;
  createdAt: number;
  type?: 'text' | 'voice' | 'dm' | 'group' | 'public' | 'thread_public' | 'thread_private';
  isBreakout?: boolean;
  breakoutIndex?: number;
  members?: string[];
  otherUser?: User;
  memberUsers?: User[];
  avatar?: string | null;
  parentChannelId?: string;
  parentMessageId?: string;
  threadArchived?: boolean;
  threadLocked?: boolean;
  threadAutoArchiveMinutes?: number;
  threadLastActivityAt?: number;
  autoDeleteAfter?: '5s' | '1h' | '6h' | '12h' | '24h' | '3d' | '7d' | '14d' | '30d' | null;
  isTemporary?: boolean;
  persistMessages?: boolean;
  pinnedBy?: string[];
}
