import type {
  AttachmentEncryptionMeta,
  AttachmentStorageMeta,
  ChannelView as ProtocolChannelView,
  FileAttachment as ProtocolFileAttachment,
  MessageEntity as ProtocolMessageEntity,
  MessageView as ProtocolMessageView,
  UserView as ProtocolUserView,
  VoiceChannelSettings as ProtocolVoiceChannelSettings
} from '../../../packages/wabi-protocol/src/index';

export type FileAttachment = ProtocolFileAttachment;
export type MessageEntity = ProtocolMessageEntity;

type MessageOptionalProtocolField =
  | 'clientMessageId'
  | 'senderStableId'
  | 'color'
  | 'scheduledDeletionTime'
  | 'gifUrl'
  | 'emojiUrl'
  | 'emojiName'
  | 'fileUrl'
  | 'fileName'
  | 'fileSize'
  | 'files'
  | 'attachmentEncryption'
  | 'attachmentStorage'
  | 'isPinned'
  | 'isEdited'
  | 'encrypted'
  | 'iv'
  | 'replyTo'
  | 'isSpoiler'
  | 'reactions'
  | 'entities';

export interface Message extends Omit<ProtocolMessageView, MessageOptionalProtocolField> {
  clientMessageId?: string;
  clientNonce?: string;
  senderStableId?: string;
  color?: string;
  scheduledDeletionTime?: number;
  gifUrl?: string;
  emojiUrl?: string;
  emojiName?: string;
  fileUrl?: string;
  fileName?: string;
  fileSize?: number;
  files?: FileAttachment[];
  attachmentEncryption?: AttachmentEncryptionMeta;
  attachmentStorage?: AttachmentStorageMeta;
  isPinned?: boolean;
  isEdited?: boolean;
  encrypted?: boolean;
  iv?: string;
  replyTo?: string;
  isSpoiler?: boolean;
  reactions?: Record<string, string[]>;
  entities?: MessageEntity[];
  isDeleted?: boolean;
  deletionExpireTime?: number;
  persistenceState?: 'failed' | 'retrying';
  persistenceError?: string;
  persistenceAttempts?: number;
  deliveryState?: 'sending' | 'failed';
  deliveryError?: string;
  localCard?: {
    kind: 'directions';
    placeId: string;
    placeLabel: string;
    poiId?: string;
    poiLabel?: string;
    layerId?: string;
    layerLabel?: string;
    building?: string;
    floor?: string;
    coordinates?: string;
    originCoordinates?: string;
    externalUrl?: string;
    externalLabel?: string;
    expiresAt?: number;
  };
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
  id: ProtocolUserView['id'];
  username: ProtocolUserView['username'];
  handle?: ProtocolUserView['handle'];
  color: ProtocolUserView['color'];
  status: ProtocolUserView['status'];
  profilePicture?: Exclude<ProtocolUserView['profilePicture'], null>;
  bio?: Exclude<ProtocolUserView['bio'], null>;
  joinedAt?: Exclude<ProtocolUserView['joinedAt'], null>;
  dbUserId?: Exclude<ProtocolUserView['dbUserId'], null>; // Stable registered user ID (undefined for guests)
  roles?: Exclude<ProtocolUserView['roles'], null>;
  highestRole?: Exclude<ProtocolUserView['highestRole'], null>;
  roleColor?: ProtocolUserView['roleColor'];
  usernameFont?: Exclude<ProtocolUserView['usernameFont'], null>;
}

export type VoiceChannelSettings = ProtocolVoiceChannelSettings;

type ChannelOptionalProtocolField =
  | 'description'
  | 'watchQueueEnabled'
  | 'minRole'
  | 'type'
  | 'isBreakout'
  | 'breakoutIndex'
  | 'members'
  | 'avatar'
  | 'parentChannelId'
  | 'parentMessageId'
  | 'threadArchived'
  | 'threadLocked'
  | 'threadAutoArchiveMinutes'
  | 'threadLastActivityAt'
  | 'autoDeleteAfter'
  | 'isTemporary'
  | 'persistMessages'
  | 'pinnedBy'
  | 'voiceSettings'
  | 'topic';

export interface Channel extends Omit<ProtocolChannelView, ChannelOptionalProtocolField> {
  description?: Exclude<ProtocolChannelView['description'], null>;
  watchQueueEnabled?: Exclude<ProtocolChannelView['watchQueueEnabled'], null>;
  minRole?: Exclude<ProtocolChannelView['minRole'], null>;
  createdAt: ProtocolChannelView['createdAt'];
  type?: Exclude<ProtocolChannelView['type'], null>;
  isBreakout?: Exclude<ProtocolChannelView['isBreakout'], null>;
  breakoutIndex?: Exclude<ProtocolChannelView['breakoutIndex'], null>;
  members?: Exclude<ProtocolChannelView['members'], null>;
  otherUser?: User;
  memberUsers?: User[];
  avatar?: ProtocolChannelView['avatar'];
  parentChannelId?: Exclude<ProtocolChannelView['parentChannelId'], null>;
  parentMessageId?: Exclude<ProtocolChannelView['parentMessageId'], null>;
  threadArchived?: Exclude<ProtocolChannelView['threadArchived'], null>;
  threadLocked?: Exclude<ProtocolChannelView['threadLocked'], null>;
  threadAutoArchiveMinutes?: Exclude<ProtocolChannelView['threadAutoArchiveMinutes'], null>;
  threadLastActivityAt?: Exclude<ProtocolChannelView['threadLastActivityAt'], null>;
  autoDeleteAfter?: ProtocolChannelView['autoDeleteAfter'];
  isTemporary?: Exclude<ProtocolChannelView['isTemporary'], null>;
  persistMessages?: Exclude<ProtocolChannelView['persistMessages'], null>;
  pinnedBy?: Exclude<ProtocolChannelView['pinnedBy'], null>;
  voiceSettings?: VoiceChannelSettings;
  topic?: Exclude<ProtocolChannelView['topic'], null>;
}
