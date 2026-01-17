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
}

export interface User {
  id: string;
  username: string;
  color: string;
  status: 'active' | 'away' | 'busy';
  profilePicture?: string;
  bio?: string;
  joinedAt?: number;
}

export interface Channel {
  id: string;
  name: string;
  createdAt: number;
  type?: 'public' | 'dm' | 'group';
  members?: string[];
  otherUser?: User;
  autoDeleteAfter?: '1h' | '6h' | '12h' | '24h' | '3d' | '7d' | '14d' | '30d' | null;
  isTemporary?: boolean;
  persistMessages?: boolean;
  pinnedBy?: string[];
}
