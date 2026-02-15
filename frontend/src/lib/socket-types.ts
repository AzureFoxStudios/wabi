export interface FileAttachment {
  fileUrl: string;
  fileName: string;
  fileSize: number;
}

export interface Message {
  id: string;
  user: string;
  userId: string;
  text: string;
  timestamp: number;
  type: 'text' | 'gif' | 'file' | 'emoji';
  gifUrl?: string;
  emojiUrl?: string;
  emojiName?: string;
  fileUrl?: string;
  fileName?: string;
  fileSize?: number;
  files?: FileAttachment[];
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
  url: string;
  category: string;
  isCustom: boolean;
  type?: 'emoji' | 'sticker';
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
  isTimedOut?: boolean;
  isBanned?: boolean;
  isShadowRestricted?: boolean;
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
  createdAt: number;
  type?: 'public' | 'dm' | 'group';
  members?: string[];
  otherUser?: User;
  memberUsers?: User[];
  avatar?: string | null;
  autoDeleteAfter?: '1h' | '6h' | '12h' | '24h' | '3d' | '7d' | '14d' | '30d' | null;
  isTemporary?: boolean;
  persistMessages?: boolean;
  pinnedBy?: string[];
}
