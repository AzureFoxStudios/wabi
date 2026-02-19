import { Server } from "socket.io";
import { createServer } from "http";
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync, createReadStream, openSync, closeSync, writeSync } from "fs";
import { join, basename } from "path";
import { createHmac, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv, createHash } from "crypto";
import { PluginLoader } from "./plugins/loader";
import { getAllEmojis, getEmojiByName, addCustomEmoji, deleteCustomEmoji, type Emoji } from "./emojis";

import { __dirname } from "./_dirname.js";
import db, { initializeDatabase, closeDatabase } from "./db/database.js";
import { userRepository } from "./db/repositories/userRepository.js";
import { sessionRepository } from "./db/repositories/sessionRepository.js";
import { offlineMessageRepository } from "./db/repositories/offlineMessageRepository.js";
import { settingsRepository } from "./db/repositories/settingsRepository.js";
import { themeRepository } from "./db/repositories/themeRepository.js";
import { guestCodeRepository } from "./db/repositories/guestCodeRepository.js";
import { verifyToken } from "./auth/jwt.js";
import { handleRegister, handleLogin, handleUpgrade, handleGetUserSettings, handleSaveUserSettings, handleGetPublicKey, handleStoreEncryptionKeys } from "./api/authRoutes.js";
import { handleGetThemePreferences, handleSaveThemePreferences, handleResetThemePreferences } from "./api/themeRoutes.js";
import { handleGetRelays, handleRelayRegister, handleRelayHealth, handleRelayApprove, handleGetAllRelays, handleRelayDelete } from "./api/relayRoutes.js";
import {
  handleGetMediaRuntime,
  handleGetTurnCredentials,
  handleMediaGatewayHeartbeat,
  handleCreateMediaGatewaySession,
  handleListMediaGatewaySessions,
  handleGetMediaGatewaySession,
  handleCloseMediaGatewaySession,
  handleGetMediaGatewayControlSessions
} from "./api/mediaRoutes.js";
import { handleCreateWebhook, handleListWebhooks, handleDeleteWebhook, handleListWebhookDeliveries } from "./api/webhookRoutes.js";
import { relayRepository } from "./db/repositories/relayRepository.js";
import { corsCallback, getCORSHeaders, getAllowedOrigins, isOriginAllowed } from "./config/cors.js";
import { channelRepository } from "./db/repositories/channelRepository.js";
import { channelMemberRepository } from "./db/repositories/channelMemberRepository.js";
import { messageRepository } from "./db/repositories/messageRepository.js";
import { appPolicyRepository } from "./db/repositories/appPolicyRepository.js";
import { getUserRoles, assignRole, removeRole } from "./auth/roleMiddleware.js";
import { dispatchWebhookEvent } from "./webhooks/deliveryService.js";
import {
  DEFAULT_WORKSPACE_ID,
  DEFAULT_TEXT_CHANNEL_ID,
  DEFAULT_VOICE_CHANNEL_ID,
  DATA_DIR,
  UPLOADS_DIR,
  DEFAULT_STATIC_DIR,
  BUSINESS_DATA_DIR_NAME,
  ROLES,
  PRIVILEGED_ROLES,
  MODERATOR_ROLES,
} from "./constants.js";

// Helper: get role info for a user (roles, highest role, display color)
function getUserRoleInfo(dbUserId?: number): { roles: string[]; highestRole: string; roleColor: string | null } {
  if (!dbUserId) return { roles: ['guest'], highestRole: 'guest', roleColor: '#888888' };

  const roles = getUserRoles(dbUserId);
  if (roles.length === 0) return { roles: ['member'], highestRole: 'member', roleColor: null };

  // Get role priorities from DB
  const roleRows = db.prepare(
    'SELECT role_name, priority, color FROM roles WHERE role_name IN (' + roles.map(() => '?').join(',') + ') ORDER BY priority DESC'
  ).all(...roles) as { role_name: string; priority: number; color: string | null }[];

  const highestRole = roleRows[0]?.role_name || 'member';
  const roleColor = roleRows.find(r => r.color)?.color || null;

  return { roles: roles.length > 0 ? roles : ['member'], highestRole, roleColor };
}

function getRoleDefinitions(workspaceId: string = 'default-workspace'): Array<{
  roleName: string;
  displayName: string;
  priority: number;
  color: string | null;
  isHoisted: boolean;
}> {
  const rows = db.prepare(`
    SELECT role_name, COALESCE(display_name, role_name) as display_name, priority, color, is_hoisted
    FROM roles
    WHERE workspace_id = ?
    ORDER BY priority DESC
  `).all(workspaceId) as Array<{
    role_name: string;
    display_name: string;
    priority: number;
    color: string | null;
    is_hoisted: number;
  }>;

  return rows.map(row => ({
    roleName: row.role_name,
    displayName: row.display_name,
    priority: row.priority,
    color: row.color,
    isHoisted: row.is_hoisted === 1
  }));
}

function getRolePriority(roleName: string, workspaceId: string = 'default-workspace'): number {
  const row = db.prepare(`
    SELECT priority FROM roles
    WHERE role_name = ? AND workspace_id = ?
    LIMIT 1
  `).get(roleName, workspaceId) as { priority?: number } | undefined;
  return row?.priority ?? 0;
}

type RolePolicyTier = 'new' | 'trusted' | 'moderator' | 'admin' | 'owner';
type UploadLimitBytes = number | null;

interface UploadLimitConfig {
  perRoleBytes: Record<RolePolicyTier, UploadLimitBytes>;
  globalUploadCapBytes: UploadLimitBytes;
}

interface DownloadLimitConfig {
  perRoleBytes: Record<RolePolicyTier, UploadLimitBytes>;
  globalDownloadCapBytes: UploadLimitBytes;
}

type PolicyKey = 'upload_limits' | 'download_limits';
const UPLOAD_LIMITS_POLICY_KEY: PolicyKey = 'upload_limits';
const MB = 1024 * 1024;
const GB = 1024 * MB;

const DEFAULT_UPLOAD_LIMIT_CONFIG: UploadLimitConfig = {
  perRoleBytes: {
    new: 10 * MB,
    trusted: 1 * GB,
    moderator: 30 * GB,
    admin: null,
    owner: null
  },
  globalUploadCapBytes: null
};

const DEFAULT_DOWNLOAD_LIMIT_CONFIG: DownloadLimitConfig = {
  perRoleBytes: {
    new: 10 * MB,
    trusted: 1 * GB,
    moderator: 30 * GB,
    admin: null,
    owner: null
  },
  globalDownloadCapBytes: null
};

function cloneDefaultUploadLimits(): UploadLimitConfig {
  return {
    perRoleBytes: { ...DEFAULT_UPLOAD_LIMIT_CONFIG.perRoleBytes },
    globalUploadCapBytes: DEFAULT_UPLOAD_LIMIT_CONFIG.globalUploadCapBytes
  };
}

function cloneDefaultDownloadLimits(): DownloadLimitConfig {
  return {
    perRoleBytes: { ...DEFAULT_DOWNLOAD_LIMIT_CONFIG.perRoleBytes },
    globalDownloadCapBytes: DEFAULT_DOWNLOAD_LIMIT_CONFIG.globalDownloadCapBytes
  };
}

function normalizeLimitValue(value: unknown): UploadLimitBytes {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function sanitizeUploadLimitConfig(raw: unknown): UploadLimitConfig {
  const config = cloneDefaultUploadLimits();
  if (!raw || typeof raw !== 'object') return config;

  const input = raw as Partial<UploadLimitConfig>;
  const perRole = input.perRoleBytes as Partial<Record<RolePolicyTier, unknown>> | undefined;
  if (perRole && typeof perRole === 'object') {
    for (const tier of ['new', 'trusted', 'moderator', 'admin', 'owner'] as RolePolicyTier[]) {
      if (Object.prototype.hasOwnProperty.call(perRole, tier)) {
        config.perRoleBytes[tier] = normalizeLimitValue(perRole[tier]);
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'globalUploadCapBytes')) {
    config.globalUploadCapBytes = normalizeLimitValue(input.globalUploadCapBytes);
  }

  return config;
}

function sanitizeDownloadLimitConfig(raw: unknown): DownloadLimitConfig {
  const config = cloneDefaultDownloadLimits();
  if (!raw || typeof raw !== 'object') return config;

  const input = raw as Partial<DownloadLimitConfig>;
  const perRole = input.perRoleBytes as Partial<Record<RolePolicyTier, unknown>> | undefined;
  if (perRole && typeof perRole === 'object') {
    for (const tier of ['new', 'trusted', 'moderator', 'admin', 'owner'] as RolePolicyTier[]) {
      if (Object.prototype.hasOwnProperty.call(perRole, tier)) {
        config.perRoleBytes[tier] = normalizeLimitValue(perRole[tier]);
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'globalDownloadCapBytes')) {
    config.globalDownloadCapBytes = normalizeLimitValue(input.globalDownloadCapBytes);
  }

  return config;
}

interface PolicyDefinition<TValue> {
  defaultValue: TValue;
  sanitize: (raw: unknown) => TValue;
}

const POLICY_DEFINITIONS: Record<PolicyKey, PolicyDefinition<unknown>> = {
  upload_limits: {
    defaultValue: cloneDefaultUploadLimits(),
    sanitize: sanitizeUploadLimitConfig
  },
  download_limits: {
    defaultValue: cloneDefaultDownloadLimits(),
    sanitize: sanitizeDownloadLimitConfig
  }
};

function isKnownPolicyKey(value: string): value is PolicyKey {
  return Object.prototype.hasOwnProperty.call(POLICY_DEFINITIONS, value);
}

function getPolicyValue<TValue>(key: PolicyKey): TValue {
  const definition = POLICY_DEFINITIONS[key] as PolicyDefinition<TValue>;
  const raw = appPolicyRepository.getRaw(`policy:${key}`);
  if (!raw) return definition.defaultValue;
  try {
    return definition.sanitize(JSON.parse(raw));
  } catch (error) {
    console.warn(`[Policies] Failed to parse policy '${key}'; falling back to defaults`);
    return definition.defaultValue;
  }
}

function savePolicyValue<TValue>(key: PolicyKey, rawInput: unknown): TValue {
  const definition = POLICY_DEFINITIONS[key] as PolicyDefinition<TValue>;
  const sanitized = definition.sanitize(rawInput);
  appPolicyRepository.setRaw(`policy:${key}`, JSON.stringify(sanitized));
  return sanitized;
}

function getPolicyDefaults<TValue>(key: PolicyKey): TValue {
  const definition = POLICY_DEFINITIONS[key] as PolicyDefinition<TValue>;
  return definition.defaultValue;
}

function resolveUploadRoleTier(userId: number | null, guestSessionId: string | null): RolePolicyTier {
  if (!userId) return guestSessionId ? 'new' : 'new';
  const roles = getUserRoles(userId, 'default-workspace');
  if (roles.includes('owner')) return 'owner';
  if (roles.includes('admin')) return 'admin';
  if (roles.includes('mod')) return 'moderator';
  return 'trusted';
}

function getEffectiveUploadCapBytes(roleTier: RolePolicyTier, config: UploadLimitConfig): UploadLimitBytes {
  const roleCap = normalizeLimitValue(config.perRoleBytes[roleTier]);
  const globalCap = normalizeLimitValue(config.globalUploadCapBytes);
  if (roleCap === null) return globalCap;
  if (globalCap === null) return roleCap;
  return Math.min(roleCap, globalCap);
}

function enforceUploadLimit(
  res: any,
  userId: number | null,
  guestSessionId: string | null,
  fileSize: number,
  fileName: string,
  source: 'direct-upload' | 'resumable-init' | 'resumable-chunk'
): boolean {
  const tier = resolveUploadRoleTier(userId, guestSessionId);
  const config = getPolicyValue<UploadLimitConfig>(UPLOAD_LIMITS_POLICY_KEY);
  const capBytes = getEffectiveUploadCapBytes(tier, config);
  if (capBytes !== null && fileSize > capBytes) {
    console.warn(`[Uploads] Rejected ${source} (${fileName}) size=${fileSize} tier=${tier} cap=${capBytes} userId=${userId ?? 'guest'}`);
    res.writeHead(413, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        success: false,
        error: 'File exceeds upload limit for your role',
        roleTier: tier,
        fileSizeBytes: fileSize,
        limitBytes: capBytes
      })
    );
    return false;
  }
  return true;
}
// In-memory data store
interface Channel {
  id: string;
  name: string;
  description?: string;
  minRole?: string;
  createdAt: number;
  type?: 'text' | 'voice' | 'dm' | 'group' | 'public' | 'thread_public' | 'thread_private';
  members?: string[]; // User IDs for DMs and group chats
  parentChannelId?: string;
  isBreakout?: boolean;
  breakoutIndex?: number;
  parentMessageId?: string;
  threadArchived?: boolean;
  threadLocked?: boolean;
  threadAutoArchiveMinutes?: number;
  threadLastActivityAt?: number;
  autoDeleteAfter?: '1h' | '6h' | '12h' | '24h' | '3d' | '7d' | '14d' | '30d' | null;
  isTemporary?: boolean;
  persistMessages?: boolean; // Opt-in flag for message persistence
  pinnedBy?: string[]; // Array of user IDs who have pinned this channel
  recipientNotified?: boolean;
  voiceSettings?: {
    bitrateMode?: 'auto' | 'low' | 'standard' | 'high';
  };
}

function normalizeChannelType(raw?: string): 'text' | 'voice' | 'dm' | 'group' | 'thread_public' | 'thread_private' {
  if (raw === 'voice' || raw === 'dm' || raw === 'group' || raw === 'text' || raw === 'thread_public' || raw === 'thread_private') return raw;
  return 'text'; // legacy 'public' and undefined map to text
}

const channels = new Map<string, Channel>();
channels.set('general', { id: 'general', name: 'general', createdAt: Date.now(), type: 'text' });
channels.set('voice', { id: 'voice', name: 'voice', createdAt: Date.now(), type: 'voice' });

const channelMessages = new Map<string, Array<{
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
  scheduledDeletionTime?: number; // Unix timestamp when message should be deleted
  reactions?: Record<string, string[]>; // emojiId -> array of userIds who reacted
}>>();

// Initialize general channel with empty messages
channelMessages.set('general', []);
channelMessages.set('voice', []);

const pinnedMessages = new Map<string, Set<string>>(); // channelId -> Set of messageIds
pinnedMessages.set('general', new Set());
pinnedMessages.set('voice', new Set());

const users = new Map<string, {
  id: string;
  username: string;
  handle?: string;
  color: string;
  status: 'active' | 'away' | 'busy';
  profilePicture?: string;
  workspaceId?: string; // Business workspace the user belongs to
  dbUserId?: number; // Stable registered user ID from DB (null for guests)
  roles?: string[];
  highestRole?: string;
  roleColor?: string | null;
  usernameFont?: {
    family?: string;
    size?: string;
    weight?: string;
    style?: string;
  };
}>();

// Reverse mapping: stable dbUserId -> current socket.id (for registered users only)
const dbUserIdToSocketId = new Map<number, string>();

// Helper: get the stable identity key for a user (dbUserId string for registered, socket.id for guests)
function getStableUserId(socket: any): string {
  if ((socket as any).isRegistered && (socket as any).dbUserId) {
    return `user-${(socket as any).dbUserId}`;
  }
  return socket.id;
}

// Helper: resolve a stable user ID to the current socket.id for delivery
function resolveSocketId(stableId: string): string | null {
  if (stableId.startsWith('user-')) {
    const dbId = parseInt(stableId.substring(5), 10);
    return dbUserIdToSocketId.get(dbId) || null;
  }
  return stableId; // Already a socket.id (guest user)
}

function parseVoiceSettings(raw: string | null | undefined): Channel['voiceSettings'] {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (error) {
    console.warn('[Voice] Invalid channel voice settings JSON; ignoring persisted value');
  }
  return undefined;
}

// Session management for persistence across reconnects
const sessions = new Map<string, { userId: string; username: string; color: string; profilePicture?: string; createdAt: number; usernameFont?: any }>();

// Generate a random session ID
function generateSessionId(): string {
	return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

const typingUsers = new Set<string>();

// Business workspace data - for collaborative business features
interface BusinessData {
  workspaceId: string;
  todos: any[];
  calendarEvents: any[];
  diaryEntries: any[];
  projects: any[];
  sprints: any[];
  resources: any[];
  tags: any[];
  graphEdges: any[];
  lastUpdated: number;
}

const businessWorkspaces = new Map<string, BusinessData>();
const defaultWorkspaceId = 'default-workspace'; // Default workspace for all users
// Track which channel each user is currently in
const userCurrentChannel = new Map<string, string>();
// Track typing users per channel: channelId -> Set of userIds
const channelTypingUsers = new Map<string, Set<string>>();

// Testing-only role cheatcode (opt-in via env vars).
// Example:
//   WABI_TEST_ROLE_CHEATCODE=true
//   WABI_TEST_ROLE_CHEATCODE_PHRASE=shmoogaloo
//   WABI_TEST_ROLE_CHEATCODE_ROLE=owner
const TEST_ROLE_CHEATCODE_ENABLED = (process.env.WABI_TEST_ROLE_CHEATCODE || '').trim().toLowerCase() === 'true';
const TEST_ROLE_CHEATCODE_PHRASE = (process.env.WABI_TEST_ROLE_CHEATCODE_PHRASE || 'shmoogaloo').trim().toLowerCase();
const TEST_ROLE_CHEATCODE_ROLE: 'owner' | 'admin' =
  (process.env.WABI_TEST_ROLE_CHEATCODE_ROLE || '').trim().toLowerCase() === 'admin' ? 'admin' : 'owner';
let testRoleCheatcodeConsumed = false;

function workspaceHasOwner(): boolean {
  const ownerExists = db.prepare(
    "SELECT 1 FROM user_roles WHERE role_name = 'owner' AND workspace_id = 'default-workspace' LIMIT 1"
  ).get();
  return Boolean(ownerExists);
}

// WebRTC signaling state
const screenSharers = new Map<string, {
  userId: string;
  username: string;
}>();

// Track active call peers: socketId -> Set of partner socketIds
const activeCallPeers = new Map<string, Set<string>>();

// Voice channel runtime state (transient, never persisted)
const voiceChannelParticipants = new Map<string, Set<string>>(); // channelId -> stable user IDs
const voiceChannelSubscribers = new Map<string, Set<string>>(); // channelId -> socket IDs listening to updates/media
const socketVoiceSubscriptions = new Map<string, Set<string>>(); // socket ID -> channel IDs
const voicePeerGraph = new Map<string, Set<string>>(); // stable user ID -> negotiated peer stable user IDs

function findUserByStableId(stableUserId: string): User | undefined {
	if (stableUserId.startsWith('user-')) {
		const dbUserId = parseInt(stableUserId.substring(5), 10);
		if (!Number.isNaN(dbUserId)) {
			return Array.from(users.values()).find(user => user.dbUserId === dbUserId);
		}
	}
	return users.get(stableUserId);
}

function buildVoiceParticipant(stableUserId: string): { userId: string; socketId: string; username?: string; profilePicture?: string } {
	const user = findUserByStableId(stableUserId);
	return {
		userId: stableUserId,
		socketId: resolveSocketId(stableUserId) || stableUserId,
		username: user?.username,
		profilePicture: user?.profilePicture
	};
}

function getVoiceChannelMembers(channelId: string): Array<{ userId: string; socketId: string; username?: string; profilePicture?: string }> {
	const participants = voiceChannelParticipants.get(channelId);
	if (!participants || participants.size === 0) return [];
	return Array.from(participants).map(buildVoiceParticipant);
}

function addVoiceSubscription(socketId: string, channelId: string): void {
	let channelSubscribers = voiceChannelSubscribers.get(channelId);
	if (!channelSubscribers) {
		channelSubscribers = new Set<string>();
		voiceChannelSubscribers.set(channelId, channelSubscribers);
	}
	channelSubscribers.add(socketId);

	let socketSubscriptions = socketVoiceSubscriptions.get(socketId);
	if (!socketSubscriptions) {
		socketSubscriptions = new Set<string>();
		socketVoiceSubscriptions.set(socketId, socketSubscriptions);
	}
	socketSubscriptions.add(channelId);
}

function removeVoiceSubscription(socketId: string, channelId: string): void {
	const channelSubscribers = voiceChannelSubscribers.get(channelId);
	if (channelSubscribers) {
		channelSubscribers.delete(socketId);
		if (channelSubscribers.size === 0) {
			voiceChannelSubscribers.delete(channelId);
		}
	}

	const socketSubscriptions = socketVoiceSubscriptions.get(socketId);
	if (socketSubscriptions) {
		socketSubscriptions.delete(channelId);
		if (socketSubscriptions.size === 0) {
			socketVoiceSubscriptions.delete(socketId);
		}
	}
}

function removeAllVoiceSubscriptionsForSocket(socketId: string): void {
	const channels = Array.from(socketVoiceSubscriptions.get(socketId) || []);
	for (const channelId of channels) {
		removeVoiceSubscription(socketId, channelId);
	}
}

function getVoiceAudienceSocketIds(channelId: string): Set<string> {
	const audience = new Set<string>();

	const participants = voiceChannelParticipants.get(channelId);
	if (participants) {
		for (const stableUserId of participants) {
			const participantSocketId = resolveSocketId(stableUserId);
			if (participantSocketId) {
				audience.add(participantSocketId);
			}
		}
	}

	const subscribers = voiceChannelSubscribers.get(channelId);
	if (subscribers) {
		for (const subscriberSocketId of subscribers) {
			audience.add(subscriberSocketId);
		}
	}

	return audience;
}

function emitToVoiceAudience(channelId: string, event: string, data: any): void {
	for (const socketId of getVoiceAudienceSocketIds(channelId)) {
		io.to(socketId).emit(event, data);
	}
}

function getVoiceStatePayload(): Record<string, Array<{ userId: string; socketId: string; username?: string; profilePicture?: string }>> {
	const payload: Record<string, Array<{ userId: string; socketId: string; username?: string; profilePicture?: string }>> = {};
	for (const channelId of voiceChannelParticipants.keys()) {
		payload[channelId] = getVoiceChannelMembers(channelId);
	}
	return payload;
}

function emitVoiceChannelState(channelId: string): void {
	emitToVoiceAudience(channelId, "voice-channel-state", {
		channelId,
		members: getVoiceChannelMembers(channelId)
	});
}

function getBreakoutChannelsForParent(parentChannelId: string): Channel[] {
	return Array.from(channels.values())
		.filter(channel => channel.type === 'voice' && channel.parentChannelId === parentChannelId)
		.sort((a, b) => (a.breakoutIndex || 0) - (b.breakoutIndex || 0));
}

function resolveStableUserIdFromAny(rawId: string): string | null {
	if (!rawId) return null;
	if (rawId.startsWith('user-')) return rawId;
	const user = users.get(rawId);
	if (user?.dbUserId) return `user-${user.dbUserId}`;
	if (users.has(rawId)) return rawId;
	return null;
}

function moveVoiceParticipant(stableUserId: string, fromChannelId: string, toChannelId: string): void {
	if (fromChannelId === toChannelId) return;
	const fromParticipants = voiceChannelParticipants.get(fromChannelId);
	if (!fromParticipants || !fromParticipants.has(stableUserId)) return;

	let toParticipants = voiceChannelParticipants.get(toChannelId);
	if (!toParticipants) {
		toParticipants = new Set<string>();
		voiceChannelParticipants.set(toChannelId, toParticipants);
	}
	if (toParticipants.has(stableUserId)) return;

	const memberUser = findUserByStableId(stableUserId);
	const memberSocketId = resolveSocketId(stableUserId) || stableUserId;

	fromParticipants.delete(stableUserId);
	if (fromParticipants.size === 0) {
		voiceChannelParticipants.delete(fromChannelId);
	}

	toParticipants.add(stableUserId);

	emitVoiceChannelState(fromChannelId);
	emitVoiceChannelState(toChannelId);

	emitToVoiceAudience(fromChannelId, "voice-channel-user-left", {
		channelId: fromChannelId,
		userId: stableUserId,
		socketId: memberSocketId
	});
	emitToVoiceAudience(toChannelId, "voice-channel-user-joined", {
		channelId: toChannelId,
		userId: stableUserId,
		socketId: memberSocketId,
		username: memberUser?.username
	});
}

function addVoicePeerLink(stableA: string, stableB: string) {
  if (stableA === stableB) return;
  if (!voicePeerGraph.has(stableA)) voicePeerGraph.set(stableA, new Set());
  if (!voicePeerGraph.has(stableB)) voicePeerGraph.set(stableB, new Set());
  voicePeerGraph.get(stableA)!.add(stableB);
  voicePeerGraph.get(stableB)!.add(stableA);
}

function removeVoicePeerLink(stableA: string, stableB: string) {
  voicePeerGraph.get(stableA)?.delete(stableB);
  if ((voicePeerGraph.get(stableA)?.size || 0) === 0) voicePeerGraph.delete(stableA);
  voicePeerGraph.get(stableB)?.delete(stableA);
  if ((voicePeerGraph.get(stableB)?.size || 0) === 0) voicePeerGraph.delete(stableB);
}

function removeAllVoicePeerLinks(stableId: string): Set<string> {
  const peers = new Set(voicePeerGraph.get(stableId) || []);
  for (const peerStableId of peers) {
    voicePeerGraph.get(peerStableId)?.delete(stableId);
    if ((voicePeerGraph.get(peerStableId)?.size || 0) === 0) {
      voicePeerGraph.delete(peerStableId);
    }
  }
  voicePeerGraph.delete(stableId);
  return peers;
}

function addCallPeer(socketId: string, peerId: string) {
  if (!activeCallPeers.has(socketId)) activeCallPeers.set(socketId, new Set());
  if (!activeCallPeers.has(peerId)) activeCallPeers.set(peerId, new Set());
  activeCallPeers.get(socketId)!.add(peerId);
  activeCallPeers.get(peerId)!.add(socketId);
}

function removeAllCallPeers(socketId: string): Set<string> {
  const peers = activeCallPeers.get(socketId) || new Set();
  for (const peerId of peers) {
    activeCallPeers.get(peerId)?.delete(socketId);
    if (activeCallPeers.get(peerId)?.size === 0) activeCallPeers.delete(peerId);
  }
  activeCallPeers.delete(socketId);
  return peers;
}

// Excalidraw state
let excalidrawState: any = null;

// Emote storage
const emotes = new Map<string, {
  name: string;
  url: string;
  type: 'static' | 'animated';
  uploadedBy: string;
  timestamp: number;
}>();

// Auto-delete message timers
const messageDeletionTimers = new Map<string, NodeJS.Timeout>(); // messageId -> timer

// Helper function to convert auto-delete duration to milliseconds
function getAutoDeleteMs(duration: string): number {
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

// Helper function to schedule message deletion
function scheduleMessageDeletion(channelId: string, messageId: string, duration: string) {
  const ms = getAutoDeleteMs(duration);
  if (ms === 0) return;

  const timer = setTimeout(() => {
    const messages = channelMessages.get(channelId);
    if (!messages) return;

    const messageIndex = messages.findIndex(m => m.id === messageId);
    if (messageIndex === -1) return;

    const message = messages[messageIndex];

    // Delete associated files from filesystem
    if (message.fileUrl) {
      const fileName = message.fileUrl.replace('/uploads/', '');
      const filePath = join(UPLOADS_DIR, fileName);
      try {
        if (existsSync(filePath)) {
          unlinkSync(filePath);
        }
      } catch (err) {
        console.error(`Failed to delete file: ${fileName}`, err);
      }
    }

    // Delete multiple files if present
    if (message.files && message.files.length > 0) {
      for (const file of message.files) {
        const fileName = file.fileUrl.replace('/uploads/', '');
        const filePath = join(UPLOADS_DIR, fileName);
        try {
          if (existsSync(filePath)) {
            unlinkSync(filePath);
          }
        } catch (err) {
          console.error(`Failed to delete file: ${fileName}`, err);
        }
      }
    }

    // Remove message
    messages.splice(messageIndex, 1);
    channelMessages.set(channelId, messages);

    // Soft-delete from database
    try { messageRepository.softDelete(messageId); } catch {}

    // Notify clients
    emitToChannel(channelId, "message-deleted", { channelId, messageId });

    // Clean up timer reference
    messageDeletionTimers.delete(messageId);

    if (ENABLE_LOGGING) console.log(`Auto-deleted message ${messageId} from channel ${channelId}`);
  }, ms);

  messageDeletionTimers.set(messageId, timer);
}

// Helper function to cancel scheduled message deletion
function cancelMessageDeletion(messageId: string) {
  const timer = messageDeletionTimers.get(messageId);
  if (timer) {
    clearTimeout(timer);
    messageDeletionTimers.delete(messageId);
  }
}

// Message persistence functions
const MESSAGES_FILE = join(DATA_DIR, 'messages.json');
const BUSINESS_DATA_DIR = join(DATA_DIR, BUSINESS_DATA_DIR_NAME);

// Ensure data directories exist
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}
if (!existsSync(BUSINESS_DATA_DIR)) {
  mkdirSync(BUSINESS_DATA_DIR, { recursive: true });
}

function saveMessagesToDisk() {
  try {
    const messagesToSave: Record<string, any[]> = {};

    channelMessages.forEach((messages, channelId) => {
      const channel = channels.get(channelId);
      // Only persist messages for channels with persistMessages enabled
      if (channel?.persistMessages) {
        messagesToSave[channelId] = messages;
      }
    });

    writeFileSync(MESSAGES_FILE, JSON.stringify(messagesToSave, null, 2));
    if (ENABLE_LOGGING) console.log('💾 Messages saved to disk');
  } catch (error) {
    console.error('Error saving messages:', error);
  }
}

function loadMessagesFromDisk() {
  try {
    if (existsSync(MESSAGES_FILE)) {
      const data = readFileSync(MESSAGES_FILE, 'utf-8');
      const savedMessages: Record<string, any[]> = JSON.parse(data);

      Object.entries(savedMessages).forEach(([channelId, messages]) => {
        channelMessages.set(channelId, messages);
      });

      if (ENABLE_LOGGING) console.log('📂 Messages loaded from disk');
    }
  } catch (error) {
    console.error('Error loading messages:', error);
  }
}

function restoreMessageDeletionTimers() {
  channelMessages.forEach((messages, channelId) => {
    const channel = channels.get(channelId);

    messages.forEach(message => {
      if (message.scheduledDeletionTime && channel?.autoDeleteAfter) {
        const timeRemaining = message.scheduledDeletionTime - Date.now();

        if (timeRemaining <= 0) {
          // Message should have been deleted, delete now
          deleteMessageById(channelId, message.id);
        } else {
          // Schedule deletion for remaining time
          const timer = setTimeout(() => {
            deleteMessageById(channelId, message.id);
          }, timeRemaining);
          messageDeletionTimers.set(message.id, timer);

          if (ENABLE_LOGGING) {
            console.log(`⏱️  Restored deletion timer for message ${message.id} (${Math.round(timeRemaining / 1000)}s remaining)`);
          }
        }
      }
    });
  });
}

// deleteMessageById will be defined after Socket.IO initialization
// For now, we declare it as a variable to be assigned later
let deleteMessageById: ((channelId: string, messageId: string) => void) | null = null;

// Business data persistence functions
function getBusinessDataPath(workspaceId: string): string {
  return join(BUSINESS_DATA_DIR, `${workspaceId}.json`);
}

function loadBusinessData(workspaceId: string): BusinessData | null {
  try {
    const filePath = getBusinessDataPath(workspaceId);
    if (existsSync(filePath)) {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      const enableLogging = process.env.ENABLE_LOGGING === 'true';
      if (enableLogging) console.log(`📊 Loaded business data for workspace: ${workspaceId}`);
      return data;
    }
  } catch (error) {
    console.error(`Error loading business data for workspace ${workspaceId}:`, error);
  }
  return null;
}

function saveBusinessData(workspaceId: string, data: BusinessData): void {
  try {
    const filePath = getBusinessDataPath(workspaceId);
    data.lastUpdated = Date.now();
    writeFileSync(filePath, JSON.stringify(data, null, 2));
    const enableLogging = process.env.ENABLE_LOGGING === 'true';
    if (enableLogging) console.log(`💾 Saved business data for workspace: ${workspaceId}`);
  } catch (error) {
    console.error(`Error saving business data for workspace ${workspaceId}:`, error);
  }
}

function initializeWorkspace(workspaceId: string): BusinessData {
  const data: BusinessData = {
    workspaceId,
    todos: [],
    calendarEvents: [],
    diaryEntries: [],
    projects: [],
    sprints: [],
    resources: [],
    tags: [],
    graphEdges: [],
    lastUpdated: Date.now()
  };

  // Try to load from disk first
  const loaded = loadBusinessData(workspaceId);
  if (loaded) {
    businessWorkspaces.set(workspaceId, loaded);
    return loaded;
  }

  // Otherwise use empty data
  businessWorkspaces.set(workspaceId, data);
  saveBusinessData(workspaceId, data);
  return data;
}

// Initialize default workspace on startup
initializeWorkspace(defaultWorkspaceId);

const PORT = process.env.PORT || 3000;
const STATIC_DIR = process.env.STATIC_DIR || '/app/frontend/build';
const EMOTES_DIR = join(STATIC_DIR, "emotes");
const ENABLE_LOGGING = process.env.ENABLE_LOGGING === 'true';

// Ensure emotes directory exists
if (!existsSync(EMOTES_DIR)) {
  mkdirSync(EMOTES_DIR, { recursive: true });
}

// Ensure uploads directory exists (imported from constants.ts)
if (!existsSync(UPLOADS_DIR)) {
  mkdirSync(UPLOADS_DIR, { recursive: true });
}
const RESUMABLE_UPLOADS_DIR = join(UPLOADS_DIR, '.resumable');
if (!existsSync(RESUMABLE_UPLOADS_DIR)) {
  mkdirSync(RESUMABLE_UPLOADS_DIR, { recursive: true });
}

interface ResumableUploadMeta {
  uploadId: string;
  ownerKey: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  channelId: string;
  createdAt: number;
  updatedAt: number;
  status: 'uploading' | 'completed';
  fileUrl?: string;
}

interface AttachmentEncryptionMeta {
  scheme: 'dm-e2ee-v1';
  iv: string;
  mimeType?: string;
  originalSize?: number;
}

function createUploadId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const AT_REST_MAGIC = Buffer.from('WABIENC1');
const FILE_ENCRYPTION_SECRET = process.env.FILE_ENCRYPTION_KEY || '';
const FILE_ENCRYPTION_KEY = FILE_ENCRYPTION_SECRET
  ? createHash('sha256').update(FILE_ENCRYPTION_SECRET).digest()
  : null;
const UPLOAD_TOKEN_SECRET = process.env.UPLOAD_TOKEN_SECRET || process.env.JWT_SECRET || process.env.SESSION_SECRET || 'wabi-upload-secret-change-me';
const UPLOAD_TOKEN_TTL_MS = 15 * 60 * 1000;

function base64UrlEncodeBuffer(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecodeToBuffer(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4);
  return Buffer.from(padded, 'base64');
}

function signUploadToken(uploadId: string, ownerKey: string): string {
  const payload = {
    uploadId,
    ownerKey,
    exp: Date.now() + UPLOAD_TOKEN_TTL_MS,
    nonce: randomBytes(6).toString('hex')
  };
  const payloadB64 = base64UrlEncodeBuffer(Buffer.from(JSON.stringify(payload)));
  const sig = createHmac('sha256', UPLOAD_TOKEN_SECRET).update(payloadB64).digest();
  return `${payloadB64}.${base64UrlEncodeBuffer(sig)}`;
}

function verifyUploadToken(token: string, uploadId: string, ownerKey: string): boolean {
  if (!token || token.indexOf('.') === -1) return false;
  const [payloadB64, sigB64] = token.split('.', 2);
  if (!payloadB64 || !sigB64) return false;
  try {
    const expectedSig = createHmac('sha256', UPLOAD_TOKEN_SECRET).update(payloadB64).digest();
    const providedSig = base64UrlDecodeToBuffer(sigB64);
    if (providedSig.length !== expectedSig.length || !timingSafeEqual(providedSig, expectedSig)) {
      return false;
    }
    const payload = JSON.parse(base64UrlDecodeToBuffer(payloadB64).toString('utf8')) as {
      uploadId: string;
      ownerKey: string;
      exp: number;
    };
    if (payload.uploadId !== uploadId) return false;
    if (payload.ownerKey !== ownerKey) return false;
    if (!payload.exp || payload.exp < Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

function maybeEncryptForAtRest(plain: Buffer): Buffer {
  if (!FILE_ENCRYPTION_KEY) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', FILE_ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([AT_REST_MAGIC, iv, tag, encrypted]);
}

function maybeDecryptFromAtRest(buffer: Buffer): Buffer {
  if (!buffer.slice(0, AT_REST_MAGIC.length).equals(AT_REST_MAGIC)) {
    return buffer;
  }
  if (!FILE_ENCRYPTION_KEY) {
    throw new Error('Encrypted upload payload found but FILE_ENCRYPTION_KEY is not configured');
  }
  const headerEnd = AT_REST_MAGIC.length + 12 + 16;
  if (buffer.length < headerEnd) {
    throw new Error('Invalid encrypted upload payload');
  }
  const iv = buffer.slice(AT_REST_MAGIC.length, AT_REST_MAGIC.length + 12);
  const tag = buffer.slice(AT_REST_MAGIC.length + 12, headerEnd);
  const ciphertext = buffer.slice(headerEnd);
  const decipher = createDecipheriv('aes-256-gcm', FILE_ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function writeUploadFile(filePath: string, payload: Buffer): void {
  writeFileSync(filePath, maybeEncryptForAtRest(payload));
}

function sanitizeUploadFileName(fileName: string): string {
  const base = basename(fileName || 'upload.bin');
  return base.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

function getUploadOwnerKey(userId: number | null, guestSessionId: string | null): string | null {
  if (userId) return `user:${userId}`;
  if (guestSessionId && sessions.has(guestSessionId)) return `guest:${guestSessionId}`;
  return null;
}

function getResumableMetaPath(uploadId: string): string {
  return join(RESUMABLE_UPLOADS_DIR, `${uploadId}.json`);
}

function getResumablePartPath(uploadId: string): string {
  return join(RESUMABLE_UPLOADS_DIR, `${uploadId}.part`);
}

function loadResumableMeta(uploadId: string): ResumableUploadMeta | null {
  const metaPath = getResumableMetaPath(uploadId);
  if (!existsSync(metaPath)) return null;
  try {
    const raw = readFileSync(metaPath, 'utf8');
    return JSON.parse(raw) as ResumableUploadMeta;
  } catch {
    return null;
  }
}

function saveResumableMeta(meta: ResumableUploadMeta): void {
  const metaPath = getResumableMetaPath(meta.uploadId);
  writeFileSync(metaPath, JSON.stringify(meta));
}

function getUploadedBytes(uploadId: string): number {
  const partPath = getResumablePartPath(uploadId);
  if (!existsSync(partPath)) return 0;
  try {
    return statSync(partPath).size;
  } catch {
    return 0;
  }
}

function readRequestBuffer(req: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err: Error) => reject(err));
  });
}

function getUploadTokenFromRequest(req: any, url: URL): string {
  const headerToken = req.headers['x-upload-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }
  const queryToken = url.searchParams.get('uploadToken');
  return queryToken?.trim() || '';
}

// Create HTTP server using Node.js http module (Bun compatible)
const server = createServer();

// Create Socket.IO server BEFORE attaching request handler
// This ensures Socket.IO can intercept /socket.io/ requests properly
const io = new Server(server, {
  cors: {
    origin: getAllowedOrigins(),
    methods: ["GET", "POST"],
    credentials: true
  },
  maxHttpBufferSize: 75 * 1024 * 1024, // 75MB (to handle 50MB files after base64 encoding ~33% overhead)
  pingTimeout: 30000,       // 30s pong wait (more forgiving for mobile)
  pingInterval: 25000,      // 25s ping (keeps alive through proxies)
  connectTimeout: 15000,    // 15s initial connect (fail faster than default 45s)
  transports: ['websocket', 'polling'],
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 min recovery window
    skipMiddlewares: false
  }
});

// Helper function to verify auth token from request
function getAuthenticatedUserId(req: any): number | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  try {
    const token = authHeader.slice(7);
    const payload = verifyToken(token);
    const dbSession = sessionRepository.findById(payload.sessionId);
    if (!dbSession || (dbSession.expires_at && dbSession.expires_at < Date.now())) {
      return null;
    }
    return payload.userId;
  } catch {
    return null;
  }
}

function isPluginAdmin(userId: number | null): boolean {
  if (!userId) return false;
  if (userId === 1) return true;
  const roles = getUserRoles(userId, 'default-workspace');
  return roles.includes('owner') || roles.includes('admin');
}

function getGuestSessionId(req: any): string | null {
  const sessionHeader = req.headers['x-session-id'];
  if (typeof sessionHeader === 'string' && sessionHeader.trim().length > 0) {
    return sessionHeader.trim();
  }
  return null;
}

// Request handler
server.on('request', async (req, res) => {
  // Skip Socket.IO requests - Socket.IO handles them at a lower level
  if (req.url?.startsWith('/socket.io/')) {
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // CORS headers for all requests - use centralized config
  const corsHeaders = getCORSHeaders(req.headers.origin as string);
  Object.entries(corsHeaders).forEach(([header, value]) => {
    res.setHeader(header, value);
  });

  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Plugin admin APIs
  if (url.pathname === "/api/plugins" && req.method === "GET") {
    const userId = getAuthenticatedUserId(req);
    if (!isPluginAdmin(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin permissions required" }));
      return;
    }

    try {
      const plugins = pluginLoader.getLoadedPlugins();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, plugins }));
    } catch (error) {
      console.error("[Plugins] Failed to fetch plugin list:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Failed to list plugins" }));
    }
    return;
  }

  if (url.pathname === "/api/plugins/audit" && req.method === "GET") {
    const userId = getAuthenticatedUserId(req);
    if (!isPluginAdmin(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin permissions required" }));
      return;
    }

    try {
      const rawLimit = Number(url.searchParams.get("limit") || "200");
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(1000, Math.floor(rawLimit))) : 200;
      const events = pluginLoader.getAuditEvents(limit);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, events }));
    } catch (error) {
      console.error("[Plugins] Failed to fetch audit log:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Failed to fetch plugin audit log" }));
    }
    return;
  }

  if (url.pathname === "/api/plugins/signers" && req.method === "GET") {
    const userId = getAuthenticatedUserId(req);
    if (!isPluginAdmin(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin permissions required" }));
      return;
    }

    try {
      const signers = pluginLoader.getTrustedSigners();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, signers }));
    } catch (error) {
      console.error("[Plugins] Failed to fetch trusted signers:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Failed to fetch trusted signers" }));
    }
    return;
  }

  if (url.pathname === "/api/plugins/signers" && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    if (!isPluginAdmin(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin permissions required" }));
      return;
    }

    try {
      const bodyBuffer = await readRequestBuffer(req);
      const body = JSON.parse(bodyBuffer.toString("utf-8"));
      const keyId = typeof body?.keyId === "string" ? body.keyId.trim() : "";
      const publicKey = typeof body?.publicKey === "string" ? body.publicKey.trim() : "";
      const note = typeof body?.note === "string" ? body.note.trim() : undefined;

      if (!keyId || !publicKey) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "keyId and publicKey are required" }));
        return;
      }

      pluginLoader.trustSigner({
        keyId,
        publicKey,
        trustedBy: `user:${userId}`,
        note
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, signers: pluginLoader.getTrustedSigners() }));
    } catch (error) {
      console.error("[Plugins] Failed to trust signer:", error);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Invalid request payload" }));
    }
    return;
  }

  const policyPathMatch = url.pathname.match(/^\/api\/admin\/policies\/([^/]+)$/);
  if (policyPathMatch && req.method === "GET") {
    const userId = getAuthenticatedUserId(req);
    if (!isPluginAdmin(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin permissions required" }));
      return;
    }

    const requestedKey = decodeURIComponent(policyPathMatch[1]);
    if (!isKnownPolicyKey(requestedKey)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Unknown policy key" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        success: true,
        key: requestedKey,
        config: getPolicyValue(requestedKey),
        defaults: getPolicyDefaults(requestedKey)
      })
    );
    return;
  }

  if (policyPathMatch && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    if (!isPluginAdmin(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin permissions required" }));
      return;
    }

    const requestedKey = decodeURIComponent(policyPathMatch[1]);
    if (!isKnownPolicyKey(requestedKey)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Unknown policy key" }));
      return;
    }

    try {
      const rawBody = JSON.parse((await readRequestBuffer(req)).toString() || '{}');
      const config = savePolicyValue(requestedKey, rawBody);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, key: requestedKey, config }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Invalid policy payload" }));
    }
    return;
  }

  // Compatibility alias for older clients
  if (url.pathname === "/api/admin/upload-limits" && req.method === "GET") {
    const userId = getAuthenticatedUserId(req);
    if (!isPluginAdmin(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin permissions required" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        success: true,
        config: getPolicyValue<UploadLimitConfig>(UPLOAD_LIMITS_POLICY_KEY),
        defaults: getPolicyDefaults<UploadLimitConfig>(UPLOAD_LIMITS_POLICY_KEY)
      })
    );
    return;
  }

  if (url.pathname === "/api/admin/upload-limits" && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    if (!isPluginAdmin(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin permissions required" }));
      return;
    }

    try {
      const rawBody = JSON.parse((await readRequestBuffer(req)).toString() || '{}');
      const config = savePolicyValue<UploadLimitConfig>(UPLOAD_LIMITS_POLICY_KEY, rawBody);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, config }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Invalid upload limit payload" }));
    }
    return;
  }

  if (url.pathname.startsWith("/api/plugins/signers/") && req.method === "DELETE") {
    const userId = getAuthenticatedUserId(req);
    if (!isPluginAdmin(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin permissions required" }));
      return;
    }

    try {
      const keyId = decodeURIComponent(url.pathname.replace("/api/plugins/signers/", "")).trim();
      if (!keyId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "keyId is required" }));
        return;
      }

      pluginLoader.untrustSigner(keyId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, signers: pluginLoader.getTrustedSigners() }));
    } catch (error) {
      console.error("[Plugins] Failed to remove trusted signer:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Failed to remove trusted signer" }));
    }
    return;
  }

  // Profile picture upload endpoint
  if (url.pathname === "/api/upload-profile-picture" && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized - authentication required' }));
      return;
    }

    let chunks: Buffer[] = [];

    req.on('data', (chunk) => {
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        const contentType = req.headers['content-type'];
        const boundary = contentType?.split('boundary=')[1];

        if (!boundary) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: 'Invalid content type' }));
          return;
        }

        const parts = buffer.toString('binary').split(`--${boundary}`);
        let profilePictureFile: Buffer | null = null;
        let profilePictureFileName = '';

        for (const part of parts) {
          if (part.includes('Content-Disposition') && part.includes('name="profilePicture"')) {
            const filenameMatch = part.match(/filename="([^"]+)"/);
            if (filenameMatch) {
              profilePictureFileName = filenameMatch[1];
              const dataStart = part.indexOf('\r\n\r\n') + 4;
              const dataEnd = part.lastIndexOf('\r\n');
              profilePictureFile = Buffer.from(part.substring(dataStart, dataEnd), 'binary');
              break;
            }
          }
        }

        if (profilePictureFile && profilePictureFileName) {
          // Validate file type
          const ext = profilePictureFileName.split('.').pop()?.toLowerCase();
          if (!ext || !['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: 'Invalid file type. Only PNG, JPG, JPEG, GIF, WEBP are allowed.' }));
            return;
          }

          // Validate file size (e.g., max 5MB)
          const MAX_FILE_SIZE = 5 * 1024 * 1024;
          if (profilePictureFile.length > MAX_FILE_SIZE) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: 'File too large. Maximum size is 5MB.' }));
            return;
          }

          const fileId = `pfp-${Date.now()}-${profilePictureFileName}`;
          const filePath = join(UPLOADS_DIR, fileId);

          if (!existsSync(UPLOADS_DIR)) {
            mkdirSync(UPLOADS_DIR, { recursive: true });
          }
          writeFileSync(filePath, profilePictureFile);

          const profilePictureUrl = `/uploads/${fileId}`;

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            success: true,
            profilePictureUrl
          }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: 'No profile picture file found in request' }));
        }
      } catch (error) {
        console.error('Profile picture upload error:', error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Internal server error during upload' }));
      }
    });
    return;
  }

  // Group avatar upload endpoint
  if (url.pathname === "/api/upload-group-avatar" && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized - authentication required' }));
      return;
    }

    let chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        const contentType = req.headers['content-type'];
        const boundary = contentType?.split('boundary=')[1];

        if (!boundary) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: 'Invalid content type' }));
          return;
        }

        const parts = buffer.toString('binary').split(`--${boundary}`);
        let avatarFile: Buffer | null = null;
        let avatarFileName = '';
        let channelId = '';

        for (const part of parts) {
          if (part.includes('Content-Disposition') && part.includes('name="channelId"')) {
            const dataStart = part.indexOf('\r\n\r\n') + 4;
            const dataEnd = part.lastIndexOf('\r\n');
            channelId = part.substring(dataStart, dataEnd).trim();
          }
          if (part.includes('Content-Disposition') && part.includes('name="avatar"')) {
            const filenameMatch = part.match(/filename="([^"]+)"/);
            if (filenameMatch) {
              avatarFileName = filenameMatch[1];
              const dataStart = part.indexOf('\r\n\r\n') + 4;
              const dataEnd = part.lastIndexOf('\r\n');
              avatarFile = Buffer.from(part.substring(dataStart, dataEnd), 'binary');
            }
          }
        }

        if (!channelId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: 'channelId is required' }));
          return;
        }

        if (avatarFile && avatarFileName) {
          const ext = avatarFileName.split('.').pop()?.toLowerCase();
          if (!ext || !['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: 'Invalid file type. Only PNG, JPG, JPEG, GIF, WEBP are allowed.' }));
            return;
          }

          const MAX_FILE_SIZE = 5 * 1024 * 1024;
          if (avatarFile.length > MAX_FILE_SIZE) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: 'File too large. Maximum size is 5MB.' }));
            return;
          }

          const fileId = `group-avatar-${Date.now()}-${avatarFileName}`;
          const filePath = join(UPLOADS_DIR, fileId);

          if (!existsSync(UPLOADS_DIR)) {
            mkdirSync(UPLOADS_DIR, { recursive: true });
          }
          writeFileSync(filePath, avatarFile);

          const avatarUrl = `/uploads/${fileId}`;

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, avatarUrl }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: 'No avatar file found in request' }));
        }
      } catch (error) {
        console.error('Group avatar upload error:', error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Internal server error during upload' }));
      }
    });
    return;
  }

  // Background image upload endpoint
  if (url.pathname === "/api/upload-background-image" && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized - authentication required' }));
      return;
    }

    let chunks: Buffer[] = [];

    req.on('data', (chunk) => {
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        const contentType = req.headers['content-type'];
        const boundary = contentType?.split('boundary=')[1];

        if (!boundary) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: 'Invalid content type' }));
          return;
        }

        const parts = buffer.toString('binary').split(`--${boundary}`);
        let backgroundImageFile: Buffer | null = null;
        let backgroundImageFileName = '';

        for (const part of parts) {
          if (part.includes('Content-Disposition') && part.includes('name="backgroundImage"')) {
            const filenameMatch = part.match(/filename="([^"]+)"/);
            if (filenameMatch) {
              backgroundImageFileName = filenameMatch[1];
              const dataStart = part.indexOf('\r\n\r\n') + 4;
              const dataEnd = part.lastIndexOf('\r\n');
              backgroundImageFile = Buffer.from(part.substring(dataStart, dataEnd), 'binary');
              break;
            }
          }
        }

        if (backgroundImageFile && backgroundImageFileName) {
          // Validate file type
          const ext = backgroundImageFileName.split('.').pop()?.toLowerCase();
          if (!ext || !['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: 'Invalid file type. Only PNG, JPG, JPEG, GIF, WEBP are allowed.' }));
            return;
          }

          // Validate file size (max 10MB for background images)
          const MAX_FILE_SIZE = 10 * 1024 * 1024;
          if (backgroundImageFile.length > MAX_FILE_SIZE) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: 'File too large. Maximum size is 10MB.' }));
            return;
          }

          const fileId = `bg-${Date.now()}-${backgroundImageFileName}`;
          const filePath = join(UPLOADS_DIR, fileId);

          if (!existsSync(UPLOADS_DIR)) {
            mkdirSync(UPLOADS_DIR, { recursive: true });
          }
          writeFileSync(filePath, backgroundImageFile);

          const backgroundImageUrl = `/uploads/${fileId}`;

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            success: true,
            backgroundImageUrl
          }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: 'No background image file found in request' }));
        }
      } catch (error) {
        console.error('Background image upload error:', error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Internal server error during upload' }));
      }
    });
    return;
  }

  // File upload endpoint
  if (url.pathname === "/api/upload/resumable/init" && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    const guestSessionId = getGuestSessionId(req);
    const ownerKey = getUploadOwnerKey(userId, guestSessionId);
    if (!ownerKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized - authentication required' }));
      return;
    }

    try {
      const payload = JSON.parse((await readRequestBuffer(req)).toString() || '{}') as {
        uploadId?: string;
        fileName?: string;
        fileSize?: number;
        mimeType?: string;
        channelId?: string;
      };

      const fileName = sanitizeUploadFileName(payload.fileName || '');
      const fileSize = Number(payload.fileSize || 0);
      const mimeType = (payload.mimeType || 'application/octet-stream').slice(0, 100);
      const channelId = (payload.channelId || '').slice(0, 100);

      if (!fileName || !fileSize || fileSize <= 0 || !Number.isFinite(fileSize)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Invalid file metadata' }));
        return;
      }
      if (!enforceUploadLimit(res, userId, guestSessionId, fileSize, fileName, 'resumable-init')) {
        return;
      }

      let uploadId = (payload.uploadId || '').trim();
      let meta: ResumableUploadMeta | null = null;

      if (uploadId) {
        meta = loadResumableMeta(uploadId);
        if (!meta || meta.ownerKey !== ownerKey || meta.fileSize !== fileSize || meta.fileName !== fileName) {
          uploadId = '';
          meta = null;
        }
      }

      if (!uploadId) {
        uploadId = createUploadId();
        meta = {
          uploadId,
          ownerKey,
          fileName,
          fileSize,
          mimeType,
          channelId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          status: 'uploading'
        };
        saveResumableMeta(meta);
      }

      const uploadedBytes = getUploadedBytes(uploadId);
      const completed = !!meta?.fileUrl || (meta?.status === 'completed' && typeof meta.fileUrl === 'string');

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        uploadId,
        uploadedBytes,
        completed,
        fileUrl: meta?.fileUrl || null,
        uploadToken: signUploadToken(uploadId, ownerKey)
      }));
    } catch (error) {
      console.error('Resumable upload init error:', error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Failed to initialize resumable upload' }));
    }
    return;
  }

  if (url.pathname === "/api/upload/resumable/status" && req.method === "GET") {
    const userId = getAuthenticatedUserId(req);
    const guestSessionId = getGuestSessionId(req);
    const ownerKey = getUploadOwnerKey(userId, guestSessionId);
    if (!ownerKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized - authentication required' }));
      return;
    }

    const uploadId = (url.searchParams.get('uploadId') || '').trim();
    if (!uploadId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'uploadId is required' }));
      return;
    }

    const meta = loadResumableMeta(uploadId);
    if (!meta || meta.ownerKey !== ownerKey) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Upload session not found' }));
      return;
    }
    const uploadToken = getUploadTokenFromRequest(req, url);
    if (!verifyUploadToken(uploadToken, uploadId, ownerKey)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Invalid or expired upload token' }));
      return;
    }

    const uploadedBytes = getUploadedBytes(uploadId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      uploadId,
      uploadedBytes,
      fileSize: meta.fileSize,
      completed: meta.status === 'completed',
      fileUrl: meta.fileUrl || null,
      uploadToken: signUploadToken(uploadId, ownerKey)
    }));
    return;
  }

  if (url.pathname === "/api/upload/resumable/chunk" && req.method === "PUT") {
    const userId = getAuthenticatedUserId(req);
    const guestSessionId = getGuestSessionId(req);
    const ownerKey = getUploadOwnerKey(userId, guestSessionId);
    if (!ownerKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized - authentication required' }));
      return;
    }

    const uploadId = (url.searchParams.get('uploadId') || '').trim();
    const offset = Number(url.searchParams.get('offset') || '0');
    if (!uploadId || !Number.isFinite(offset) || offset < 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Invalid uploadId or offset' }));
      return;
    }

    const meta = loadResumableMeta(uploadId);
    if (!meta || meta.ownerKey !== ownerKey) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Upload session not found' }));
      return;
    }
    const uploadToken = getUploadTokenFromRequest(req, url);
    if (!verifyUploadToken(uploadToken, uploadId, ownerKey)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Invalid or expired upload token' }));
      return;
    }
    if (meta.status === 'completed') {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Upload already completed', fileUrl: meta.fileUrl || null }));
      return;
    }
    if (!enforceUploadLimit(res, userId, guestSessionId, meta.fileSize, meta.fileName, 'resumable-chunk')) {
      return;
    }

    try {
      const chunk = await readRequestBuffer(req);
      if (!chunk.length) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Empty chunk' }));
        return;
      }

      const currentSize = getUploadedBytes(uploadId);
      if (offset > currentSize) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: false,
          error: 'Offset mismatch',
          expectedOffset: currentSize,
          uploadToken: signUploadToken(uploadId, ownerKey)
        }));
        return;
      }

      if (offset < currentSize) {
        const alreadyCovered = (offset + chunk.length) <= currentSize;
        if (alreadyCovered) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, uploadedBytes: currentSize, uploadToken: signUploadToken(uploadId, ownerKey) }));
          return;
        }
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: false,
          error: 'Overlapping chunk',
          expectedOffset: currentSize,
          uploadToken: signUploadToken(uploadId, ownerKey)
        }));
        return;
      }

      if ((currentSize + chunk.length) > meta.fileSize) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Chunk exceeds declared file size' }));
        return;
      }

      const partPath = getResumablePartPath(uploadId);
      const fd = openSync(partPath, 'a+');
      try {
        writeSync(fd, chunk, 0, chunk.length, offset);
      } finally {
        closeSync(fd);
      }

      meta.updatedAt = Date.now();
      saveResumableMeta(meta);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        uploadedBytes: currentSize + chunk.length,
        uploadToken: signUploadToken(uploadId, ownerKey)
      }));
    } catch (error) {
      console.error('Resumable upload chunk error:', error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Failed to upload chunk' }));
    }
    return;
  }

  if (url.pathname === "/api/upload/resumable/complete" && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    const guestSessionId = getGuestSessionId(req);
    const ownerKey = getUploadOwnerKey(userId, guestSessionId);
    if (!ownerKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized - authentication required' }));
      return;
    }

    try {
      const payload = JSON.parse((await readRequestBuffer(req)).toString() || '{}') as { uploadId?: string; uploadToken?: string };
      const uploadId = (payload.uploadId || '').trim();
      if (!uploadId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'uploadId is required' }));
        return;
      }

      const meta = loadResumableMeta(uploadId);
      if (!meta || meta.ownerKey !== ownerKey) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Upload session not found' }));
        return;
      }
      if (!verifyUploadToken((payload.uploadToken || '').trim(), uploadId, ownerKey)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Invalid or expired upload token' }));
        return;
      }

      if (meta.status === 'completed' && meta.fileUrl) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          fileUrl: meta.fileUrl,
          fileName: meta.fileName,
          fileSize: meta.fileSize
        }));
        return;
      }

      const uploadedBytes = getUploadedBytes(uploadId);
      if (uploadedBytes !== meta.fileSize) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: false,
          error: 'Upload incomplete',
          uploadedBytes,
          expectedBytes: meta.fileSize
        }));
        return;
      }

      const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${meta.fileName}`;
      const filePath = join(UPLOADS_DIR, fileId);
      const partPath = getResumablePartPath(uploadId);
      const finalPlain = readFileSync(partPath);
      writeUploadFile(filePath, finalPlain);
      unlinkSync(partPath);

      meta.status = 'completed';
      meta.fileUrl = `/uploads/${fileId}`;
      meta.updatedAt = Date.now();
      saveResumableMeta(meta);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        fileUrl: meta.fileUrl,
        fileName: meta.fileName,
        fileSize: meta.fileSize
      }));
    } catch (error) {
      console.error('Resumable upload complete error:', error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Failed to finalize upload' }));
    }
    return;
  }

  // File upload endpoint
  if (url.pathname === "/api/upload" && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    const guestSessionId = getGuestSessionId(req);
    const isGuestSessionValid = !!guestSessionId && sessions.has(guestSessionId);

    if (!userId && !isGuestSessionValid) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized - authentication required' }));
      return;
    }

    let body = '';
    let chunks: Buffer[] = [];

    req.on('data', (chunk) => {
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        const boundary = req.headers['content-type']?.split('boundary=')[1];

        if (!boundary) {
          // Handle JSON upload (base64)
          const data = JSON.parse(buffer.toString());
          const { fileName, fileData, channelId, userId, username } = data;

          // Save file
          const fileId = `${Date.now()}-${fileName}`;
          const filePath = join(UPLOADS_DIR, fileId);

          // Ensure uploads dir exists (may have been wiped by redeploy)
          if (!existsSync(UPLOADS_DIR)) {
            mkdirSync(UPLOADS_DIR, { recursive: true });
          }
          // Convert base64 to buffer and save
          const fileBuffer = Buffer.from(fileData.split(',')[1], 'base64');
          if (!enforceUploadLimit(res, userId, guestSessionId, fileBuffer.length, fileName, 'direct-upload')) {
            return;
          }
          writeUploadFile(filePath, fileBuffer);

          const fileUrl = `/uploads/${fileId}`;

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            success: true,
            fileUrl,
            fileName,
            fileSize: fileBuffer.length
          }));
        } else {
          // Handle multipart/form-data upload
          const parts = buffer.toString('binary').split(`--${boundary}`);
          let fileName = '';
          let fileData: Buffer | null = null;
          let channelId = '';
          let userId = '';
          let username = '';

          for (const part of parts) {
            if (part.includes('Content-Disposition')) {
              const nameMatch = part.match(/name="([^"]+)"/);
              const filenameMatch = part.match(/filename="([^"]+)"/);

              if (filenameMatch) {
                fileName = filenameMatch[1];
                const dataStart = part.indexOf('\r\n\r\n') + 4;
                const dataEnd = part.lastIndexOf('\r\n');
                fileData = Buffer.from(part.substring(dataStart, dataEnd), 'binary');
              } else if (nameMatch) {
                const fieldName = nameMatch[1];
                const dataStart = part.indexOf('\r\n\r\n') + 4;
                const dataEnd = part.lastIndexOf('\r\n');
                const value = part.substring(dataStart, dataEnd);

                if (fieldName === 'channelId') channelId = value;
                if (fieldName === 'userId') userId = value;
                if (fieldName === 'username') username = value;
              }
            }
          }

          if (fileData && fileName) {
            if (!enforceUploadLimit(res, userId, guestSessionId, fileData.length, fileName, 'direct-upload')) {
              return;
            }
            const fileId = `${Date.now()}-${fileName}`;
            const filePath = join(UPLOADS_DIR, fileId);
            // Ensure uploads dir exists (may have been wiped by redeploy)
            if (!existsSync(UPLOADS_DIR)) {
              mkdirSync(UPLOADS_DIR, { recursive: true });
            }
            writeUploadFile(filePath, fileData);

            const fileUrl = `/uploads/${fileId}`;

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              success: true,
              fileUrl,
              fileName,
              fileSize: fileData.length
            }));
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: 'No file uploaded' }));
          }
        }
      } catch (error) {
        console.error('Upload error:', error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Upload failed' }));
      }
    });

    return;
  }

  // Health check endpoint
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      users: users.size,
      uptime: process.uptime()
    }));
    return;
  }

  // CORS diagnostic endpoint
  if (url.pathname === "/health/cors") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      allowedOrigins: getAllowedOrigins(),
      nodeEnv: process.env.NODE_ENV,
      frontendUrl: process.env.FRONTEND_URL || '(not set)',
      publicUrl: process.env.PUBLIC_URL || '(not set)',
      allowedOriginsEnv: process.env.ALLOWED_ORIGINS || '(not set)',
      requestOrigin: req.headers.origin || '(none)',
      isAllowed: isOriginAllowed(req.headers.origin as string, getAllowedOrigins())
    }));
    return;
  }

  // Authentication endpoints
  if (url.pathname === "/api/auth/register" && req.method === "POST") {
    await handleRegister(req, res);
    return;
  }

  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    await handleLogin(req, res);
    return;
  }

  if (url.pathname === "/api/auth/upgrade" && req.method === "POST") {
    await handleUpgrade(req, res);
    return;
  }

  // User settings endpoints
  if (url.pathname === "/api/user/settings" && req.method === "GET") {
    await handleGetUserSettings(req, res);
    return;
  }

  if (url.pathname === "/api/user/settings" && req.method === "POST") {
    await handleSaveUserSettings(req, res);
    return;
  }

  // Encryption key endpoints
  const publicKeyMatch = url.pathname.match(/^\/api\/users\/(\d+)\/public-key$/);
  if (publicKeyMatch && req.method === "GET") {
    await handleGetPublicKey(req, res, parseInt(publicKeyMatch[1], 10));
    return;
  }

  if (url.pathname === "/api/user/encryption-keys" && req.method === "POST") {
    await handleStoreEncryptionKeys(req, res);
    return;
  }

  // Theme preferences endpoints
  if (url.pathname === "/api/user/theme" && req.method === "GET") {
    await handleGetThemePreferences(req, res);
    return;
  }

  if (url.pathname === "/api/user/theme" && req.method === "POST") {
    await handleSaveThemePreferences(req, res);
    return;
  }

  if (url.pathname === "/api/user/theme/reset" && req.method === "POST") {
    await handleResetThemePreferences(req, res);
    return;
  }

  // Relay network endpoints
  if (url.pathname === "/api/relays" && req.method === "GET") {
    await handleGetRelays(req, res);
    return;
  }

  if (url.pathname === "/api/relays/admin" && req.method === "GET") {
    await handleGetAllRelays(req, res);
    return;
  }

  if (url.pathname === "/api/relay/register" && req.method === "POST") {
    await handleRelayRegister(req, res);
    return;
  }

  if (url.pathname === "/api/relay/health" && req.method === "POST") {
    await handleRelayHealth(req, res);
    return;
  }

  if (url.pathname === "/api/relay/approve" && req.method === "POST") {
    await handleRelayApprove(req, res);
    return;
  }

  const relayDeleteMatch = url.pathname.match(/^\/api\/relay\/(\d+)$/);
  if (relayDeleteMatch && req.method === "DELETE") {
    await handleRelayDelete(req, res, parseInt(relayDeleteMatch[1], 10));
    return;
  }

  if (url.pathname === "/api/media/runtime" && req.method === "GET") {
    await handleGetMediaRuntime(req, res);
    return;
  }

  if (url.pathname === "/api/media/turn-credentials" && req.method === "GET") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Missing or invalid authorization' }));
      return;
    }

    await handleGetTurnCredentials(req, res, userId);
    return;
  }

  if (url.pathname === "/api/media/gateway-heartbeat" && req.method === "POST") {
    await handleMediaGatewayHeartbeat(req, res);
    return;
  }

  if (url.pathname === "/api/media/gateway/control/sessions" && req.method === "GET") {
    await handleGetMediaGatewayControlSessions(req, res);
    return;
  }

  if (url.pathname === "/api/media/gateway/session" && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Missing or invalid authorization' }));
      return;
    }
    await handleCreateMediaGatewaySession(req, res, userId);
    return;
  }

  if (url.pathname === "/api/media/gateway/sessions" && req.method === "GET") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Missing or invalid authorization' }));
      return;
    }
    await handleListMediaGatewaySessions(req, res, userId);
    return;
  }

  const mediaGatewaySessionMatch = url.pathname.match(/^\/api\/media\/gateway\/session\/([a-f0-9]{16,64})$/);
  if (mediaGatewaySessionMatch && req.method === "GET") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Missing or invalid authorization' }));
      return;
    }
    await handleGetMediaGatewaySession(req, res, userId, mediaGatewaySessionMatch[1]);
    return;
  }

  const mediaGatewaySessionCloseMatch = url.pathname.match(/^\/api\/media\/gateway\/session\/([a-f0-9]{16,64})\/close$/);
  if (mediaGatewaySessionCloseMatch && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Missing or invalid authorization' }));
      return;
    }
    await handleCloseMediaGatewaySession(req, res, userId, mediaGatewaySessionCloseMatch[1]);
    return;
  }

  if (url.pathname === "/api/webhooks" && req.method === "POST") {
    await handleCreateWebhook(req, res);
    return;
  }

  if (url.pathname === "/api/webhooks" && req.method === "GET") {
    await handleListWebhooks(req, res);
    return;
  }

  if (url.pathname === "/api/webhooks/deliveries" && req.method === "GET") {
    await handleListWebhookDeliveries(req, res);
    return;
  }

  const webhookDeleteMatch = url.pathname.match(/^\/api\/webhooks\/(\d+)$/);
  if (webhookDeleteMatch && req.method === "DELETE") {
    await handleDeleteWebhook(req, res, parseInt(webhookDeleteMatch[1], 10));
    return;
  }

  // Verify guest access code
  if (url.pathname === "/api/guest/verify-code" && req.method === "POST") {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const { code } = JSON.parse(body);

        if (!code || typeof code !== 'string') {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ valid: false, error: 'Code required' }));
          return;
        }

        const isValid = guestCodeRepository.isValidCode(code);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          valid: isValid,
          message: isValid ? 'Code verified' : 'Invalid code'
        }));
      } catch (error) {
        console.error('Guest code verification error:', error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ valid: false, error: 'Verification failed' }));
      }
    });
    return;
  }

  // Get list of registered users for task assignment
  if (url.pathname === "/api/users" && req.method === "GET") {
    try {
      const users = userRepository.getAll();
      const sanitized = users.map(u => ({
        user_id: u.user_id,
        username: u.username,
        profile_picture: u.profile_picture,
        color: u.color
      }));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(sanitized));
    } catch (error) {
      console.error('Failed to fetch users:', error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Failed to fetch users' }));
    }
    return;
  }

  // Toggle business private mode
  if (url.pathname === "/api/user/business-private-mode" && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const { privateMode } = JSON.parse(body);
        settingsRepository.set(userId, { business_private_mode: privateMode ? 1 : 0 });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, privateMode: privateMode }));
      } catch (error) {
        console.error('Failed to update private mode setting:', error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: 'Failed to update setting' }));
      }
    });
    return;
  }

  // Filter business data by visibility for a requesting user
  function filterForUser(data: BusinessData, requestingUserId: number | null): BusinessData {
    const canUserSeeItem = (item: any): boolean => {
      // Signed items are always considered shared.
      if (item?.signedBy) return true;

      const visibility = item?.visibility ?? 'public';
      if (visibility === 'public') return true;
      if (!requestingUserId) return false;

      // Private items are visible to their creator.
      const createdBy = item?.createdBy;
      if (createdBy === undefined || createdBy === null) return false;
      const createdByStr = String(createdBy);
      const requesterStr = String(requestingUserId);
      return createdByStr === requesterStr || createdByStr === `user-${requestingUserId}`;
    };

    return {
      ...data,
      todos: data.todos.filter(canUserSeeItem),
      projects: data.projects.filter(canUserSeeItem),
      sprints: data.sprints.filter(canUserSeeItem),
      calendarEvents: data.calendarEvents.filter(canUserSeeItem),
      diaryEntries: data.diaryEntries.filter(e => !e.isPrivate || (requestingUserId && e.createdBy === requestingUserId.toString()))
    };
  }

  // Business data sync endpoints
  // Get business data for a workspace
  if (url.pathname === "/api/business/get" && req.method === "GET") {
    try {
      // Default: shared workspace for collaboration
      let workspaceId = defaultWorkspaceId;

      // Check if user wants private workspace
      const userId = getAuthenticatedUserId(req);
      if (userId) {
        const userSettings = settingsRepository.get(userId);
        if (userSettings.business_private_mode === 1) {
          workspaceId = `user-${userId}`; // Private mode enabled
        }
      }

      let data = businessWorkspaces.get(workspaceId) || initializeWorkspace(workspaceId);

      // If user is in private mode, also merge signed items from shared workspace
      if (userId && workspaceId !== defaultWorkspaceId) {
        const sharedData = businessWorkspaces.get(defaultWorkspaceId);
        if (sharedData) {
          // Merge signed items from shared workspace (don't overwrite private workspace items with same id)
          const mergedData = { ...data };

          // Add shared signed items that aren't already in private workspace
          const privateIds = {
            todos: new Set(data.todos.map(t => t.id)),
            projects: new Set(data.projects.map(p => p.id)),
            sprints: new Set(data.sprints.map(s => s.id)),
            calendarEvents: new Set(data.calendarEvents.map(e => e.id))
          };

          mergedData.todos = [
            ...data.todos,
            ...sharedData.todos.filter(t => t.signedBy && !privateIds.todos.has(t.id))
          ];
          mergedData.projects = [
            ...data.projects,
            ...sharedData.projects.filter(p => p.signedBy && !privateIds.projects.has(p.id))
          ];
          mergedData.sprints = [
            ...data.sprints,
            ...sharedData.sprints.filter(s => s.signedBy && !privateIds.sprints.has(s.id))
          ];
          mergedData.calendarEvents = [
            ...data.calendarEvents,
            ...sharedData.calendarEvents.filter(e => e.signedBy && !privateIds.calendarEvents.has(e.id))
          ];

          data = mergedData;
        }
      }

      const filteredData = filterForUser(data, userId);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        data: filteredData
      }));
    } catch (error) {
      console.error('Get business data error:', error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Failed to load business data' }));
    }
    return;
  }

  // Save/sync business data for a workspace
  if (url.pathname === "/api/business/sync" && req.method === "POST") {
    // Default: shared workspace for collaboration
    let workspaceId = defaultWorkspaceId;

    // Check if user wants private workspace
    const userId = getAuthenticatedUserId(req);

    // Guest validation: check for verified guest code
    if (!userId) {
      // This is a guest - check for guest code header
      const guestCode = req.headers['x-guest-code'] as string;

      if (!guestCode || !guestCodeRepository.isValidCode(guestCode)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: false,
          error: 'Guest posting requires valid access code'
        }));
        return;
      }
    }

    if (userId) {
      const userSettings = settingsRepository.get(userId);
      if (userSettings.business_private_mode === 1) {
        workspaceId = `user-${userId}`; // Private mode enabled
      }
    }

    let body = '';

    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const { todos, calendarEvents, diaryEntries, projects, sprints, resources, tags, graphEdges } = JSON.parse(body);

        const businessData: BusinessData = {
          workspaceId,
          todos: todos || [],
          calendarEvents: calendarEvents || [],
          diaryEntries: diaryEntries || [],
          projects: projects || [],
          sprints: sprints || [],
          resources: resources || [],
          tags: tags || [],
          graphEdges: graphEdges || [],
          lastUpdated: Date.now()
        };

        businessWorkspaces.set(workspaceId, businessData);
        saveBusinessData(workspaceId, businessData);

        // If this is a private mode user, mirror signed items to the shared workspace
        if (userId && workspaceId !== defaultWorkspaceId) {
          const sharedData = businessWorkspaces.get(defaultWorkspaceId) || initializeWorkspace(defaultWorkspaceId);

          // Extract signed items from this user's data
          const signedTodos = todos?.filter((t: any) => t.signedBy) || [];
          const signedProjects = projects?.filter((p: any) => p.signedBy) || [];
          const signedSprints = sprints?.filter((s: any) => s.signedBy) || [];
          const signedCalendarEvents = calendarEvents?.filter((e: any) => e.signedBy) || [];

          // Merge signed items into shared workspace (upsert by id)
          for (const item of signedTodos) {
            const existingIdx = sharedData.todos.findIndex(t => t.id === item.id);
            if (existingIdx >= 0) {
              sharedData.todos[existingIdx] = item;
            } else {
              sharedData.todos.push(item);
            }
          }

          for (const item of signedProjects) {
            const existingIdx = sharedData.projects.findIndex(p => p.id === item.id);
            if (existingIdx >= 0) {
              sharedData.projects[existingIdx] = item;
            } else {
              sharedData.projects.push(item);
            }
          }

          for (const item of signedSprints) {
            const existingIdx = sharedData.sprints.findIndex(s => s.id === item.id);
            if (existingIdx >= 0) {
              sharedData.sprints[existingIdx] = item;
            } else {
              sharedData.sprints.push(item);
            }
          }

          for (const item of signedCalendarEvents) {
            const existingIdx = sharedData.calendarEvents.findIndex(e => e.id === item.id);
            if (existingIdx >= 0) {
              sharedData.calendarEvents[existingIdx] = item;
            } else {
              sharedData.calendarEvents.push(item);
            }
          }

          // Remove unsigned items that this user previously signed (only if they created them)
          const userIdStr = userId.toString();
          sharedData.todos = sharedData.todos.filter(t => !(t.createdBy === userIdStr && !t.signedBy));
          sharedData.projects = sharedData.projects.filter(p => !(p.createdBy === userIdStr && !p.signedBy));
          sharedData.sprints = sharedData.sprints.filter(s => !(s.createdBy === userIdStr && !s.signedBy));
          sharedData.calendarEvents = sharedData.calendarEvents.filter(e => !(e.createdBy === userIdStr && !e.signedBy));

          sharedData.lastUpdated = Date.now();
          businessWorkspaces.set(defaultWorkspaceId, sharedData);
          saveBusinessData(defaultWorkspaceId, sharedData);
        }

        // Broadcast update to all other connected users in this workspace
        // Only send workspaceId — clients call pullFromServer() to fetch their own data
        io.emit('business-data-updated', { workspaceId });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          lastUpdated: businessData.lastUpdated
        }));
      } catch (error) {
        console.error('Sync business data error:', error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Failed to sync business data' }));
      }
    });
    return;
  }

  // Resolve workspace ID for an authenticated user (private vs shared)
  function resolveWorkspaceId(userId: number): string {
    const userSettings = settingsRepository.get(userId);
    if (userSettings.business_private_mode === 1) {
      return `user-${userId}`;
    }
    return defaultWorkspaceId;
  }

  // Resource management endpoints
  // List all resources for a workspace
  if (url.pathname === "/api/business/resources" && req.method === "GET") {
    try {
      const userId = getAuthenticatedUserId(req);
      if (!userId) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: 'Missing or invalid authorization' }));
        return;
      }

      const workspaceId = resolveWorkspaceId(userId);
      const data = businessWorkspaces.get(workspaceId) || initializeWorkspace(workspaceId);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        resources: data.resources
      }));
    } catch (error) {
      console.error('Get resources error:', error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Failed to load resources' }));
    }
    return;
  }

  // Create a new resource
  if (url.pathname === "/api/business/resource/create" && req.method === "POST") {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const userId = getAuthenticatedUserId(req);
        if (!userId) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: 'Missing or invalid authorization' }));
          return;
        }

        const resourceData = JSON.parse(body);
        const workspaceId = resolveWorkspaceId(userId);
        const workspace = businessWorkspaces.get(workspaceId) || initializeWorkspace(workspaceId);

        const newResource = {
          id: `res-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          ...resourceData,
          createdBy: String(userId),
          createdAt: Date.now(),
          updatedAt: Date.now()
        };

        workspace.resources.push(newResource);
        businessWorkspaces.set(workspaceId, workspace);
        saveBusinessData(workspaceId, workspace);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          resource: newResource
        }));
      } catch (error) {
        console.error('Create resource error:', error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Failed to create resource' }));
      }
    });
    return;
  }

  // Update a resource
  if (url.pathname.startsWith("/api/business/resource/") && req.method === "PUT") {
    const resourceId = url.pathname.split("/").pop();
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const userId = getAuthenticatedUserId(req);
        if (!userId) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: 'Missing or invalid authorization' }));
          return;
        }

        const updates = JSON.parse(body);
        const workspaceId = resolveWorkspaceId(userId);
        const workspace = businessWorkspaces.get(workspaceId) || initializeWorkspace(workspaceId);

        const resourceIndex = workspace.resources.findIndex((r: any) => r.id === resourceId);
        if (resourceIndex === -1) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: 'Resource not found' }));
          return;
        }

        workspace.resources[resourceIndex] = {
          ...workspace.resources[resourceIndex],
          ...updates,
          updatedAt: Date.now()
        };

        businessWorkspaces.set(workspaceId, workspace);
        saveBusinessData(workspaceId, workspace);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          resource: workspace.resources[resourceIndex]
        }));
      } catch (error) {
        console.error('Update resource error:', error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Failed to update resource' }));
      }
    });
    return;
  }

  // Delete a resource
  if (url.pathname.startsWith("/api/business/resource/") && req.method === "DELETE") {
    const resourceId = url.pathname.split("/").pop();
    try {
      const userId = getAuthenticatedUserId(req);
      if (!userId) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: 'Missing or invalid authorization' }));
        return;
      }

      const workspaceId = resolveWorkspaceId(userId);
      const workspace = businessWorkspaces.get(workspaceId) || initializeWorkspace(workspaceId);

      workspace.resources = workspace.resources.filter((r: any) => r.id !== resourceId);
      businessWorkspaces.set(workspaceId, workspace);
      saveBusinessData(workspaceId, workspace);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } catch (error) {
      console.error('Delete resource error:', error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Failed to delete resource' }));
    }
    return;
  }

  // Emoji upload endpoint
  if (url.pathname === "/api/emoji/upload" && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized - authentication required' }));
      return;
    }

    let chunks: Buffer[] = [];

    req.on('data', (chunk) => {
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        const boundary = req.headers['content-type']?.split('boundary=')[1];

        if (!boundary) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: 'Invalid content type' }));
          return;
        }

        const parts = buffer.toString('binary').split(`--${boundary}`);
        let fileName = '';
        let fileData: Buffer | null = null;
        let emojiName = '';
        let displayName = '';
        let artist = '';
        let category = 'custom';
        let emojiType: 'emoji' | 'sticker' = 'emoji';

        for (const part of parts) {
          if (part.includes('Content-Disposition')) {
            const nameMatch = part.match(/name="([^"]+)"/);
            const filenameMatch = part.match(/filename="([^"]+)"/);

            if (filenameMatch) {
              fileName = filenameMatch[1];
              const dataStart = part.indexOf('\r\n\r\n') + 4;
              const dataEnd = part.lastIndexOf('\r\n');
              fileData = Buffer.from(part.substring(dataStart, dataEnd), 'binary');
            } else if (nameMatch) {
              const fieldName = nameMatch[1];
              const dataStart = part.indexOf('\r\n\r\n') + 4;
              const dataEnd = part.lastIndexOf('\r\n');
              const value = part.substring(dataStart, dataEnd);

              if (fieldName === 'name') emojiName = value;
              if (fieldName === 'displayName') displayName = value;
              if (fieldName === 'artist') artist = value;
              if (fieldName === 'category') category = value;
              if (fieldName === 'type' && (value === 'emoji' || value === 'sticker')) emojiType = value;
            }
          }
        }

        if (fileData && fileName && emojiName) {
          // Check if emoji name already exists
          const existing = getEmojiByName(emojiName);
          if (existing) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: 'Emoji name already exists' }));
            return;
          }

          // Save file
          const fileId = `emoji-${Date.now()}-${fileName}`;
          const filePath = join(UPLOADS_DIR, fileId);
          // Ensure uploads dir exists (may have been wiped by redeploy)
          if (!existsSync(UPLOADS_DIR)) {
            mkdirSync(UPLOADS_DIR, { recursive: true });
          }
          writeFileSync(filePath, fileData);

          // Use PUBLIC_URL if available, otherwise construct from request host
          const serverUrl = process.env.PUBLIC_URL || `http://${req.headers.host}`;
          const emojiUrl = `${serverUrl}/uploads/${fileId}`;

          // Add emoji to database
          const newEmoji: Emoji = {
            id: emojiName,
            name: emojiName,
            displayName: displayName.trim() || undefined,
            artist: artist.trim() || undefined,
            url: emojiUrl,
            category,
            isCustom: true,
            type: emojiType,
            source: 'custom'
          };

          addCustomEmoji(newEmoji);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            success: true,
            emoji: newEmoji
          }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: 'Missing required fields' }));
        }
      } catch (error) {
        console.error('Emoji upload error:', error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Upload failed' }));
      }
    });

    return;
  }

  // URL preview endpoint - fetch OpenGraph metadata for link previews
  if (url.pathname === "/api/url-preview" && req.method === "GET") {
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) {
      res.writeHead(400, { "Content-Type": "application/json", ...getCORSHeaders(req) });
      res.end(JSON.stringify({ error: 'Missing url parameter' }));
      return;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; WabiBot/1.0; +https://wabi.chat)',
          'Accept': 'text/html'
        },
        signal: controller.signal,
        redirect: 'follow'
      });
      clearTimeout(timeout);

      if (!response.ok) {
        res.writeHead(502, { "Content-Type": "application/json", ...getCORSHeaders(req) });
        res.end(JSON.stringify({ error: 'Failed to fetch URL' }));
        return;
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) {
        res.writeHead(400, { "Content-Type": "application/json", ...getCORSHeaders(req) });
        res.end(JSON.stringify({ error: 'URL is not an HTML page' }));
        return;
      }

      const html = await response.text();

      // Parse OpenGraph and meta tags with simple regex (no dependency needed)
      const decodeHtmlEntities = (str: string): string =>
        str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

      const getMeta = (property: string): string | null => {
        // Try og: property first, then name attribute
        const ogMatch = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i'))
          || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${property}["']`, 'i'));
        return ogMatch ? decodeHtmlEntities(ogMatch[1]) : null;
      };

      let title = getMeta('og:title') || getMeta('twitter:title')
        || (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]) || null;
      const description = getMeta('og:description') || getMeta('twitter:description')
        || getMeta('description') || null;
      const siteName = getMeta('og:site_name') || null;
      const type = getMeta('og:type') || null;

      // Video/player embed metadata
      const videoUrl = getMeta('og:video:secure_url') || getMeta('og:video:url') || getMeta('og:video') || null;
      const videoType = getMeta('og:video:type') || null;
      const videoWidth = getMeta('og:video:width') || getMeta('twitter:player:width') || null;
      let image = getMeta('og:image') || getMeta('twitter:image') || null;

      const videoHeight = getMeta('og:video:height') || getMeta('twitter:player:height') || null;
      const twitterCard = getMeta('twitter:card') || null;
      const twitterPlayer = getMeta('twitter:player') || null;

      // Extract YouTube video ID from URL
      let youtubeId: string | null = null;
      let channelName: string | null = null;
      try {
        const parsed = new URL(targetUrl);
        if (parsed.hostname.includes('youtube.com')) {
          youtubeId = parsed.searchParams.get('v') || null;
          // Handle /embed/VIDEO_ID and /shorts/VIDEO_ID
          if (!youtubeId) {
            const segments = parsed.pathname.split('/').filter(Boolean);
            if (segments.length >= 2 && (segments[0] === 'embed' || segments[0] === 'shorts')) {
              youtubeId = segments[1];
            }
          }
        } else if (parsed.hostname.includes('youtu.be')) {
          youtubeId = parsed.pathname.slice(1) || null;
        }
      } catch {}

      // For YouTube, use oEmbed API to get reliable title, channel name, and thumbnail
      if (youtubeId) {
        try {
          const oembedRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${youtubeId}&format=json`);
          if (oembedRes.ok) {
            const oembed = await oembedRes.json() as { title?: string; author_name?: string; thumbnail_url?: string };
            if (oembed.title) title = oembed.title;
            channelName = oembed.author_name || null;
            if (oembed.thumbnail_url && !image) image = oembed.thumbnail_url;
          }
        } catch {}
        // Guarantee a high-res thumbnail
        if (!image) {
          image = `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`;
        } else {
          // Upgrade to maxresdefault if using ytimg
          image = `https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg`;
        }
      }

      res.writeHead(200, { "Content-Type": "application/json", ...getCORSHeaders(req) });
      res.end(JSON.stringify({
        title, description, image, siteName, type, youtubeId, channelName,
        video: videoUrl ? { url: videoUrl, type: videoType, width: videoWidth, height: videoHeight } : null,
        twitterCard, twitterPlayer
      }));
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json", ...getCORSHeaders(req) });
      res.end(JSON.stringify({ error: 'Failed to fetch URL preview' }));
    }
    return;
  }

  // Image proxy endpoint - proxy images to avoid hotlink protection (Instagram, etc.)
  if (url.pathname === "/api/image-proxy" && req.method === "GET") {
    const imageUrl = url.searchParams.get('url');
    if (!imageUrl) {
      res.writeHead(400, { "Content-Type": "application/json", ...getCORSHeaders(req) });
      res.end(JSON.stringify({ error: 'Missing url parameter' }));
      return;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(imageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; WabiBot/1.0; +https://wabi.chat)',
          'Accept': 'image/*'
        },
        signal: controller.signal,
        redirect: 'follow'
      });
      clearTimeout(timeout);

      if (!response.ok) {
        res.writeHead(502, { "Content-Type": "application/json", ...getCORSHeaders(req) });
        res.end(JSON.stringify({ error: 'Failed to fetch image' }));
        return;
      }

      const contentType = response.headers.get('content-type') || 'image/jpeg';
      const buffer = Buffer.from(await response.arrayBuffer());

      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400",
        ...getCORSHeaders(req)
      });
      res.end(buffer);
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json", ...getCORSHeaders(req) });
      res.end(JSON.stringify({ error: 'Failed to proxy image' }));
    }
    return;
  }

  // Delete all messages endpoint
  if (url.pathname === "/api/clear-messages" && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized - authentication required' }));
      return;
    }

    try {
      // Clear all messages from all channels
      channelMessages.forEach((messages, channelId) => {
        channelMessages.set(channelId, []);
      });

      // Clear pinned messages
      pinnedMessages.forEach((pins, channelId) => {
        pinnedMessages.set(channelId, new Set());
      });

      // Delete all files from uploads directory
      if (existsSync(UPLOADS_DIR)) {
        const files = readdirSync(UPLOADS_DIR);
        let deletedCount = 0;
        for (const file of files) {
          try {
            const filePath = join(UPLOADS_DIR, file);
            const fileStats = statSync(filePath);
            if (fileStats.isFile()) {
              unlinkSync(filePath);
              deletedCount++;
            }
          } catch (err) {
            console.error(`Failed to delete file ${file}:`, err);
          }
        }
        if (ENABLE_LOGGING) console.log(`Deleted ${deletedCount} files from uploads directory`);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        message: "All messages and files cleared from server"
      }));
    } catch (error) {
      console.error('Clear messages error:', error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Failed to clear messages' }));
    }
    return;
  }

  // Serve uploaded files from dedicated uploads directory
  if (url.pathname.startsWith('/uploads/')) {
    const pathSegment = decodeURIComponent(url.pathname.replace('/uploads/', ''));

    // Security: Prevent path traversal attacks
    if (pathSegment.includes('..') || pathSegment.startsWith('/')) {
      res.writeHead(403);
      res.end("Access denied");
      return;
    }

    // Use basename to strip any remaining directory components
    const fileName = basename(pathSegment);
    const filePath = join(UPLOADS_DIR, fileName);

    if (existsSync(filePath)) {
      const stat = statSync(filePath);
      const ext = filePath.split('.').pop()?.toLowerCase();
      const contentTypes: Record<string, string> = {
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'gif': 'image/gif',
        'bmp': 'image/bmp',
        'webp': 'image/webp',
        'svg': 'image/svg+xml',
        'mp4': 'video/mp4',
        'webm': 'video/webm',
        'pdf': 'application/pdf',
        'zip': 'application/zip'
      };
      const contentType = contentTypes[ext || ''] || 'application/octet-stream';
      let encryptedAtRest = false;
      let decryptedBuffer: Buffer | null = null;
      let responseSize = stat.size;
      try {
        const head = readFileSync(filePath);
        if (head.slice(0, AT_REST_MAGIC.length).equals(AT_REST_MAGIC)) {
          encryptedAtRest = true;
          decryptedBuffer = maybeDecryptFromAtRest(head);
          responseSize = decryptedBuffer.length;
        }
      } catch (error) {
        console.error('Upload read/decrypt error:', error);
        res.writeHead(500);
        res.end("Failed to read upload");
        return;
      }

      const etag = `"${responseSize}-${Math.floor(stat.mtimeMs)}"`;

      const headers: Record<string, string | number> = {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'ETag': etag,
        'Last-Modified': stat.mtime.toUTCString(),
        'Accept-Ranges': encryptedAtRest ? 'none' : 'bytes',
        'X-Content-Type-Options': 'nosniff',
      };

      // Add CORS headers for relay cross-origin requests
      const originHeader = req.headers.origin;
      if (originHeader) {
        headers['Access-Control-Allow-Origin'] = originHeader;
        headers['Access-Control-Allow-Methods'] = 'GET, HEAD, OPTIONS';
      }

      // 304 Not Modified for conditional requests
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304);
        res.end();
        return;
      }

      // Range request support (video seeking, download resume)
      const rangeHeader = req.headers.range;
      if (rangeHeader && !encryptedAtRest) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (match) {
          const start = parseInt(match[1], 10);
          const end = match[2] ? parseInt(match[2], 10) : responseSize - 1;
          if (start >= responseSize || end >= responseSize || start > end) {
            res.writeHead(416, { 'Content-Range': `bytes */${responseSize}` });
            res.end();
            return;
          }
          headers['Content-Range'] = `bytes ${start}-${end}/${responseSize}`;
          headers['Content-Length'] = end - start + 1;
          res.writeHead(206, headers);
          createReadStream(filePath, { start, end }).pipe(res);
          return;
        }
      }

      // Full response
      headers['Content-Length'] = responseSize;
      res.writeHead(200, headers);
      if (encryptedAtRest && decryptedBuffer) {
        res.end(decryptedBuffer);
      } else {
        createReadStream(filePath).pipe(res);
      }
      return;
    } else {
      res.writeHead(404);
      res.end("Upload not found");
      return;
    }
  }

  // Serve static files in production
  if (existsSync(STATIC_DIR)) {
    // Decode the URL pathname to handle spaces and special characters
    const decodedPathname = decodeURIComponent(url.pathname);
    let filePath = join(STATIC_DIR, decodedPathname === "/" ? "index.html" : decodedPathname);

    // Check if the file exists (but not if it's a directory)
    if (existsSync(filePath)) {
      try {
        const stats = statSync(filePath);
        // Skip directories - they're not files to serve
        if (stats.isDirectory()) {
          // Try to serve index.html from that directory
          const indexPath = join(filePath, 'index.html');
          if (existsSync(indexPath)) {
            const file = readFileSync(indexPath);
            res.writeHead(200, { "Content-Type": 'text/html' });
            res.end(file);
            return;
          }
          // Directory exists but no index.html inside
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
      } catch (err) {
        // If stat fails, continue to 404
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const file = readFileSync(filePath);
      const ext = filePath.split('.').pop()?.toLowerCase();
      const contentTypes: Record<string, string> = {
        'html': 'text/html',
        'js': 'application/javascript',
        'css': 'text/css',
        'json': 'application/json',
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'gif': 'image/gif',
        'bmp': 'image/bmp',
        'webp': 'image/webp',
        'svg': 'image/svg+xml',
        'ico': 'image/x-icon',
        'mp4': 'video/mp4',
        'webm': 'video/webm',
        'pdf': 'application/pdf',
        'zip': 'application/zip'
      };

      res.writeHead(200, { "Content-Type": contentTypes[ext || 'html'] || 'application/octet-stream' });
      res.end(file);
      return;
    }

    // If file doesn't exist and it's not an API or upload request, serve index.html for client-side routing
    if (!url.pathname.startsWith('/api') && !url.pathname.startsWith('/uploads')) {
      const indexPath = join(STATIC_DIR, "index.html");
      if (existsSync(indexPath)) {
        const file = readFileSync(indexPath);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(file);
        return;
      }
    }
  }

  res.writeHead(404);
  res.end("Not Found");
});

// Initialize database
try {
  initializeDatabase();
  console.log('[Database] ✅ Initialized');

  // Migration: add avatar column to channels if missing
  try {
    db.prepare('ALTER TABLE channels ADD COLUMN avatar TEXT').run();
    console.log('[Database] Added avatar column to channels');
  } catch (_) {
    // Column already exists - ignore
  }

  // Ensure base channels exist in DB and load text/voice channels
  channelRepository.ensureBaseChannelsExist();
  const dbChannels = channelRepository.getWorkspaceChannels();
  dbChannels.forEach(ch => {
    channels.set(ch.channel_id, {
      id: ch.channel_id,
      name: ch.name,
      description: ch.description || '',
      minRole: ch.min_role || 'guest',
      createdAt: ch.created_at,
      type: normalizeChannelType(ch.channel_type),
      parentChannelId: ch.parent_channel_id || undefined,
      isBreakout: ch.is_breakout === 1,
      breakoutIndex: ch.breakout_index || undefined,
      parentMessageId: ch.parent_message_id || undefined,
      threadArchived: ch.thread_archived === 1,
      threadLocked: ch.thread_locked === 1,
      threadAutoArchiveMinutes: ch.thread_auto_archive_minutes || 1440,
      threadLastActivityAt: ch.thread_last_activity_at || ch.created_at,
      persistMessages: ch.persist_messages === 1,
      voiceSettings: parseVoiceSettings(ch.voice_settings_json)
    });
    if (!channelMessages.has(ch.channel_id)) {
      channelMessages.set(ch.channel_id, []);
    }
    if (!pinnedMessages.has(ch.channel_id)) {
      pinnedMessages.set(ch.channel_id, new Set());
    }
  });
  console.log(`[Database] ✅ Loaded ${dbChannels.length} channels from database`);
} catch (error) {
  console.error('[Database] ❌ Initialization failed:', error);
  process.exit(1);
}

// Start background job for expired offline message cleanup (hourly)
const cleanupInterval = setInterval(() => {
  const deleted = offlineMessageRepository.deleteExpired();
  if (deleted > 0) {
    console.log(`[Cleanup] 🗑️ Deleted ${deleted} expired offline messages`);
  }

  // Hard-purge soft-deleted messages older than 7 days to reclaim DB space
  const purged = messageRepository.purgeDeleted();
  if (purged > 0) {
    console.log(`[Cleanup] 🗑️ Purged ${purged} soft-deleted messages from DB`);
  }
}, 60 * 60 * 1000); // 1 hour

let shuttingDown = false;
const shutdown = (signal: 'SIGINT' | 'SIGTERM') => {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n[Server] ${signal} received. Shutting down...`);
  clearInterval(cleanupInterval);

  const forceExitTimer = setTimeout(() => {
    console.error('[Server] Forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();

  server.close(() => {
    try {
      closeDatabase();
      console.log('[Server] ✅ Shutdown complete');
      process.exit(0);
    } catch (error) {
      console.error('[Server] ❌ Shutdown failed:', error);
      process.exit(1);
    }
  });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Start HTTP server
server.listen(PORT, '0.0.0.0');
console.log('[Server] Listening on 0.0.0.0:' + PORT);

// Helper function to emit to channel members only
function emitToChannel(channelId: string, event: string, data: any) {
  const channel = channels.get(channelId);
  if (!channel) return;

  // For DMs and group chats, only emit to members
  if (channel.members && channel.members.length > 0) {
    channel.members.forEach(stableId => {
      // Resolve stable ID (e.g. "user-5") to current socket.id
      const socketId = resolveSocketId(stableId);
      if (socketId) {
        io.to(socketId).emit(event, data);
      }
    });
  } else {
    // For public channels, broadcast to everyone
    io.emit(event, data);
  }
}

// Define the deleteMessageById function now that emitToChannel is available
deleteMessageById = (channelId: string, messageId: string) => {
  const messages = channelMessages.get(channelId) || [];
  const messageIndex = messages.findIndex(m => m.id === messageId);

  if (messageIndex === -1) return;

  const message = messages[messageIndex];

  // Delete associated files from filesystem
  if (message.fileUrl) {
    const fileName = message.fileUrl.replace('/uploads/', '');
    const filePath = join(UPLOADS_DIR, fileName);
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    } catch (err) {
      console.error(`Failed to delete file: ${fileName}`, err);
    }
  }

  // Delete multiple files if present
  if (message.files && message.files.length > 0) {
    for (const file of message.files) {
      const fileName = file.fileUrl.replace('/uploads/', '');
      const filePath = join(UPLOADS_DIR, fileName);
      try {
        if (existsSync(filePath)) {
          unlinkSync(filePath);
        }
      } catch (err) {
        console.error(`Failed to delete file: ${fileName}`, err);
      }
    }
  }

  // Remove message
  messages.splice(messageIndex, 1);
  channelMessages.set(channelId, messages);

  // Soft-delete from database
  try { messageRepository.softDelete(messageId); } catch {}

  // Cancel timer if exists
  const timer = messageDeletionTimers.get(messageId);
  if (timer) {
    clearTimeout(timer);
    messageDeletionTimers.delete(messageId);
  }

  // Notify clients
  emitToChannel(channelId, "message-deleted", { channelId, messageId });

  // Note: We do NOT save to server disk anymore
  // Clients handle their own localStorage persistence

  if (ENABLE_LOGGING) {
    console.log(`🗑️ Auto-deleted message ${messageId} from channel ${channelId}`);
  }
};

// Initialize server: DO NOT load persisted messages from disk
// Messages are stored client-side in localStorage, not server-side
// restoreMessageDeletionTimers() is not needed since messages start fresh on server restart

// Helper function to load user's persisted DM/group channels from database
// and ensure they exist in the in-memory maps.
// stableUserId is either "user-{dbId}" for registered users or socket.id for guests.
function loadUserChannelsFromDB(stableUserId: string): Channel[] {
  try {
    // Get channels where user is a member from DB (using stable user_id)
    const userChannelRecords = channelMemberRepository.getUserChannels(stableUserId);

    for (const record of userChannelRecords) {
      const dbChannel = channelRepository.findById(record.channel_id);
      if (dbChannel && !channels.has(dbChannel.channel_id)) {
        // Get members for this channel (these are stable IDs)
        const memberIds = channelMemberRepository.getMemberIds(dbChannel.channel_id);

        // Add to in-memory channels
        channels.set(dbChannel.channel_id, {
          id: dbChannel.channel_id,
          name: dbChannel.name,
          description: dbChannel.description || '',
          minRole: dbChannel.min_role || 'guest',
          createdAt: dbChannel.created_at,
          type: normalizeChannelType(dbChannel.channel_type),
          members: memberIds,
          parentChannelId: dbChannel.parent_channel_id || undefined,
          isBreakout: dbChannel.is_breakout === 1,
          breakoutIndex: dbChannel.breakout_index || undefined,
          parentMessageId: dbChannel.parent_message_id || undefined,
          threadArchived: dbChannel.thread_archived === 1,
          threadLocked: dbChannel.thread_locked === 1,
          threadAutoArchiveMinutes: dbChannel.thread_auto_archive_minutes || 1440,
          threadLastActivityAt: dbChannel.thread_last_activity_at || dbChannel.created_at,
          persistMessages: dbChannel.persist_messages === 1,
          voiceSettings: parseVoiceSettings(dbChannel.voice_settings_json),
          recipientNotified: true // Already persisted, so both sides know
        });

        // Initialize message array and load message history if not exists
        if (!channelMessages.has(dbChannel.channel_id)) {
          try {
            // Load message history for this channel from database
            const dbMessages = messageRepository.getByChannel(dbChannel.channel_id, { limit: 50 });
            const clientMessages = dbMessages.map(msg => messageRepository.toClientFormat(msg));
            channelMessages.set(dbChannel.channel_id, clientMessages);

            if (ENABLE_LOGGING && dbMessages.length > 0) {
              console.log(`[loadUserChannelsFromDB] Loaded ${dbMessages.length} messages for channel ${dbChannel.channel_id}`);
            }
          } catch (error) {
            console.error(`[loadUserChannelsFromDB] Failed to load messages for ${dbChannel.channel_id}:`, error);
            channelMessages.set(dbChannel.channel_id, []); // Fallback to empty array
          }
        }
      }
    }
  } catch (error) {
    console.error('[loadUserChannelsFromDB] Error loading channels:', error);
  }

  // Return all channels the user has access to
  return Array.from(channels.values()).filter(channel => {
    // Public channels honor minimum role requirement
    if (!channel.members || channel.members.length === 0) {
      const requiredRole = channel.minRole || 'guest';
      if (requiredRole === 'guest') return true;
      const userRole = stableUserId.startsWith('user-')
        ? getUserRoleInfo(parseInt(stableUserId.substring(5), 10)).highestRole
        : 'guest';
      return getRolePriority(userRole) >= getRolePriority(requiredRole);
    }
    // Check if user's stable ID is in the members list
    return channel.members.includes(stableUserId);
  });
}

// Helper: enrich DM channels with otherUser info for a given user's stable ID
function enrichDMChannels(channelList: Channel[], myStableId: string): any[] {
  return channelList.map(channel => {
    if (channel.type === 'dm' && channel.members) {
      const otherStableId = channel.members.find(m => m !== myStableId);
      if (otherStableId) {
        // Try to find the other user online (by resolving stable ID to socket)
        const otherSocketId = resolveSocketId(otherStableId);
        const onlineUser = otherSocketId ? users.get(otherSocketId) : null;

        if (onlineUser) {
          return { ...channel, otherUser: {
            id: onlineUser.id,
            username: onlineUser.username,
            color: onlineUser.color,
            status: onlineUser.status,
            profilePicture: onlineUser.profilePicture,
            dbUserId: onlineUser.dbUserId
          }};
        }

        // Offline: resolve from DB if it's a registered user
        if (otherStableId.startsWith('user-')) {
          const dbId = parseInt(otherStableId.substring(5), 10);
          const dbUser = userRepository.findById(dbId);
          if (dbUser) {
            return { ...channel, otherUser: {
              id: otherStableId,
              username: dbUser.username,
              color: dbUser.color,
              status: 'offline' as const,
              profilePicture: dbUser.profile_picture,
              dbUserId: dbId
            }};
          }
        }

        // Fallback: use channel_members username
        const memberRecords = channelMemberRepository.getMembers(channel.id);
        const otherMember = memberRecords.find(m => m.user_id === otherStableId);
        if (otherMember) {
          return { ...channel, otherUser: {
            id: otherStableId,
            username: otherMember.username,
            color: '#888888',
            status: 'offline' as const,
            dbUserId: otherMember.registered_user_id
          }};
        }
      }
    }

    // Enrich group channels with member user objects
    if (channel.type === 'group' && channel.members) {
      const dbChannel = channelRepository.findById(channel.id);
      const memberUsers = channel.members.map(stableId => {
        const socketId = resolveSocketId(stableId);
        const onlineUser = socketId ? users.get(socketId) : null;
        if (onlineUser) {
          return { id: onlineUser.id, username: onlineUser.username, color: onlineUser.color, status: onlineUser.status, profilePicture: onlineUser.profilePicture, dbUserId: onlineUser.dbUserId };
        }
        if (stableId.startsWith('user-')) {
          const dbId = parseInt(stableId.substring(5), 10);
          const dbUser = userRepository.findById(dbId);
          if (dbUser) {
            return { id: stableId, username: dbUser.username, color: dbUser.color, status: 'offline' as const, profilePicture: dbUser.profile_picture, dbUserId: dbId };
          }
        }
        return null;
      }).filter(Boolean);

      return { ...channel, memberUsers, avatar: dbChannel?.avatar || null };
    }

    return channel;
  });
}

if (ENABLE_LOGGING) {
  console.log(`🚀 Community Chat server running on port ${PORT}`);
}

// Initialize plugin system
const pluginLoader = new PluginLoader(io, server as any, {
  channels,
  users,
  channelMessages,
  emitToChannel
});

// Load all plugins asynchronously
pluginLoader.loadAll().then(() => {
  console.log('🔌 Plugin system ready');
}).catch(error => {
  console.error('❌ Failed to load plugins:', error);
});

// Socket.IO middleware to validate sessions (temp and registered users)
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  const sessionId = socket.handshake.auth.sessionId;

  if (token) {
    // Registered user with JWT
    try {
      const payload = verifyToken(token);
      const dbSession = sessionRepository.findById(payload.sessionId);

      if (!dbSession || (dbSession.expires_at && dbSession.expires_at < Date.now())) {
        return next(new Error('Session expired'));
      }

      (socket as any).sessionId = payload.sessionId;
      (socket as any).userId = payload.userId;
      (socket as any).isRegistered = true;
      (socket as any).dbUserId = payload.userId;
      next();
    } catch (error) {
      return next(new Error('Invalid token'));
    }
  } else if (sessionId && sessions.has(sessionId)) {
    // Temp user with in-memory session
    (socket as any).sessionId = sessionId;
    (socket as any).userId = sessions.get(sessionId)?.userId;
    (socket as any).isRegistered = false;
    next();
  } else {
    // Allow new connection (will be assigned temp session on join)
    next();
  }
});

// Helper function to deliver offline messages to a user
async function deliverOfflineMessages(socket: any, dbUserId: number | null) {
  if (!dbUserId) return;

  try {
    const offlineMessages = offlineMessageRepository.getByRecipient(dbUserId);

    if (offlineMessages.length > 0) {
      // Group messages by channel
      const messagesByChannel: Record<string, any[]> = {};

      for (const msg of offlineMessages) {
        if (!messagesByChannel[msg.channel_id]) {
          messagesByChannel[msg.channel_id] = [];
        }

        messagesByChannel[msg.channel_id].push({
          id: `offline-${msg.message_id}`,
          user: msg.from_username,
          userId: msg.from_user_id || 'unknown',
          text: msg.message_content,
          timestamp: msg.created_at,
          type: msg.message_type,
          gifUrl: msg.gif_url,
          fileUrl: msg.file_url,
          fileName: msg.file_name,
          fileSize: msg.file_size
        });
      }

      // Emit offline messages for each channel
      for (const [channelId, messages] of Object.entries(messagesByChannel)) {
        socket.emit('offline-messages', {
          channelId,
          messages
        });
      }

      // Mark all as delivered
      const messageIds = offlineMessages.map((m) => m.message_id!);
      offlineMessageRepository.markDelivered(messageIds);

      console.log(`[Offline] 📬 Delivered ${offlineMessages.length} offline messages to user ${dbUserId}`);
    }
  } catch (error) {
    console.error('[Offline] Failed to deliver offline messages:', error);
  }
}

io.on("connection", (socket) => {
  console.log(`🔌 WebSocket connection established: ${socket.id}`);

  const getSocketStableId = (): string => getStableUserId(socket);
  const getSocketHighestRole = (): string => {
    const user = users.get(socket.id);
    return user?.highestRole || 'guest';
  };
  const socketMeetsRoleRequirement = (minRole?: string): boolean => {
    const requiredRole = minRole || 'guest';
    if (requiredRole === 'guest') return true;
    const myPriority = getRolePriority(getSocketHighestRole());
    const requiredPriority = getRolePriority(requiredRole);
    return myPriority >= requiredPriority;
  };

  const canManageVoiceBreakouts = (): boolean => {
    const highestRole = getSocketHighestRole();
    return ['owner', 'admin', 'mod'].includes(highestRole);
  };

  const canAccessChannel = (channel: Channel): boolean => {
    // Public channels are accessible based on minimum role gate
    if (!channel.members || channel.members.length === 0) {
      return socketMeetsRoleRequirement(channel.minRole);
    }
    // DM/group channels use stable IDs ("user-{dbId}" for registered users)
    return channel.members.includes(getSocketStableId());
  };

  const getAccessibleChannel = (channelId: string): Channel | null => {
    const channel = channels.get(channelId);
    if (!channel) {
      socket.emit("channel-error", `Channel ${channelId} does not exist`);
      return null;
    }
    if (!canAccessChannel(channel)) {
      socket.emit("channel-error", "Access denied to this channel");
      return null;
    }
    return channel;
  };

  const emitRoleDefinitions = (targetSocketId?: string) => {
    const payload = { roles: getRoleDefinitions('default-workspace') };
    if (targetSocketId) {
      io.to(targetSocketId).emit("role-definitions-updated", payload);
    } else {
      io.emit("role-definitions-updated", payload);
    }
  };

  const syncDbUserRoleState = (dbUserId: number) => {
    const newRoleInfo = getUserRoleInfo(dbUserId);
    for (const [sid, u] of users.entries()) {
      if (u.dbUserId === dbUserId) {
        u.roles = newRoleInfo.roles;
        u.highestRole = newRoleInfo.highestRole;
        u.roleColor = newRoleInfo.roleColor;
        users.set(sid, u);
        io.emit("user-role-changed", {
          userId: sid,
          dbUserId,
          roles: newRoleInfo.roles,
          highestRole: newRoleInfo.highestRole,
          roleColor: newRoleInfo.roleColor
        });
      }
    }
  };

  const getEmojiRoleRules = () => {
    return db.prepare(`
      SELECT id, channel_id, message_id, emoji_id, role_name, remove_on_unreact, enabled
      FROM emoji_role_rules
      WHERE workspace_id = ?
        AND channel_id IS NOT NULL AND channel_id != ''
        AND message_id IS NOT NULL AND message_id != ''
      ORDER BY id DESC
    `).all('default-workspace') as Array<{
      id: number;
      channel_id: string | null;
      message_id: string | null;
      emoji_id: string;
      role_name: string;
      remove_on_unreact: number;
      enabled: number;
    }>;
  };

  const emitEmojiRoleRules = (targetSocketId?: string) => {
    const rules = getEmojiRoleRules().map(rule => ({
      id: rule.id,
      channelId: rule.channel_id || '',
      messageId: rule.message_id || '',
      emojiId: rule.emoji_id,
      roleName: rule.role_name,
      removeOnUnreact: rule.remove_on_unreact === 1,
      enabled: rule.enabled === 1
    }));
    if (targetSocketId) {
      io.to(targetSocketId).emit("emoji-role-rules-updated", { rules });
    } else {
      io.emit("emoji-role-rules-updated", { rules });
    }
  };

  const applyEmojiRoleRules = (
    targetDbUserId: number | undefined,
    channelId: string,
    messageId: string,
    emojiId: string,
    removed: boolean
  ) => {
    if (!targetDbUserId) return;
    const channelMessagesList = channelMessages.get(channelId) || [];
    const targetMessage = channelMessagesList.find(msg => msg.id === messageId);
    if (!targetMessage || targetMessage.type !== 'role_gate') return;

    const rules = db.prepare(`
      SELECT role_name, remove_on_unreact
      FROM emoji_role_rules
      WHERE workspace_id = ? AND enabled = 1 AND channel_id = ? AND message_id = ? AND emoji_id = ?
    `).all('default-workspace', channelId, messageId, emojiId) as Array<{ role_name: string; remove_on_unreact: number }>;

    if (rules.length === 0) return;

    for (const rule of rules) {
      if (rule.role_name === 'owner') continue;
      if (removed) {
        if (rule.remove_on_unreact === 1) {
          removeRole(targetDbUserId, rule.role_name as any, 'default-workspace');
        }
      } else {
        assignRole(targetDbUserId, rule.role_name as any, 'default-workspace');
      }
    }

    syncDbUserRoleState(targetDbUserId);
  };

  // Handle user join
  socket.on("join", async (username: string) => {
    // Check if this is a registered user (authenticated via JWT in middleware)
    if ((socket as any).isRegistered && (socket as any).sessionId) {
      // Registered user - use their DB session instead of creating a temp session
      const dbSession = sessionRepository.findById((socket as any).sessionId);

      if (dbSession) {
        // Use the registered user's data from the database
        const registeredUsername = dbSession.username;
        const registeredColor = dbSession.color || `#${Math.floor(Math.random()*16777215).toString(16)}`;
        const registeredProfilePic = dbSession.profile_picture;

        // Get username font from user database
        let usernameFont = undefined;
        if (dbSession.user_id) {
          const userRecord = userRepository.findById(dbSession.user_id);
          if (userRecord) {
            usernameFont = {
              family: userRecord.username_font_family,
              size: userRecord.username_font_size,
              weight: userRecord.username_font_weight,
              style: userRecord.username_font_style
            };
          }
        }

        // Get handle and role info
        const userRecord = dbSession.user_id ? userRepository.findById(dbSession.user_id) : null;
        const registeredHandle = userRecord?.handle;
        const roleInfo = getUserRoleInfo((socket as any).dbUserId);

        users.set(socket.id, {
          id: socket.id,
          username: registeredUsername,
          handle: registeredHandle,
          color: registeredColor,
          status: 'active',
          profilePicture: registeredProfilePic,
          dbUserId: (socket as any).dbUserId,
          roles: roleInfo.roles,
          highestRole: roleInfo.highestRole,
          roleColor: roleInfo.roleColor,
          usernameFont
        });

        // Update reverse mapping for registered users
        if ((socket as any).dbUserId) {
          dbUserIdToSocketId.set((socket as any).dbUserId, socket.id);
        }

        // Load user's persisted DM/group channels from database using stable ID
        const stableId = getStableUserId(socket);
        const userChannels = loadUserChannelsFromDB(stableId);
        const enrichedChannels = enrichDMChannels(userChannels, stableId);

        const emojisData = getAllEmojis();
        socket.emit("init", {
          channels: enrichedChannels,
          users: Array.from(users.values()),
          voiceState: getVoiceStatePayload(),
          excalidrawState,
          emotes: Array.from(emotes.values()),
          emojis: emojisData,
          roleDefinitions: getRoleDefinitions('default-workspace'),
          sessionId: (socket as any).sessionId
        });

        // Deliver offline messages for registered user
        await deliverOfflineMessages(socket, (socket as any).dbUserId);

        socket.broadcast.emit("user-joined", {
          id: socket.id,
          username: registeredUsername,
          handle: registeredHandle,
          color: registeredColor,
          status: 'active',
          profilePicture: registeredProfilePic,
          dbUserId: (socket as any).dbUserId,
          roles: roleInfo.roles,
          highestRole: roleInfo.highestRole,
          roleColor: roleInfo.roleColor,
          usernameFont
        });

        const joinedUser = users.get(socket.id);
        if (joinedUser) {
          pluginLoader.triggerOnUserJoin(joinedUser).catch((error) => {
            console.error('[Plugins] Failed to trigger onUserJoin hook:', error);
          });
          dispatchWebhookEvent('user.joined', {
            id: joinedUser.id,
            username: joinedUser.username,
            dbUserId: joinedUser.dbUserId || null
          }).catch((error) => {
            console.error('[Webhooks] Failed to dispatch user.joined:', error);
          });
        }

        if (ENABLE_LOGGING) console.log(`${registeredUsername} joined as registered user`);
        return; // Exit early - don't create temp session
      }
    }

    // Guest/temp user flow - check if a session for this username already exists
    let existingSession: { sessionId: string; session: { userId: string; username: string; color: string; profilePicture?: string; createdAt: number } } | null = null;
    for (const [sessionId, session] of sessions.entries()) {
      if (session.username === username) {
        existingSession = { sessionId, session };
        break;
      }
    }

    if (existingSession) {
      // If session exists, treat as a rejoin
      const { sessionId, session } = existingSession;
      session.userId = socket.id; // Update session with new socket.id
      sessions.set(sessionId, session);

      // Create/update user object with existing session data
      users.set(socket.id, {
        id: socket.id,
        username: session.username,
        color: session.color,
        status: 'active',
        profilePicture: session.profilePicture
      });

      // Guest users use socket.id as their stable ID (ephemeral, expected)
      const guestChannels = loadUserChannelsFromDB(socket.id);

      const emojisData = getAllEmojis();
      socket.emit("init", {
        channels: guestChannels,
        users: Array.from(users.values()),
        voiceState: getVoiceStatePayload(),
        excalidrawState,
        emotes: Array.from(emotes.values()),
        emojis: emojisData,
        roleDefinitions: getRoleDefinitions('default-workspace'),
        sessionId: sessionId
      });

      socket.broadcast.emit("user-joined", {
        id: socket.id,
        username: session.username,
        color: session.color,
        status: 'active',
        profilePicture: session.profilePicture
      });

      if (ENABLE_LOGGING) console.log(`${session.username} re-joined the chat with a new socket`);
      const rejoinedUser = users.get(socket.id);
      if (rejoinedUser) {
        pluginLoader.triggerOnUserJoin(rejoinedUser).catch((error) => console.error('[Plugins] Failed to trigger onUserJoin hook:', error));
        dispatchWebhookEvent('user.joined', { id: rejoinedUser.id, username: rejoinedUser.username, dbUserId: rejoinedUser.dbUserId || null }).catch((error) => console.error('[Webhooks] Failed to dispatch user.joined:', error));
      }
    } else {
      // No session exists, create a new one (guest user)
      const color = `#${Math.floor(Math.random()*16777215).toString(16)}`;
      const sessionId = generateSessionId();
      sessions.set(sessionId, {
        userId: socket.id,
        username,
        color,
        createdAt: Date.now()
      });

      users.set(socket.id, {
        id: socket.id,
        username,
        color,
        status: 'active',
        profilePicture: undefined
      });

      // Guest users use socket.id as their stable ID (ephemeral, expected)
      const newGuestChannels = loadUserChannelsFromDB(socket.id);

      const emojisData2 = getAllEmojis();
      socket.emit("init", {
        channels: newGuestChannels,
        users: Array.from(users.values()),
        voiceState: getVoiceStatePayload(),
        excalidrawState,
        emotes: Array.from(emotes.values()),
        emojis: emojisData2,
        roleDefinitions: getRoleDefinitions('default-workspace'),
        sessionId: sessionId
      });

      socket.broadcast.emit("user-joined", {
        id: socket.id,
        username,
        color,
        status: 'active',
        profilePicture: undefined
      });

      const newUser = users.get(socket.id);
      if (newUser) {
        pluginLoader.triggerOnUserJoin(newUser).catch((error) => console.error('[Plugins] Failed to trigger onUserJoin hook:', error));
        dispatchWebhookEvent('user.joined', { id: newUser.id, username: newUser.username, dbUserId: newUser.dbUserId || null }).catch((error) => console.error('[Webhooks] Failed to dispatch user.joined:', error));
      }

      if (ENABLE_LOGGING) console.log(`${username} joined the chat as guest`);
    }
  });

  // Handle user rejoin with existing session (for persistence across reloads)
  socket.on("rejoin", (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) {
      socket.emit("rejoin-failed", { reason: "Invalid session" });
      return;
    }

    // IMPORTANT: Update the session with the new socket.id
    session.userId = socket.id;
    sessions.set(sessionId, session);

    // Load usernameFont, handle, and role info for registered users from the database
    let usernameFont = session.usernameFont;
    let rejoinHandle: string | undefined;
    let rejoinRoleInfo: { roles: string[]; highestRole: string | undefined; roleColor: string | null | undefined } = { roles: [], highestRole: undefined, roleColor: undefined };
    if ((socket as any).isRegistered && (socket as any).sessionId) {
      const dbSession = sessionRepository.findById((socket as any).sessionId);
      if (dbSession?.user_id) {
        const userRecord = userRepository.findById(dbSession.user_id);
        if (userRecord) {
          usernameFont = {
            family: userRecord.username_font_family,
            size: userRecord.username_font_size,
            weight: userRecord.username_font_weight,
            style: userRecord.username_font_style
          };
          rejoinHandle = userRecord.handle;
        }
      }
    }
    const rejoinDbUserId = (socket as any).isRegistered ? (socket as any).dbUserId : undefined;
    if (rejoinDbUserId) {
      rejoinRoleInfo = getUserRoleInfo(rejoinDbUserId);
    }

    // Create/update user object with existing session data
    users.set(socket.id, {
      id: socket.id,
      username: session.username,
      handle: rejoinHandle,
      color: session.color,
      status: 'active',
      profilePicture: session.profilePicture,
      dbUserId: rejoinDbUserId,
      roles: rejoinRoleInfo.roles,
      highestRole: rejoinRoleInfo.highestRole,
      roleColor: rejoinRoleInfo.roleColor,
      usernameFont
    });

    // Update reverse mapping for registered users
    if (rejoinDbUserId) {
      dbUserIdToSocketId.set(rejoinDbUserId, socket.id);
    }

    // Load user's persisted DM/group channels from database using stable ID
    const rejoinStableId = getStableUserId(socket);
    const rejoinChannels = loadUserChannelsFromDB(rejoinStableId);
    const enrichedRejoinChannels = enrichDMChannels(rejoinChannels, rejoinStableId);

    const emojisData = getAllEmojis();
    socket.emit("init", {
      channels: enrichedRejoinChannels,
      users: Array.from(users.values()),
      voiceState: getVoiceStatePayload(),
      excalidrawState,
      emotes: Array.from(emotes.values()),
      emojis: emojisData,
      roleDefinitions: getRoleDefinitions('default-workspace'),
      sessionId: sessionId
    });

    // Deliver offline messages for registered user on rejoin
    if (rejoinDbUserId) {
      deliverOfflineMessages(socket, rejoinDbUserId);
    }

    // Broadcast user rejoin
    const rejoinUser = users.get(socket.id);
    socket.broadcast.emit("user-joined", {
      id: socket.id,
      username: session.username,
      handle: rejoinUser?.handle,
      color: rejoinUser?.color,
      status: 'active',
      profilePicture: rejoinUser?.profilePicture,
      dbUserId: rejoinDbUserId,
      roles: rejoinUser?.roles,
      highestRole: rejoinUser?.highestRole,
      roleColor: rejoinUser?.roleColor,
      usernameFont: rejoinUser?.usernameFont
    });

    if (rejoinUser) {
      pluginLoader.triggerOnUserJoin(rejoinUser).catch((error) => console.error('[Plugins] Failed to trigger onUserJoin hook:', error));
      dispatchWebhookEvent('user.joined', { id: rejoinUser.id, username: rejoinUser.username, dbUserId: rejoinUser.dbUserId || null }).catch((error) => console.error('[Webhooks] Failed to dispatch user.joined:', error));
    }

    if (ENABLE_LOGGING) console.log(`${session.username} rejoined the chat`);
  });

  // Handle profile updates
  socket.on("update-profile", (data: { status?: 'active' | 'away' | 'busy'; profilePicture?: string; username?: string; usernameFont?: { family?: string; size?: string; weight?: string; style?: string } }, callback?: (response: { success: boolean; error?: string }) => void) => {
    const user = users.get(socket.id);
    if (!user) {
      if (callback) callback({ success: false, error: 'User not found' });
      return;
    }

    if (data.username !== undefined) {
      const nextUsername = data.username.trim();
      if (nextUsername.length < 2 || nextUsername.length > 32) {
        if (callback) callback({ success: false, error: 'Display name must be 2-32 characters' });
        return;
      }

      const duplicateOnline = Array.from(users.entries()).find(([id, existing]) =>
        id !== socket.id && existing.username.toLowerCase() === nextUsername.toLowerCase()
      );
      if (duplicateOnline) {
        if (callback) callback({ success: false, error: 'That display name is already in use' });
        return;
      }

      const existingRegistered = userRepository.findByUsername(nextUsername);
      if (existingRegistered && existingRegistered.user_id !== user.dbUserId) {
        if (callback) callback({ success: false, error: 'That display name is already registered' });
        return;
      }

      user.username = nextUsername;
    }

    if (data.status) {
      user.status = data.status;
    }
    if (data.profilePicture !== undefined) {
      user.profilePicture = data.profilePicture;
    }
    if (data.usernameFont !== undefined) {
      user.usernameFont = data.usernameFont;
    }

    users.set(socket.id, user);

    // For registered users, update the database session and user profile
    if ((socket as any).isRegistered && (socket as any).sessionId) {
      try {
        const dbSession = sessionRepository.findById((socket as any).sessionId);
        if (dbSession) {
          // Update session with new profile picture
          sessionRepository.update((socket as any).sessionId, {
            username: user.username,
            profile_picture: user.profilePicture || null
          });

          // Also update the user's main profile
          if (dbSession.user_id) {
            const userUpdateData: any = {
              username: user.username,
              profile_picture: user.profilePicture || null
            };
            if (user.usernameFont) {
              userUpdateData.username_font_family = user.usernameFont.family;
              userUpdateData.username_font_size = user.usernameFont.size;
              userUpdateData.username_font_weight = user.usernameFont.weight;
              userUpdateData.username_font_style = user.usernameFont.style;
            }
            userRepository.update(dbSession.user_id, userUpdateData);
          }

          if (ENABLE_LOGGING) console.log(`[DB] Updated profile for ${user.username}`);
        }
      } catch (error) {
        console.error('[Error] Failed to update profile picture in database:', error);
        if (callback) callback({ success: false, error: 'Database update failed' });
        return;
      }
    }

    // For temp users, update in-memory session
    const sessions_array = Array.from(sessions.entries());
    for (const [sessionId, session] of sessions_array) {
      if (session.userId === socket.id) {
        session.username = user.username;
        session.profilePicture = user.profilePicture;
        session.usernameFont = user.usernameFont;
        sessions.set(sessionId, session);
        break; // Assuming one session per socket.id
      }
    }

    // Broadcast profile update to all users
    io.emit("profile-updated", {
      id: socket.id,
      username: user.username,
      color: user.color,
      status: user.status,
      profilePicture: user.profilePicture,
      dbUserId: user.dbUserId,
      usernameFont: user.usernameFont
    });

    if (ENABLE_LOGGING) console.log(`${user.username} updated profile: status=${user.status}`);
    if (callback) callback({ success: true });
  });

  // Handle joining a channel
  socket.on("join-channel", (channelId: string) => {
    const channel = getAccessibleChannel(channelId);
    if (!channel) {
      console.error(`[join-channel] Access denied or missing channel ${channelId} for user ${socket.id}`);
      return;
    }

    // Track which channel the user is in
    userCurrentChannel.set(socket.id, channelId);

    // Serve from DB (authoritative) instead of volatile in-memory Map
    try {
      const dbMessages = messageRepository.getByChannel(channelId, { limit: 50 });
      const clientMessages = dbMessages.map(m => messageRepository.toClientFormat(m));
      const totalCount = messageRepository.getChannelMessageCount(channelId);
      socket.emit("channel-messages", {
        channelId,
        messages: clientMessages,
        hasMore: totalCount > 50
      });
    } catch (err) {
      // Fallback to in-memory on DB error
      console.error(`[join-channel] DB query failed for ${channelId}:`, err);
      const messages = channelMessages.get(channelId) || [];
      socket.emit("channel-messages", { channelId, messages, hasMore: false });
    }

    if (ENABLE_LOGGING) console.log(`User ${socket.id} joined channel ${channelId}`);
  });

  // Handle history loading with pagination
  socket.on("load-history", (data: {
    channelId: string;
    beforeMessageId?: string;
    afterMessageId?: string;
    limit?: number;
  }) => {
    const channel = channels.get(data.channelId);
    if (!channel) {
      socket.emit("history-loaded", {
        channelId: data.channelId,
        messages: [],
        hasMore: false,
        direction: data.beforeMessageId ? 'older' : 'initial'
      });
      return;
    }

    if (!canAccessChannel(channel)) {
      socket.emit("channel-error", "Access denied to this channel");
      return;
    }

    try {
      const limit = data.limit || 50;
      const dbMessages = messageRepository.getByChannel(data.channelId, {
        limit,
        beforeMessageId: data.beforeMessageId,
        afterMessageId: data.afterMessageId
      });

      const clientMessages = dbMessages.map(m => messageRepository.toClientFormat(m));

      socket.emit("history-loaded", {
        channelId: data.channelId,
        messages: clientMessages,
        hasMore: dbMessages.length === limit,
        direction: data.beforeMessageId ? 'older' : data.afterMessageId ? 'newer' : 'initial'
      });

      if (ENABLE_LOGGING) {
        console.log(`[load-history] Loaded ${clientMessages.length} messages for ${data.channelId}`);
      }
    } catch (error) {
      console.error('[load-history] Failed to load history:', error);
      socket.emit("history-loaded", {
        channelId: data.channelId,
        messages: [],
        hasMore: false,
        direction: data.beforeMessageId ? 'older' : 'initial'
      });
    }
  });

  // Handle chat messages
  socket.on("message", (data: {
    text: string;
    type: 'text' | 'gif' | 'file' | 'emoji' | 'role_gate';
    channelId: string;
    gifUrl?: string;
    emojiUrl?: string;
    emojiName?: string;
    fileUrl?: string;
    fileName?: string;
    fileSize?: number;
    files?: { fileUrl: string; fileName: string; fileSize: number; attachmentEncryption?: AttachmentEncryptionMeta }[];
    attachmentEncryption?: AttachmentEncryptionMeta;
    replyTo?: string;
    isSpoiler?: boolean;
    encrypted?: boolean;
    iv?: string;
    roleGatePersist?: boolean;
  }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const channel = getAccessibleChannel(data.channelId);
    if (!channel) return;

    const normalizedText = typeof data.text === 'string' ? data.text.trim().toLowerCase() : '';
    const isRoleCheatcodeMessage =
      data.type === 'text' &&
      TEST_ROLE_CHEATCODE_ENABLED &&
      !testRoleCheatcodeConsumed &&
      normalizedText.length > 0 &&
      normalizedText === TEST_ROLE_CHEATCODE_PHRASE;

    if (isRoleCheatcodeMessage) {
      if (workspaceHasOwner()) {
        testRoleCheatcodeConsumed = true;
        socket.emit("channel-error", "Testing role cheatcode is disabled because an owner already exists.");
        return;
      }

      if (!user.dbUserId) {
        socket.emit("channel-error", "Testing role cheatcode only works for registered users.");
        return;
      }

      try {
        assignRole(user.dbUserId, TEST_ROLE_CHEATCODE_ROLE as any, 'default-workspace');
        syncDbUserRoleState(user.dbUserId);
        testRoleCheatcodeConsumed = true;
        socket.emit("channel-error", `[TEST] Role granted: ${TEST_ROLE_CHEATCODE_ROLE}. Cheatcode is now disabled.`);
        console.log(`[RoleCheatcode] Granted ${TEST_ROLE_CHEATCODE_ROLE} to user_id ${user.dbUserId}; cheatcode disabled.`);
      } catch (error) {
        socket.emit("channel-error", "Failed to apply testing role cheatcode.");
      }
      return;
    }

    if (data.type === 'role_gate') {
      if (!user.dbUserId) {
        socket.emit("channel-error", "Only registered admins can create role-gate posts");
        return;
      }
      const myRoleInfo = getUserRoleInfo(user.dbUserId);
      if (!['owner', 'admin'].includes(myRoleInfo.highestRole)) {
        socket.emit("channel-error", "Only owner/admin can create role-gate posts");
        return;
      }
      if (!data.text || !data.text.trim()) {
        socket.emit("channel-error", "Role-gate post content cannot be empty");
        return;
      }
    }

    // Calculate deletion time: use channel auto-delete setting, or default to 1 day
    const DEFAULT_SERVER_EXPIRATION = 24 * 60 * 60 * 1000; // 1 day in milliseconds
    const deletionTime = channel.autoDeleteAfter
      ? Date.now() + getAutoDeleteMs(channel.autoDeleteAfter)
      : Date.now() + DEFAULT_SERVER_EXPIRATION;

    // Use stable user ID for message identity
    const senderStableId = getStableUserId(socket);

    // Build minimal message object with only present fields
    const message: any = {
      id: `${Date.now()}-${senderStableId}`,
      user: user.username,
      userId: socket.id, // Current socket.id for realtime identification
      text: data.text,
      timestamp: Date.now(),
      type: data.type,
      scheduledDeletionTime: deletionTime
    };

    // Only add optional fields if they exist (reduces payload size by 30-40%)
    if (data.gifUrl) message.gifUrl = data.gifUrl;
    if (data.emojiUrl) message.emojiUrl = data.emojiUrl;
    if (data.emojiName) message.emojiName = data.emojiName;
    if (data.fileUrl) message.fileUrl = data.fileUrl;
    if (data.fileName) message.fileName = data.fileName;
    if (data.fileSize) message.fileSize = data.fileSize;
    if (data.files) message.files = data.files;
    if (data.attachmentEncryption) message.attachmentEncryption = data.attachmentEncryption;
    if (data.replyTo) message.replyTo = data.replyTo;
    if (data.isSpoiler) message.isSpoiler = data.isSpoiler;
    if (data.encrypted) message.encrypted = true;
    if (data.iv) message.iv = data.iv;

    // Add message to channel
    const messages = channelMessages.get(data.channelId) || [];
    messages.push(message);
    channelMessages.set(data.channelId, messages);

    // Notify DM recipient on first message (lazy channel delivery)
    if (channel.type === 'dm' && !channel.recipientNotified && channel.members) {
      const myStableId = getStableUserId(socket);
      const recipientStableId = channel.members.find(m => m !== myStableId);
      if (recipientStableId) {
        const recipientSocketId = resolveSocketId(recipientStableId);
        if (recipientSocketId) {
          io.to(recipientSocketId).emit("dm-channel-added", {
            channelId: data.channelId,
            otherUser: {
              id: user.id,
              username: user.username,
              color: user.color,
              status: user.status,
              profilePicture: user.profilePicture,
              dbUserId: user.dbUserId
            }
          });
        }
        channel.recipientNotified = true;
      }
    }

    emitToChannel(data.channelId, "message", { channelId: data.channelId, message });

    // Schedule auto-deletion for ALL messages (either custom time or default 1-day)
    const deletionDuration = channel.autoDeleteAfter || '24h';
    scheduleMessageDeletion(data.channelId, message.id, deletionDuration);

    const shouldPersistMessage = !(data.type === 'role_gate' && data.roleGatePersist === false);
    if (shouldPersistMessage) {
      // Persist message to database with stable sender ID
      try {
        messageRepository.create({
          message_id: message.id,
          channel_id: data.channelId,
          sender_id: senderStableId,
          sender_username: user.username,
          sender_color: user.color,
          message_type: data.type,
          content: data.text,
          gif_url: data.gifUrl,
        file_url: data.fileUrl,
        file_name: data.fileName,
        file_size: data.fileSize,
        files_json: data.files ? JSON.stringify(data.files) : undefined,
        attachment_encryption_json: data.attachmentEncryption ? JSON.stringify(data.attachmentEncryption) : undefined,
        reply_to_id: data.replyTo,
          is_spoiler: data.isSpoiler ? 1 : 0,
          is_pinned: 0,
          is_edited: 0,
          is_encrypted: data.encrypted ? 1 : 0,
          encryption_iv: data.iv || undefined,
          created_at: message.timestamp
        });
      } catch (dbError) {
        console.error('[MessageRepository] Failed to persist message:', dbError);
      }
    }

    pluginLoader.triggerOnMessage(data.channelId, message).catch((error) => {
      console.error('[Plugins] Failed to trigger onMessage hook:', error);
    });
    dispatchWebhookEvent('message.created', {
      channelId: data.channelId,
      messageId: message.id,
      userId: senderStableId,
      username: user.username,
      type: data.type,
      text: data.text
    }).catch((error) => {
      console.error('[Webhooks] Failed to dispatch message.created:', error);
    });

    // Clear typing indicator for this channel
    if (typingUsers.has(socket.id)) {
      typingUsers.delete(socket.id);

      // Also remove from channel-specific typing users
      const channelTyping = channelTypingUsers.get(data.channelId);
      if (channelTyping) {
        channelTyping.delete(socket.id);
        // Emit updated typing list only to users in this channel
        const typingUsernames = Array.from(channelTyping).map(id => users.get(id)?.username).filter(Boolean);
        emitToChannel(data.channelId, "typing", { channelId: data.channelId, usernames: typingUsernames });
      }
    }
  });

  // Handle message edit
  socket.on("edit-message", (data: { messageId: string; newText: string; channelId: string }) => {
    if (!getAccessibleChannel(data.channelId)) return;

    const messages = channelMessages.get(data.channelId);
    if (!messages) return;

    const message = messages.find(m => m.id === data.messageId);
    if (!message) return;

    // Allow edit if userId matches current socket.id OR stable user ID
    const stableId = getStableUserId(socket);
    if (message.userId !== socket.id && message.userId !== stableId) return;

    // Block editing encrypted messages
    if (message.encrypted) return;

    message.text = data.newText;
    message.isEdited = true;

    // Persist edit to database
    try {
      messageRepository.markEdited(data.messageId, data.newText);
    } catch (dbError) {
      console.error('[MessageRepository] Failed to persist edit:', dbError);
    }

    emitToChannel(data.channelId, "message-edited", { channelId: data.channelId, messageId: data.messageId, newText: data.newText });
  });

  // Handle message delete
  socket.on("delete-message", (data: { messageId: string; channelId: string }) => {
    if (!getAccessibleChannel(data.channelId)) return;

    const messages = channelMessages.get(data.channelId);
    if (!messages) return;

    const messageIndex = messages.findIndex(m => m.id === data.messageId);
    if (messageIndex === -1) return;

    const message = messages[messageIndex];
    // Allow delete if userId matches current socket.id OR stable user ID
    const stableId = getStableUserId(socket);
    if (message.userId !== socket.id && message.userId !== stableId) return;

    // Delete associated files from filesystem
    if (message.fileUrl) {
      // Single file upload
      const fileName = message.fileUrl.replace('/uploads/', '');
      const filePath = join(UPLOADS_DIR, fileName);
      try {
        if (existsSync(filePath)) {
          unlinkSync(filePath);
          if (ENABLE_LOGGING) console.log(`Deleted file: ${fileName}`);
        }
      } catch (error) {
        console.error(`Failed to delete file ${fileName}:`, error);
      }
    }

    if (message.files && Array.isArray(message.files)) {
      // Multiple file uploads
      for (const file of message.files) {
        const fileName = file.fileUrl.replace('/uploads/', '');
        const filePath = join(UPLOADS_DIR, fileName);
        try {
          if (existsSync(filePath)) {
            unlinkSync(filePath);
            if (ENABLE_LOGGING) console.log(`Deleted file: ${fileName}`);
          }
        } catch (error) {
          console.error(`Failed to delete file ${fileName}:`, error);
        }
      }
    }

    messages.splice(messageIndex, 1);

    const channelPins = pinnedMessages.get(data.channelId);
    if (channelPins) {
      channelPins.delete(data.messageId);
    }

    // Cancel any scheduled auto-deletion for this message
    cancelMessageDeletion(data.messageId);

    // Soft delete in database
    try {
      messageRepository.softDelete(data.messageId);
    } catch (dbError) {
      console.error('[MessageRepository] Failed to soft delete message:', dbError);
    }

    emitToChannel(data.channelId, "message-deleted", { channelId: data.channelId, messageId: data.messageId });
  });

  // Handle message pin/unpin
  socket.on("toggle-pin-message", (data: { messageId: string; channelId: string }) => {
    if (!getAccessibleChannel(data.channelId)) return;

    const messages = channelMessages.get(data.channelId);
    if (!messages) return;

    const message = messages.find(m => m.id === data.messageId);
    if (!message) return;

    message.isPinned = !message.isPinned;

    let channelPins = pinnedMessages.get(data.channelId);
    if (!channelPins) {
      channelPins = new Set();
      pinnedMessages.set(data.channelId, channelPins);
    }

    if (message.isPinned) {
      channelPins.add(data.messageId);
    } else {
      channelPins.delete(data.messageId);
    }

    // Persist pin state to database
    try {
      messageRepository.update(data.messageId, { is_pinned: message.isPinned ? 1 : 0 });
    } catch (dbError) {
      console.error('[MessageRepository] Failed to update pin state:', dbError);
    }

    emitToChannel(data.channelId, "message-pin-toggled", { channelId: data.channelId, messageId: data.messageId, isPinned: message.isPinned });
  });

  // Handle channel pinning
  socket.on("pin-channel", (data: { channelId: string }) => {
    const channel = channels.get(data.channelId);
    if (!channel) return;

    // Initialize pinnedBy array if needed
    if (!channel.pinnedBy) {
      channel.pinnedBy = [];
    }

    // Add user to pinnedBy if not already present
    if (!channel.pinnedBy.includes(socket.id)) {
      channel.pinnedBy.push(socket.id);
    }

    channels.set(data.channelId, channel);

    // Emit to all connected clients (including the user who pinned it)
    io.emit("channel-pinned", { channelId: data.channelId, channel });
  });

  // Handle channel unpinning
  socket.on("unpin-channel", (data: { channelId: string }) => {
    const channel = channels.get(data.channelId);
    if (!channel || !channel.pinnedBy) return;

    // Remove user from pinnedBy array
    channel.pinnedBy = channel.pinnedBy.filter(id => id !== socket.id);

    channels.set(data.channelId, channel);

    // Emit to all connected clients
    io.emit("channel-unpinned", { channelId: data.channelId, channel });
  });

  // Handle emoji reactions
  socket.on("add-reaction", (data: { messageId: string; channelId: string; emojiId: string }) => {
    if (!getAccessibleChannel(data.channelId)) return;

    const messages = channelMessages.get(data.channelId);
    if (!messages) return;

    const message = messages.find(m => m.id === data.messageId);
    if (!message) return;

    const user = users.get(socket.id);
    if (!user) return;
    const stableReactionUserId = getStableUserId(socket);

    // Initialize reactions object if needed
    if (!message.reactions) {
      message.reactions = {};
    }

    // Initialize emoji reaction array if needed
    if (!message.reactions[data.emojiId]) {
      message.reactions[data.emojiId] = [];
    }

    // Use stable IDs for registered users so reactions survive reconnects.
    const reactionUserIds = message.reactions[data.emojiId];
    const hasStableReaction = reactionUserIds.includes(stableReactionUserId);
    const hasLegacySocketReaction = reactionUserIds.includes(user.id);

    if (!hasStableReaction && !hasLegacySocketReaction) {
      reactionUserIds.push(stableReactionUserId);
      applyEmojiRoleRules(user.dbUserId, data.channelId, data.messageId, data.emojiId, false);
    } else if (!hasStableReaction && hasLegacySocketReaction) {
      message.reactions[data.emojiId] = reactionUserIds.filter(id => id !== user.id);
      message.reactions[data.emojiId].push(stableReactionUserId);
    }

    // Persist reactions to database
    try {
      messageRepository.updateReactions(data.messageId, message.reactions);
    } catch (dbError) {
      console.error('[MessageRepository] Failed to update reactions:', dbError);
    }

    emitToChannel(data.channelId, "reaction-added", {
      channelId: data.channelId,
      messageId: data.messageId,
      emojiId: data.emojiId,
      userId: stableReactionUserId,
      reactions: message.reactions
    });
  });

  socket.on("remove-reaction", (data: { messageId: string; channelId: string; emojiId: string }) => {
    if (!getAccessibleChannel(data.channelId)) return;

    const messages = channelMessages.get(data.channelId);
    if (!messages) return;

    const message = messages.find(m => m.id === data.messageId);
    if (!message || !message.reactions) return;

    const user = users.get(socket.id);
    if (!user) return;
    const stableReactionUserId = getStableUserId(socket);

    // Remove user from reaction
    if (message.reactions[data.emojiId]) {
      const hadReaction =
        message.reactions[data.emojiId].includes(stableReactionUserId) ||
        message.reactions[data.emojiId].includes(user.id);
      message.reactions[data.emojiId] = message.reactions[data.emojiId].filter(
        id => id !== stableReactionUserId && id !== user.id
      );
      if (hadReaction) {
        applyEmojiRoleRules(user.dbUserId, data.channelId, data.messageId, data.emojiId, true);
      }

      // Remove emoji key if no users left
      if (message.reactions[data.emojiId].length === 0) {
        delete message.reactions[data.emojiId];
      }
    }

    // Persist reactions to database
    try {
      messageRepository.updateReactions(data.messageId, message.reactions);
    } catch (dbError) {
      console.error('[MessageRepository] Failed to update reactions:', dbError);
    }

    emitToChannel(data.channelId, "reaction-removed", {
      channelId: data.channelId,
      messageId: data.messageId,
      emojiId: data.emojiId,
      userId: stableReactionUserId,
      reactions: message.reactions
    });
  });

  // Handle emoji management
  socket.on("get-emojis", () => {
    socket.emit("emojis-list", getAllEmojis());
  });

  socket.on("upload-emoji", (data: {
    name: string;
    url: string;
    category: string;
    displayName?: string;
    artist?: string;
    type?: 'emoji' | 'sticker';
  }) => {
    const emoji: Emoji = {
      id: `custom_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: data.name,
      displayName: data.displayName?.trim() || undefined,
      artist: data.artist?.trim() || undefined,
      url: data.url,
      category: data.category,
      isCustom: true,
      type: data.type === 'sticker' ? 'sticker' : 'emoji',
      source: 'custom'
    };

    addCustomEmoji(emoji);
    io.emit("emoji-added", emoji);
  });

  socket.on("delete-emoji", (emojiName: string) => {
    const success = deleteCustomEmoji(emojiName);
    if (success) {
      io.emit("emoji-deleted", emojiName);
    }
  });

  // Handle typing indicator
  socket.on("typing", (data: { isTyping: boolean; channelId: string }) => {
    const user = users.get(socket.id);
    if (!user) return;

    // Use the channelId provided by the client
    const channelId = data.channelId;
    if (!channelId) return;

    // Get or create the typing users set for this channel
    let channelTyping = channelTypingUsers.get(channelId);
    if (!channelTyping) {
      channelTyping = new Set<string>();
      channelTypingUsers.set(channelId, channelTyping);
    }

    if (data.isTyping) {
      typingUsers.add(socket.id);
      channelTyping.add(socket.id);
    } else {
      typingUsers.delete(socket.id);
      channelTyping.delete(socket.id);
    }

    // Only emit typing indicator to users in the same channel
    const typingUsernames = Array.from(channelTyping).map(id => users.get(id)?.username).filter(Boolean);
    emitToChannel(channelId, "typing", { channelId, usernames: typingUsernames });
  });

  // WebRTC Signaling for screen sharing
  socket.on("start-screen-share", () => {
    const user = users.get(socket.id);
    if (!user) return;

    screenSharers.set(socket.id, {
      userId: socket.id,
      username: user.username
    });

    socket.broadcast.emit("screen-share-started", {
      userId: socket.id,
      username: user.username
    });
  });

  socket.on("stop-screen-share", () => {
    screenSharers.delete(socket.id);
    // Fixed: emit object with userId, not just socket.id string
    socket.broadcast.emit("screen-share-stopped", { userId: socket.id });
  });

  socket.on("request-screen-share", (data: { sharerId: string }) => {
    // Forward the request to the sharer so they can create an offer for this viewer
    io.to(data.sharerId).emit("screen-share-request", { viewerId: socket.id });
  });

  socket.on("webrtc-offer", (data: { offer: RTCSessionDescriptionInit; targetId: string }) => {
    const user = users.get(socket.id);
    io.to(data.targetId).emit("webrtc-offer", {
      offer: data.offer,
      senderId: socket.id,
      username: user?.username || 'Unknown'
    });
  });

  socket.on("webrtc-answer", (data: { answer: RTCSessionDescriptionInit; targetId: string }) => {
    io.to(data.targetId).emit("webrtc-answer", {
      answer: data.answer,
      senderId: socket.id
    });
  });

  socket.on("webrtc-ice-candidate", (data: { candidate: RTCIceCandidateInit; targetId: string }) => {
    io.to(data.targetId).emit("webrtc-ice-candidate", {
      candidate: data.candidate,
      senderId: socket.id
    });
  });

  // P2P file transfer signaling
  socket.on("p2p-offer", (data: { transferId: string; targetId: string; offer: any; fileName: string; fileSize: number }) => {
    const user = users.get(socket.id);
    io.to(data.targetId).emit("p2p-offer", {
      transferId: data.transferId,
      senderId: socket.id,
      senderUsername: user?.username || 'Unknown',
      offer: data.offer,
      fileName: data.fileName,
      fileSize: data.fileSize
    });
  });

  socket.on("p2p-answer", (data: { transferId: string; targetId: string; answer: any }) => {
    io.to(data.targetId).emit("p2p-answer", {
      transferId: data.transferId,
      senderId: socket.id,
      answer: data.answer
    });
  });

  socket.on("p2p-ice-candidate", (data: { transferId: string; targetId: string; candidate: any }) => {
    io.to(data.targetId).emit("p2p-ice-candidate", {
      transferId: data.transferId,
      senderId: socket.id,
      candidate: data.candidate
    });
  });

  // Excalidraw collaboration
  socket.on("excalidraw-update", (state: any) => {
    excalidrawState = state;
    socket.broadcast.emit("excalidraw-update", state);
  });

  // Voice channel occupancy + peer graph
  socket.on("voice-channel-join", (data: { channelId: string }) => {
    const user = users.get(socket.id);
    if (!user || !data.channelId) return;
    const voiceChannel = channels.get(data.channelId);
    if (!voiceChannel || voiceChannel.type !== 'voice') return;
    if (!canAccessChannel(voiceChannel)) return;

    const stableUserId = getStableUserId(socket);
    let participants = voiceChannelParticipants.get(data.channelId);
    if (!participants) {
      participants = new Set<string>();
      voiceChannelParticipants.set(data.channelId, participants);
    }

    if (participants.has(stableUserId)) return;

    participants.add(stableUserId);
    addVoiceSubscription(socket.id, data.channelId);
    emitVoiceChannelState(data.channelId);
    emitToVoiceAudience(data.channelId, "voice-channel-user-joined", {
      channelId: data.channelId,
      userId: stableUserId,
      socketId: socket.id,
      username: user.username
    });
  });

  socket.on("voice-channel-subscribe", (data: { channelId: string }) => {
    const user = users.get(socket.id);
    if (!user || !data.channelId) return;
    const voiceChannel = channels.get(data.channelId);
    if (!voiceChannel || voiceChannel.type !== 'voice') return;
    if (!canAccessChannel(voiceChannel)) return;

    addVoiceSubscription(socket.id, data.channelId);
    socket.emit("voice-channel-subscribed", {
      channelId: data.channelId,
      members: getVoiceChannelMembers(data.channelId)
    });
    emitVoiceChannelState(data.channelId);
  });

  socket.on("voice-channel-leave", (data: { channelId: string }) => {
    const user = users.get(socket.id);
    if (!user || !data.channelId) return;

    const stableUserId = getStableUserId(socket);
    const participants = voiceChannelParticipants.get(data.channelId);
    if (!participants || !participants.has(stableUserId)) return;

    participants.delete(stableUserId);
    if (participants.size === 0) {
      voiceChannelParticipants.delete(data.channelId);
    }

    emitVoiceChannelState(data.channelId);
    emitToVoiceAudience(data.channelId, "voice-channel-user-left", {
      channelId: data.channelId,
      userId: stableUserId,
      socketId: socket.id
    });

    removeAllVoicePeerLinks(stableUserId);
    removeVoiceSubscription(socket.id, data.channelId);
  });

  socket.on("voice-channel-unsubscribe", (data: { channelId: string }) => {
    const user = users.get(socket.id);
    if (!user || !data.channelId) return;
    removeVoiceSubscription(socket.id, data.channelId);
  });

  socket.on("voice-peer-link", (data: { peerStableUserId: string }) => {
    const user = users.get(socket.id);
    if (!user || !data.peerStableUserId) return;

    const stableUserId = getStableUserId(socket);
    addVoicePeerLink(stableUserId, data.peerStableUserId);
  });

  socket.on("voice-peer-unlink", (data: { peerStableUserId: string }) => {
    const user = users.get(socket.id);
    if (!user || !data.peerStableUserId) return;

    const stableUserId = getStableUserId(socket);
    removeVoicePeerLink(stableUserId, data.peerStableUserId);
  });

  // Voice/Video calling
  socket.on("call-initiate", (data: { targetUserId: string; isVideoCall: boolean }) => {
    const user = users.get(socket.id);
    if (!user) return;

    io.to(data.targetUserId).emit("call-incoming", {
      userId: socket.id,
      username: user.username,
      isVideoCall: data.isVideoCall
    });
  });

  socket.on("call-answer", (data: { callerId: string; isVideoCall: boolean }) => {
    const user = users.get(socket.id);
    // Fixed: emit call-accepted with username for proper UI display
    io.to(data.callerId).emit("call-accepted", {
      userId: socket.id,
      username: user?.username || 'Unknown',
      isVideoCall: data.isVideoCall
    });
    addCallPeer(socket.id, data.callerId);

    const myStableId = getStableUserId(socket);
    const callerUser = users.get(data.callerId);
    const callerStableId = callerUser?.dbUserId ? `user-${callerUser.dbUserId}` : data.callerId;
    addVoicePeerLink(myStableId, callerStableId);
  });

  socket.on("call-reject", (data: { callerId: string }) => {
    io.to(data.callerId).emit("call-rejected", {
      userId: socket.id
    });
  });

  socket.on("call-end", (data?: { participants?: string[] }) => {
    // Clean up call peer tracking
    removeAllCallPeers(socket.id);

    const myStableId = getStableUserId(socket);
    if (data?.participants && data.participants.length > 0) {
      data.participants.forEach(participantId => {
        const participant = users.get(participantId);
        const participantStableId = participant?.dbUserId ? `user-${participant.dbUserId}` : participantId;
        removeVoicePeerLink(myStableId, participantStableId);
      });
    } else {
      removeAllVoicePeerLinks(myStableId);
    }

    // Fixed: only notify call participants, not broadcast to everyone
    if (data?.participants && data.participants.length > 0) {
      // Send to specific participants
      data.participants.forEach(participantId => {
        io.to(participantId).emit("call-ended", {
          userId: socket.id
        });
      });
    } else {
      // Fallback: broadcast (for backward compatibility)
      socket.broadcast.emit("call-ended", {
        userId: socket.id
      });
    }
  });

  socket.on("call-offer", (data: { offer: RTCSessionDescriptionInit; targetId: string; channelId?: string }) => {
    if (data.channelId) {
      const channel = channels.get(data.channelId);
      if (!channel || channel.type !== 'voice') {
        return;
      }
      const audience = getVoiceAudienceSocketIds(data.channelId);
      if (!audience.has(socket.id) || !audience.has(data.targetId)) {
        return;
      }
    }
    const user = users.get(socket.id);
    io.to(data.targetId).emit("call-offer", {
      offer: data.offer,
      senderId: socket.id,
      username: user?.username || 'Unknown',
      channelId: data.channelId
    });
  });

  socket.on("call-answer-sdp", (data: { answer: RTCSessionDescriptionInit; targetId: string }) => {
    io.to(data.targetId).emit("call-answer-sdp", {
      answer: data.answer,
      senderId: socket.id
    });
  });

  socket.on("call-ice-candidate", (data: { candidate: RTCIceCandidateInit; targetId: string }) => {
    io.to(data.targetId).emit("call-ice-candidate", {
      candidate: data.candidate,
      senderId: socket.id
    });
  });

  // Channel management
  socket.on("create-channel", (data: string | {
    name: string;
    description?: string;
    channelType?: 'text' | 'voice';
    type?: 'text' | 'voice';
    channel_type?: 'text' | 'voice';
    minRole?: string;
    parentChannelId?: string;
    isBreakout?: boolean;
    breakoutIndex?: number;
  }) => {
    // Backward compat: accept plain string or object
    const channelName = typeof data === 'string' ? data : data.name;
    const channelDescription = typeof data === 'string' ? '' : (data.description || '');
    const requestedType =
      typeof data === 'string'
        ? 'text'
        : (data.channelType || data.type || data.channel_type || 'text');
    const channelType: 'text' | 'voice' = requestedType === 'voice' ? 'voice' : 'text';
    const channelId = channelName.toLowerCase().replace(/\s+/g, '-');

    // Check if channel already exists
    if (channels.has(channelId)) {
      socket.emit("channel-error", "Channel already exists");
      return;
    }

    // Validate channel name
    if (!/^[a-zA-Z0-9\s-]+$/.test(channelName)) {
      socket.emit("channel-error", "Channel name must be alphanumeric");
      return;
    }

    const channel: Channel = {
      id: channelId,
      name: channelName,
      description: channelDescription,
      minRole: 'guest',
      createdAt: Date.now(),
      type: channelType,
      parentChannelId: typeof data === 'string' ? undefined : data.parentChannelId,
      isBreakout: typeof data === 'string' ? false : data.isBreakout === true,
      breakoutIndex: typeof data === 'string' ? undefined : data.breakoutIndex,
      persistMessages: channelType === 'voice' ? false : true
    };

    channels.set(channelId, channel);
    channelMessages.set(channelId, []);
    pinnedMessages.set(channelId, new Set());

    // Persist to DB for restart durability
    try {
      channelRepository.create({
        channel_id: channelId,
        channel_type: channelType,
        name: channelName,
        description: channelDescription,
        min_role: 'guest',
        created_at: channel.createdAt,
        created_by: getStableUserId(socket),
        parent_channel_id: channel.parentChannelId || null,
        is_breakout: channel.isBreakout ? 1 : 0,
        breakout_index: channel.breakoutIndex || null,
        persist_messages: channel.persistMessages ? 1 : 0
      });
    } catch (dbError) {
      console.error('[ChannelRepository] Failed to persist channel:', dbError);
    }

    io.emit("channel-created", channel);

    pluginLoader.triggerOnChannelCreate(channel).catch((error) => {
      console.error('[Plugins] Failed to trigger onChannelCreate hook:', error);
    });
    dispatchWebhookEvent('channel.created', {
      channelId: channel.id,
      name: channel.name,
      type: channel.type || 'text'
    }).catch((error) => {
      console.error('[Webhooks] Failed to dispatch channel.created:', error);
    });

    if (ENABLE_LOGGING) console.log(`Channel created: ${channelName}`);
  });

  socket.on("create-breakout-rooms", (data: { parentChannelId: string; roomCount?: number; autoAssign?: boolean }) => {
    const parentChannel = channels.get(data.parentChannelId);
    if (!parentChannel || parentChannel.type !== 'voice' || parentChannel.isBreakout) {
      socket.emit("channel-error", "Breakout rooms require a parent voice channel");
      return;
    }
    if (!canAccessChannel(parentChannel)) {
      socket.emit("channel-error", "Access denied to this voice channel");
      return;
    }
    if (!canManageVoiceBreakouts()) {
      socket.emit("channel-error", "Only owner/admin/mod can manage breakout rooms");
      return;
    }

    const existingBreakouts = getBreakoutChannelsForParent(parentChannel.id);
    if (existingBreakouts.length > 0) {
      socket.emit("channel-error", "Close existing breakout rooms before creating a new set");
      return;
    }

    const roomCount = Math.max(2, Math.min(20, Math.floor(data.roomCount || 2)));
    const createdRooms: Channel[] = [];
    const creatorStableId = getStableUserId(socket);

    for (let i = 0; i < roomCount; i += 1) {
      const index = i + 1;
      let channelId = `${parentChannel.id}-breakout-${index}`;
      let suffix = 1;
      while (channels.has(channelId)) {
        suffix += 1;
        channelId = `${parentChannel.id}-breakout-${index}-${suffix}`;
      }

      const breakoutChannel: Channel = {
        id: channelId,
        name: `${parentChannel.name} Room ${index}`,
        description: `Breakout room ${index} for ${parentChannel.name}`,
        minRole: parentChannel.minRole || 'guest',
        createdAt: Date.now(),
        type: 'voice',
        parentChannelId: parentChannel.id,
        isBreakout: true,
        breakoutIndex: index,
        persistMessages: false
      };

      channels.set(channelId, breakoutChannel);
      channelMessages.set(channelId, []);
      pinnedMessages.set(channelId, new Set());

      try {
        channelRepository.create({
          channel_id: breakoutChannel.id,
          channel_type: 'voice',
          name: breakoutChannel.name,
          description: breakoutChannel.description || '',
          min_role: breakoutChannel.minRole || 'guest',
          created_at: breakoutChannel.createdAt,
          created_by: creatorStableId,
          parent_channel_id: breakoutChannel.parentChannelId || null,
          is_breakout: 1,
          breakout_index: breakoutChannel.breakoutIndex || null,
          persist_messages: 0
        });
      } catch (dbError) {
        console.error('[ChannelRepository] Failed to persist breakout channel:', dbError);
      }

      createdRooms.push(breakoutChannel);
      io.emit("channel-created", breakoutChannel);
    }

    if (data.autoAssign !== false && createdRooms.length > 0) {
      const parentParticipants = Array.from(voiceChannelParticipants.get(parentChannel.id) || []);
      parentParticipants.forEach((stableUserId, idx) => {
        const targetRoom = createdRooms[idx % createdRooms.length];
        moveVoiceParticipant(stableUserId, parentChannel.id, targetRoom.id);
      });
    }

    io.emit("voice-breakouts-updated", {
      parentChannelId: parentChannel.id,
      breakoutChannelIds: createdRooms.map(room => room.id)
    });
  });

  socket.on("close-breakout-rooms", (data: { parentChannelId: string }) => {
    const parentChannel = channels.get(data.parentChannelId);
    if (!parentChannel || parentChannel.type !== 'voice' || parentChannel.isBreakout) {
      socket.emit("channel-error", "Breakout parent voice channel not found");
      return;
    }
    if (!canAccessChannel(parentChannel)) {
      socket.emit("channel-error", "Access denied to this voice channel");
      return;
    }
    if (!canManageVoiceBreakouts()) {
      socket.emit("channel-error", "Only owner/admin/mod can manage breakout rooms");
      return;
    }

    const breakoutChannels = getBreakoutChannelsForParent(parentChannel.id);
    if (breakoutChannels.length === 0) return;

    breakoutChannels.forEach((breakoutChannel) => {
      const participants = Array.from(voiceChannelParticipants.get(breakoutChannel.id) || []);
      participants.forEach((stableUserId) => moveVoiceParticipant(stableUserId, breakoutChannel.id, parentChannel.id));

      voiceChannelParticipants.delete(breakoutChannel.id);

      channels.delete(breakoutChannel.id);
      channelMessages.delete(breakoutChannel.id);
      pinnedMessages.delete(breakoutChannel.id);
      channelRepository.delete(breakoutChannel.id);
      io.emit("channel-deleted", breakoutChannel.id);
    });

    emitVoiceChannelState(parentChannel.id);
    io.emit("voice-breakouts-updated", {
      parentChannelId: parentChannel.id,
      breakoutChannelIds: []
    });
  });

  socket.on("move-user-to-breakout", (data: { parentChannelId: string; targetUserId: string; toChannelId: string }) => {
    const parentChannel = channels.get(data.parentChannelId);
    if (!parentChannel || parentChannel.type !== 'voice') {
      socket.emit("channel-error", "Breakout parent voice channel not found");
      return;
    }
    if (!canAccessChannel(parentChannel)) {
      socket.emit("channel-error", "Access denied to this voice channel");
      return;
    }
    if (!canManageVoiceBreakouts()) {
      socket.emit("channel-error", "Only owner/admin/mod can move users between breakout rooms");
      return;
    }

    const targetChannel = channels.get(data.toChannelId);
    if (!targetChannel || targetChannel.type !== 'voice') {
      socket.emit("channel-error", "Target breakout channel not found");
      return;
    }
    if (targetChannel.id !== parentChannel.id && targetChannel.parentChannelId !== parentChannel.id) {
      socket.emit("channel-error", "Target channel is not part of this breakout set");
      return;
    }

    const stableUserId = resolveStableUserIdFromAny(data.targetUserId);
    if (!stableUserId) {
      socket.emit("channel-error", "Target user not found");
      return;
    }

    const familyChannels = [parentChannel, ...getBreakoutChannelsForParent(parentChannel.id)];
    const fromChannel = familyChannels.find(channel => {
      const participants = voiceChannelParticipants.get(channel.id);
      return participants?.has(stableUserId);
    });
    if (!fromChannel) {
      socket.emit("channel-error", "Target user is not connected to this voice channel set");
      return;
    }

    moveVoiceParticipant(stableUserId, fromChannel.id, targetChannel.id);
  });

  socket.on("thread:create", (data: {
    parentChannelId: string;
    name: string;
    parentMessageId?: string;
    privateThread?: boolean;
    autoArchiveMinutes?: number;
  }) => {
    const parentChannel = channels.get(data.parentChannelId);
    if (!parentChannel) {
      socket.emit("channel-error", "Parent channel does not exist");
      return;
    }

    if (!canAccessChannel(parentChannel)) {
      socket.emit("channel-error", "Access denied to parent channel");
      return;
    }

    if (parentChannel.type !== 'text' && parentChannel.type !== 'public') {
      socket.emit("channel-error", "Threads can only be created from text channels");
      return;
    }

    const rawName = (data.name || '').trim();
    if (!rawName) {
      socket.emit("channel-error", "Thread name is required");
      return;
    }
    if (rawName.length > 64) {
      socket.emit("channel-error", "Thread name must be 64 characters or fewer");
      return;
    }

    const slug = rawName
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
    const fallbackSlug = `thread-${Date.now().toString(36)}`;
    const baseSlug = slug || fallbackSlug;

    let channelId = `${parentChannel.id}-thread-${baseSlug}`;
    let dedupeCounter = 1;
    while (channels.has(channelId)) {
      dedupeCounter += 1;
      channelId = `${parentChannel.id}-thread-${baseSlug}-${dedupeCounter}`;
    }

    const now = Date.now();
    const requestedArchiveMinutes = data.autoArchiveMinutes ?? 1440;
    const threadAutoArchiveMinutes = Math.min(10080, Math.max(60, requestedArchiveMinutes));
    const threadType: Channel['type'] = data.privateThread ? 'thread_private' : 'thread_public';
    const stableCreatorId = getSocketStableId();

    const threadChannel: Channel = {
      id: channelId,
      name: rawName,
      description: '',
      minRole: parentChannel.minRole || 'guest',
      createdAt: now,
      type: threadType,
      members: data.privateThread ? [stableCreatorId] : undefined,
      parentChannelId: parentChannel.id,
      parentMessageId: data.parentMessageId,
      threadArchived: false,
      threadLocked: false,
      threadAutoArchiveMinutes,
      threadLastActivityAt: now,
      persistMessages: parentChannel.persistMessages ?? true
    };

    channels.set(channelId, threadChannel);
    channelMessages.set(channelId, []);
    pinnedMessages.set(channelId, new Set());

    try {
      channelRepository.create({
        channel_id: channelId,
        channel_type: threadType === 'thread_private' ? 'thread_private' : 'thread_public',
        name: rawName,
        description: '',
        min_role: threadChannel.minRole || 'guest',
        created_at: now,
        created_by: stableCreatorId,
        persist_messages: threadChannel.persistMessages ? 1 : 0,
        parent_channel_id: parentChannel.id,
        parent_message_id: data.parentMessageId || null,
        thread_archived: 0,
        thread_locked: 0,
        thread_auto_archive_minutes: threadAutoArchiveMinutes,
        thread_last_activity_at: now
      });

      if (threadChannel.members && threadChannel.members.length > 0) {
        channelMemberRepository.addMember({
          channel_id: channelId,
          user_id: stableCreatorId,
          username: users.get(socket.id)?.username || 'Unknown',
          registered_user_id: users.get(socket.id)?.dbUserId,
          joined_at: now
        });
      }
    } catch (dbError) {
      console.error('[ChannelRepository] Failed to persist thread channel:', dbError);
    }

    if (threadType === 'thread_private') {
      socket.emit("channel-created", threadChannel);
    } else {
      io.emit("channel-created", threadChannel);
    }

    pluginLoader.triggerOnChannelCreate(threadChannel).catch((error) => {
      console.error('[Plugins] Failed to trigger onChannelCreate hook:', error);
    });
    dispatchWebhookEvent('channel.created', {
      channelId: threadChannel.id,
      name: threadChannel.name,
      type: threadChannel.type || 'text'
    }).catch((error) => {
      console.error('[Webhooks] Failed to dispatch channel.created:', error);
    });

    if (ENABLE_LOGGING) console.log(`Thread created: ${threadChannel.name} (${threadChannel.id})`);
  });

  socket.on("delete-channel", (channelId: string) => {
    // Prevent deletion of general channel
    if (channelId === 'general' || channelId === 'voice') {
      socket.emit("channel-error", "Cannot delete base channels");
      return;
    }

    if (!channels.has(channelId)) {
      socket.emit("channel-error", "Channel does not exist");
      return;
    }

    const childThreadIds = Array.from(channels.values())
      .filter((channel) => channel.parentChannelId === channelId)
      .map((channel) => channel.id);
    for (const threadId of childThreadIds) {
      channels.delete(threadId);
      channelMessages.delete(threadId);
      pinnedMessages.delete(threadId);
      try {
        channelRepository.delete(threadId);
      } catch (dbError) {
        console.error('[ChannelRepository] Failed to delete child thread from DB:', dbError);
      }
      io.emit("channel-deleted", threadId);
    }

    channels.delete(channelId);
    channelMessages.delete(channelId);
    pinnedMessages.delete(channelId);

    try {
      channelRepository.delete(channelId);
    } catch (dbError) {
      console.error('[ChannelRepository] Failed to delete channel from DB:', dbError);
    }

    io.emit("channel-deleted", channelId);
    if (ENABLE_LOGGING) console.log(`Channel deleted: ${channelId}`);
  });

  // Update channel auto-delete settings
  socket.on("update-channel-settings", (data: {
    channelId: string;
    autoDeleteAfter?: '1h' | '6h' | '12h' | '24h' | '3d' | '7d' | '14d' | '30d' | null;
    persistMessages?: boolean;
    description?: string;
    minRole?: string;
    voiceSettings?: {
      bitrateMode?: 'auto' | 'low' | 'standard' | 'high';
    };
  }) => {
    const channel = channels.get(data.channelId);
    if (!channel) {
      socket.emit("channel-error", "Channel does not exist");
      return;
    }

    let validatedMinRole: string | undefined = data.minRole;
    if (data.minRole !== undefined) {
      const user = users.get(socket.id);
      const roleInfo = getUserRoleInfo(user?.dbUserId);
      if (!['owner', 'admin'].includes(roleInfo.highestRole)) {
        socket.emit("channel-error", "Only owner/admin can change channel role access");
        return;
      }
      const roleExists = db.prepare('SELECT 1 FROM roles WHERE role_name = ? AND workspace_id = ? LIMIT 1')
        .get(data.minRole, 'default-workspace');
      if (!roleExists) {
        socket.emit("channel-error", "Invalid minimum role");
        return;
      }
    }

    // Update channel settings
    channel.autoDeleteAfter = data.autoDeleteAfter;
    if (data.persistMessages !== undefined) {
      channel.persistMessages = data.persistMessages;
    }
    if (data.description !== undefined) {
      channel.description = data.description;
    }
    if (validatedMinRole !== undefined) {
      channel.minRole = validatedMinRole;
    }
    if (data.voiceSettings !== undefined) {
      channel.voiceSettings = data.voiceSettings;
    }
    channels.set(data.channelId, channel);

    // Persist channel settings metadata to database (never transient voice occupancy)
    if (data.description !== undefined || data.voiceSettings !== undefined || data.minRole !== undefined) {
      try {
        channelRepository.updateSettings(data.channelId, {
          description: data.description,
          min_role: validatedMinRole,
          voice_settings_json: data.voiceSettings !== undefined ? JSON.stringify(data.voiceSettings) : undefined
        });
      } catch (e) {
        // Channel may not exist in DB yet (in-memory only)
      }
    }

    // Notify all clients about the update
    io.emit("channel-settings-updated", {
      channelId: data.channelId,
      autoDeleteAfter: data.autoDeleteAfter,
      persistMessages: data.persistMessages,
      description: data.description,
      minRole: data.minRole,
      voiceSettings: data.voiceSettings
    });

    if (ENABLE_LOGGING) {
      console.log(`Channel ${data.channelId} settings updated:`, {
        autoDeleteAfter: data.autoDeleteAfter || 'disabled',
        persistMessages: data.persistMessages,
        description: data.description,
        minRole: data.minRole,
        voiceSettings: data.voiceSettings
      });
    }
  });

  // DM (Direct Message) creation
  socket.on("create-dm", (data: { targetUserId: string }) => {
    const user = users.get(socket.id);
    const targetUser = users.get(data.targetUserId);

    if (!user || !targetUser) {
      socket.emit("channel-error", "User not found");
      return;
    }

    // Use stable IDs for registered users, socket IDs for guests
    const myStableId = getStableUserId(socket);
    const targetStableId = targetUser.dbUserId ? `user-${targetUser.dbUserId}` : data.targetUserId;

    // Create DM channel ID by sorting stable IDs to ensure consistency
    const stableMemberIds = [myStableId, targetStableId].sort();
    const dmId = `dm-${stableMemberIds.join('-')}`;

    // Check if DM already exists (in-memory or database)
    if (channels.has(dmId)) {
      // DM exists, just notify the creator to switch to it
      socket.emit("dm-created", {
        channelId: dmId,
        otherUser: {
          id: targetUser.id,
          username: targetUser.username,
          color: targetUser.color,
          status: targetUser.status,
          profilePicture: targetUser.profilePicture,
          dbUserId: targetUser.dbUserId
        }
      });
      return;
    }

    // Also check the database for existing DM (may not be in memory yet)
    if (channelRepository.exists(dmId)) {
      // Load from DB into memory
      const dbChannel = channelRepository.findById(dmId);
      if (dbChannel) {
        const memberIds = channelMemberRepository.getMemberIds(dmId);
        const dmChannel: Channel = {
          id: dmId,
          name: dbChannel.name,
          createdAt: dbChannel.created_at,
          type: 'dm',
          members: memberIds,
          persistMessages: dbChannel.persist_messages === 1,
          recipientNotified: true
        };
        channels.set(dmId, dmChannel);
        if (!channelMessages.has(dmId)) {
          const dbMessages = messageRepository.getByChannel(dmId, { limit: 50 });
          channelMessages.set(dmId, dbMessages.map(msg => messageRepository.toClientFormat(msg)));
        }

        socket.emit("dm-created", {
          channelId: dmId,
          otherUser: {
            id: targetUser.id,
            username: targetUser.username,
            color: targetUser.color,
            status: targetUser.status,
            profilePicture: targetUser.profilePicture,
            dbUserId: targetUser.dbUserId
          }
        });
        return;
      }
    }

    // Create new DM channel with stable member IDs
    const dmChannel: Channel = {
      id: dmId,
      name: `${user.username}, ${targetUser.username}`,
      createdAt: Date.now(),
      type: 'dm',
      members: stableMemberIds,
      persistMessages: true,
      recipientNotified: false
    };

    channels.set(dmId, dmChannel);
    channelMessages.set(dmId, []);
    pinnedMessages.set(dmId, new Set());

    // Persist DM channel and members to database
    try {
      channelRepository.create({
        channel_id: dmId,
        channel_type: 'dm',
        name: dmChannel.name,
        created_at: dmChannel.createdAt,
        created_by: myStableId,
        persist_messages: 1
      });

      // Add both members with stable IDs and registered_user_id where applicable
      channelMemberRepository.addMembers([
        {
          channel_id: dmId,
          user_id: myStableId,
          username: user.username,
          registered_user_id: user.dbUserId,
          joined_at: Date.now(),
          role: 'member'
        },
        {
          channel_id: dmId,
          user_id: targetStableId,
          username: targetUser.username,
          registered_user_id: targetUser.dbUserId,
          joined_at: Date.now(),
          role: 'member'
        }
      ]);
    } catch (dbError) {
      console.error('[ChannelRepository] Failed to persist DM:', dbError);
    }

    // Notify the creator about the DM
    socket.emit("dm-created", {
      channelId: dmId,
      otherUser: {
        id: targetUser.id,
        username: targetUser.username,
        color: targetUser.color,
        status: targetUser.status,
        profilePicture: targetUser.profilePicture,
        dbUserId: targetUser.dbUserId
      }
    });

    if (ENABLE_LOGGING) console.log(`DM created: ${dmId} between ${user.username} and ${targetUser.username}`);
  });

  // Delete DM
  socket.on("delete-dm", (data: { channelId: string }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const channel = channels.get(data.channelId);
    if (!channel || channel.type !== 'dm') {
      socket.emit("channel-error", "DM channel not found");
      return;
    }

    // Verify the requesting user is a member
    const myStableId = getStableUserId(socket);
    if (!channel.members?.includes(myStableId)) {
      socket.emit("channel-error", "Not a member of this DM");
      return;
    }

    // Remove from in-memory state
    channels.delete(data.channelId);
    channelMessages.delete(data.channelId);
    pinnedMessages.delete(data.channelId);

    // Remove from database (CASCADE deletes members + messages)
    try {
      channelRepository.delete(data.channelId);
    } catch (e) {
      console.error('[DM] Failed to delete from DB:', e);
    }

    // Notify both participants
    for (const memberId of channel.members || []) {
      const memberSocketId = resolveSocketId(memberId);
      if (memberSocketId) {
        io.to(memberSocketId).emit("dm-deleted", { channelId: data.channelId });
      }
    }

    if (ENABLE_LOGGING) console.log(`DM deleted: ${data.channelId}`);
  });

  // Role management
  socket.on("assign-role", (data: { targetUserId: number; roleName: string }) => {
    const user = users.get(socket.id);
    if (!user || !user.dbUserId) return;

    // Only admin/owner can assign roles
    const myRoleInfo = getUserRoleInfo(user.dbUserId);
    if (!['owner', 'admin'].includes(myRoleInfo.highestRole)) {
      socket.emit("channel-error", "Insufficient permissions to assign roles");
      return;
    }

    try {
      assignRole(data.targetUserId, data.roleName as any);
      syncDbUserRoleState(data.targetUserId);
    } catch (e) {
      socket.emit("channel-error", "Failed to assign role");
    }
  });

  socket.on("remove-role", (data: { targetUserId: number; roleName: string }) => {
    const user = users.get(socket.id);
    if (!user || !user.dbUserId) return;

    const myRoleInfo = getUserRoleInfo(user.dbUserId);
    if (!['owner', 'admin'].includes(myRoleInfo.highestRole)) {
      socket.emit("channel-error", "Insufficient permissions to remove roles");
      return;
    }

    try {
      removeRole(data.targetUserId, data.roleName as any, 'default-workspace');
      syncDbUserRoleState(data.targetUserId);
    } catch (e) {
      socket.emit("channel-error", "Failed to remove role");
    }
  });

  socket.on("get-role-definitions", () => {
    socket.emit("role-definitions-updated", { roles: getRoleDefinitions('default-workspace') });
  });

  socket.on("set-role-display-name", (data: { roleName: string; displayName: string }) => {
    const user = users.get(socket.id);
    if (!user || !user.dbUserId) return;
    const myRoleInfo = getUserRoleInfo(user.dbUserId);
    if (!['owner', 'admin'].includes(myRoleInfo.highestRole)) {
      socket.emit("channel-error", "Insufficient permissions to rename roles");
      return;
    }

    const nextDisplay = (data.displayName || '').trim();
    if (nextDisplay.length < 1 || nextDisplay.length > 40) {
      socket.emit("channel-error", "Role display names must be 1-40 characters");
      return;
    }

    try {
      db.prepare(`
        UPDATE roles
        SET display_name = ?
        WHERE role_name = ? AND workspace_id = ?
      `).run(nextDisplay, data.roleName, 'default-workspace');
      emitRoleDefinitions();
    } catch (error) {
      socket.emit("channel-error", "Failed to update role display name");
    }
  });

  socket.on("get-emoji-role-rules", () => {
    emitEmojiRoleRules(socket.id);
  });

  socket.on("set-emoji-role-rule", (data: {
    channelId: string;
    messageId: string;
    emojiId: string;
    roleName: string;
    removeOnUnreact?: boolean;
  }) => {
    const user = users.get(socket.id);
    if (!user || !user.dbUserId) return;
    const myRoleInfo = getUserRoleInfo(user.dbUserId);
    if (!['owner', 'admin'].includes(myRoleInfo.highestRole)) {
      socket.emit("channel-error", "Insufficient permissions to manage emoji role rules");
      return;
    }

    if (!data.channelId || !data.messageId || !data.emojiId || !data.roleName) {
      socket.emit("channel-error", "Channel, role-gate message, emoji, and role are required");
      return;
    }

    if (data.roleName === 'owner') {
      socket.emit("channel-error", "Owner role cannot be automated");
      return;
    }

    const roleExists = db.prepare('SELECT 1 FROM roles WHERE role_name = ? AND workspace_id = ? LIMIT 1')
      .get(data.roleName, 'default-workspace');
    if (!roleExists) {
      socket.emit("channel-error", "Unknown role");
      return;
    }

    const gateMessages = channelMessages.get(data.channelId) || [];
    const gateMessage = gateMessages.find((message) => message.id === data.messageId);
    if (!gateMessage || gateMessage.type !== 'role_gate') {
      socket.emit("channel-error", "Selected message is not a role-gate post");
      return;
    }

    try {
      db.prepare(`
        INSERT INTO emoji_role_rules (channel_id, message_id, emoji_id, role_name, remove_on_unreact, workspace_id, enabled)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(
        data.channelId,
        data.messageId,
        data.emojiId,
        data.roleName,
        data.removeOnUnreact ? 1 : 0,
        'default-workspace'
      );
      emitEmojiRoleRules();
    } catch (error) {
      socket.emit("channel-error", "Failed to add emoji role rule");
    }
  });

  socket.on("delete-emoji-role-rule", (data: { ruleId: number }) => {
    const user = users.get(socket.id);
    if (!user || !user.dbUserId) return;
    const myRoleInfo = getUserRoleInfo(user.dbUserId);
    if (!['owner', 'admin'].includes(myRoleInfo.highestRole)) {
      socket.emit("channel-error", "Insufficient permissions to manage emoji role rules");
      return;
    }

    try {
      db.prepare('DELETE FROM emoji_role_rules WHERE id = ? AND workspace_id = ?')
        .run(data.ruleId, 'default-workspace');
      emitEmojiRoleRules();
    } catch (error) {
      socket.emit("channel-error", "Failed to delete emoji role rule");
    }
  });

  // Group chat creation
  socket.on("create-group", (data: { name: string; memberIds: string[] }) => {
    const user = users.get(socket.id);
    if (!user) return;

    // Validate group name
    if (!/^[a-zA-Z0-9\s\-_]+$/.test(data.name)) {
      socket.emit("channel-error", "Group name must be alphanumeric");
      return;
    }

    const creatorStableId = getStableUserId(socket);

    // Ensure creator is in the member list (memberIds should be stable IDs like "user-123")
    const memberIds = [...new Set([creatorStableId, ...data.memberIds])];

    // Create group chat ID using stable ID
    const groupId = `group-${Date.now()}-${creatorStableId}`;

    const groupChannel: Channel = {
      id: groupId,
      name: data.name,
      createdAt: Date.now(),
      type: 'group',
      members: memberIds
    };

    channels.set(groupId, groupChannel);
    channelMessages.set(groupId, []);
    pinnedMessages.set(groupId, new Set());

    // Resolve member user objects for the emit payload
    const memberUsers = memberIds.map(stableId => {
      const socketId = resolveSocketId(stableId);
      const memberUser = socketId ? users.get(socketId) : null;
      if (memberUser) {
        return {
          id: memberUser.id,
          username: memberUser.username,
          color: memberUser.color,
          status: memberUser.status,
          profilePicture: memberUser.profilePicture,
          dbUserId: memberUser.dbUserId
        };
      }
      // Offline DB fallback
      if (stableId.startsWith('user-')) {
        const dbId = parseInt(stableId.substring(5), 10);
        const dbUser = userRepository.findById(dbId);
        if (dbUser) {
          return {
            id: stableId,
            username: dbUser.username,
            color: dbUser.color,
            status: 'offline' as const,
            profilePicture: dbUser.profile_picture,
            dbUserId: dbId
          };
        }
      }
      return null;
    }).filter(Boolean);

    // Persist group channel and members to database
    try {
      channelRepository.create({
        channel_id: groupId,
        channel_type: 'group',
        name: data.name,
        created_at: groupChannel.createdAt,
        created_by: creatorStableId,
        persist_messages: 1
      });

      // Add all members with proper stable IDs and registered_user_id
      const memberRecords = memberIds.map(stableId => {
        const socketId = resolveSocketId(stableId);
        const memberUser = socketId ? users.get(socketId) : null;
        const registeredUserId = stableId.startsWith('user-') ? parseInt(stableId.substring(5), 10) : undefined;
        return {
          channel_id: groupId,
          user_id: stableId,
          username: memberUser?.username || 'Unknown',
          registered_user_id: registeredUserId,
          joined_at: Date.now(),
          role: stableId === creatorStableId ? 'owner' as const : 'member' as const
        };
      });
      channelMemberRepository.addMembers(memberRecords);
    } catch (dbError) {
      console.error('[ChannelRepository] Failed to persist group:', dbError);
    }

    // Notify all members about the group
    const groupPayload = {
      id: groupId,
      name: data.name,
      createdAt: groupChannel.createdAt,
      type: 'group' as const,
      members: memberIds,
      memberUsers,
      avatar: null
    };

    memberIds.forEach(stableId => {
      const socketId = resolveSocketId(stableId);
      if (socketId) {
        io.to(socketId).emit("group-created", groupPayload);
      }
    });

    pluginLoader.triggerOnChannelCreate(groupPayload).catch((error) => {
      console.error('[Plugins] Failed to trigger onChannelCreate hook:', error);
    });
    dispatchWebhookEvent('channel.created', {
      channelId: groupPayload.id,
      name: groupPayload.name,
      type: groupPayload.type
    }).catch((error) => {
      console.error('[Webhooks] Failed to dispatch channel.created:', error);
    });

    if (ENABLE_LOGGING) console.log(`Group created: ${data.name} (${groupId}) by ${user.username}`);
  });

  // Leave group (silent)
  socket.on("leave-group", (data: { channelId: string }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const stableId = getStableUserId(socket);
    const channel = channels.get(data.channelId);
    if (!channel || channel.type !== 'group') return;

    // Verify membership
    if (!channel.members?.includes(stableId)) {
      socket.emit("channel-error", "You are not a member of this group");
      return;
    }

    // Remove from DB
    channelMemberRepository.removeMember(data.channelId, stableId);

    // Update in-memory
    channel.members = channel.members.filter(id => id !== stableId);

    // Notify leaver
    socket.emit("group-removed", { channelId: data.channelId });

    // Notify remaining members
    channel.members.forEach(memberId => {
      const memberSocketId = resolveSocketId(memberId);
      if (memberSocketId) {
        io.to(memberSocketId).emit("group-member-removed", { channelId: data.channelId, userId: stableId });
      }
    });

    // Archive if no members remain
    if (channel.members.length === 0) {
      channelRepository.archive(data.channelId);
      channels.delete(data.channelId);
    }

    if (ENABLE_LOGGING) console.log(`User ${user.username} left group ${data.channelId}`);
  });

  // Kick group member
  socket.on("kick-group-member", (data: { channelId: string; targetUserId: string }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const stableId = getStableUserId(socket);
    const channel = channels.get(data.channelId);
    if (!channel || channel.type !== 'group') return;

    // Verify caller is owner or admin
    const callerMember = channelMemberRepository.getMember(data.channelId, stableId);
    if (!callerMember || (callerMember.role !== 'owner' && callerMember.role !== 'admin')) {
      socket.emit("channel-error", "Only the owner or admin can kick members");
      return;
    }

    // Verify target is a member and not the owner
    const targetMember = channelMemberRepository.getMember(data.channelId, data.targetUserId);
    if (!targetMember) {
      socket.emit("channel-error", "User is not a member of this group");
      return;
    }
    if (targetMember.role === 'owner') {
      socket.emit("channel-error", "Cannot kick the group owner");
      return;
    }

    // Remove from DB
    channelMemberRepository.removeMember(data.channelId, data.targetUserId);

    // Update in-memory
    if (channel.members) {
      channel.members = channel.members.filter(id => id !== data.targetUserId);
    }

    // Notify kicked user
    const targetSocketId = resolveSocketId(data.targetUserId);
    if (targetSocketId) {
      io.to(targetSocketId).emit("group-removed", { channelId: data.channelId });
    }

    // Notify remaining members
    channel.members?.forEach(memberId => {
      const memberSocketId = resolveSocketId(memberId);
      if (memberSocketId) {
        io.to(memberSocketId).emit("group-member-removed", { channelId: data.channelId, userId: data.targetUserId });
      }
    });

    if (ENABLE_LOGGING) console.log(`User ${data.targetUserId} kicked from group ${data.channelId} by ${user.username}`);
  });

  // Add member to group
  socket.on("add-group-member", (data: { channelId: string; userId: string }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const stableId = getStableUserId(socket);
    const channel = channels.get(data.channelId);
    if (!channel || channel.type !== 'group') return;

    // Verify caller is owner or admin
    const callerMember = channelMemberRepository.getMember(data.channelId, stableId);
    if (!callerMember || (callerMember.role !== 'owner' && callerMember.role !== 'admin')) {
      socket.emit("channel-error", "Only the owner or admin can add members");
      return;
    }

    // Verify target not already a member
    if (channel.members?.includes(data.userId)) {
      socket.emit("channel-error", "User is already a member");
      return;
    }

    // Resolve user info
    const targetSocketId = resolveSocketId(data.userId);
    const targetUser = targetSocketId ? users.get(targetSocketId) : null;
    const registeredUserId = data.userId.startsWith('user-') ? parseInt(data.userId.substring(5), 10) : undefined;

    // Add to DB
    channelMemberRepository.addMember({
      channel_id: data.channelId,
      user_id: data.userId,
      username: targetUser?.username || 'Unknown',
      registered_user_id: registeredUserId,
      joined_at: Date.now(),
      role: 'member'
    });

    // Update in-memory
    if (!channel.members) channel.members = [];
    channel.members.push(data.userId);

    // Build user info for emit
    let addedUserInfo: any = null;
    if (targetUser) {
      addedUserInfo = {
        id: targetUser.id,
        username: targetUser.username,
        color: targetUser.color,
        status: targetUser.status,
        profilePicture: targetUser.profilePicture,
        dbUserId: targetUser.dbUserId
      };
    } else if (data.userId.startsWith('user-')) {
      const dbId = parseInt(data.userId.substring(5), 10);
      const dbUser = userRepository.findById(dbId);
      if (dbUser) {
        addedUserInfo = {
          id: data.userId,
          username: dbUser.username,
          color: dbUser.color,
          status: 'offline',
          profilePicture: dbUser.profile_picture,
          dbUserId: dbId
        };
      }
    }

    // Notify existing members
    channel.members.forEach(memberId => {
      if (memberId === data.userId) return;
      const memberSocketId = resolveSocketId(memberId);
      if (memberSocketId) {
        io.to(memberSocketId).emit("group-member-added", { channelId: data.channelId, user: addedUserInfo });
      }
    });

    // Notify the new member with full channel data (reuse group-created event)
    const memberUsers = channel.members.map(mid => {
      const sid = resolveSocketId(mid);
      const mu = sid ? users.get(sid) : null;
      if (mu) return { id: mu.id, username: mu.username, color: mu.color, status: mu.status, profilePicture: mu.profilePicture, dbUserId: mu.dbUserId };
      if (mid.startsWith('user-')) {
        const dbId = parseInt(mid.substring(5), 10);
        const dbUser = userRepository.findById(dbId);
        if (dbUser) return { id: mid, username: dbUser.username, color: dbUser.color, status: 'offline', profilePicture: dbUser.profile_picture, dbUserId: dbId };
      }
      return null;
    }).filter(Boolean);

    const dbChannel = channelRepository.findById(data.channelId);
    if (targetSocketId) {
      io.to(targetSocketId).emit("group-created", {
        id: data.channelId,
        name: channel.name,
        createdAt: channel.createdAt,
        type: 'group',
        members: channel.members,
        memberUsers,
        avatar: dbChannel?.avatar || null
      });
    }

    if (ENABLE_LOGGING) console.log(`User ${data.userId} added to group ${data.channelId} by ${user.username}`);
  });

  // Update group avatar
  socket.on("update-group-avatar", (data: { channelId: string; avatarUrl: string | null }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const stableId = getStableUserId(socket);
    const channel = channels.get(data.channelId);
    if (!channel || channel.type !== 'group') return;

    // Verify caller is owner or admin
    const callerMember = channelMemberRepository.getMember(data.channelId, stableId);
    if (!callerMember || (callerMember.role !== 'owner' && callerMember.role !== 'admin')) {
      socket.emit("channel-error", "Only the owner or admin can change the group avatar");
      return;
    }

    // Update DB
    channelRepository.updateAvatar(data.channelId, data.avatarUrl);

    // Notify all members
    channel.members?.forEach(memberId => {
      const memberSocketId = resolveSocketId(memberId);
      if (memberSocketId) {
        io.to(memberSocketId).emit("group-avatar-updated", { channelId: data.channelId, avatar: data.avatarUrl });
      }
    });

    if (ENABLE_LOGGING) console.log(`Group avatar updated for ${data.channelId} by ${user.username}`);
  });

  // Emote management
  socket.on("upload-emote", (data: { name: string; imageData: string; type: 'static' | 'animated' }) => {
    const user = users.get(socket.id);
    if (!user) return;

    // Validate emote name (alphanumeric and underscores only)
    if (!/^[a-zA-Z0-9_]+$/.test(data.name)) {
      socket.emit("emote-error", "Emote name must be alphanumeric");
      return;
    }

    // Check if emote already exists
    if (emotes.has(data.name)) {
      socket.emit("emote-error", "Emote name already exists");
      return;
    }

    // Parse base64 image data
    const matches = data.imageData.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!matches) {
      socket.emit("emote-error", "Invalid image data");
      return;
    }

    const ext = matches[1];
    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, 'base64');

    // File size limit (2MB)
    if (buffer.length > 2 * 1024 * 1024) {
      socket.emit("emote-error", "File too large (max 2MB)");
      return;
    }

    // Save file
    const fileName = `${data.name}.${ext}`;
    const filePath = join(EMOTES_DIR, fileName);

    try {
      writeFileSync(filePath, buffer);

      // Add to emotes map
      const emote = {
        name: data.name,
        url: `/emotes/${fileName}`,
        type: data.type,
        uploadedBy: user.username,
        timestamp: Date.now()
      };

      emotes.set(data.name, emote);

      // Broadcast new emote to all users
      io.emit("emote-added", emote);

      if (ENABLE_LOGGING) console.log(`${user.username} added emote: ${data.name}`);
    } catch (error) {
      console.error("Error saving emote:", error);
      socket.emit("emote-error", "Failed to save emote");
    }
  });

  socket.on("delete-emote", (emoteName: string) => {
    const emote = emotes.get(emoteName);
    if (!emote) return;

    // Only allow uploader to delete (for now, can add admin check later)
    const user = users.get(socket.id);
    if (!user || emote.uploadedBy !== user.username) {
      socket.emit("emote-error", "You can only delete your own emotes");
      return;
    }

    emotes.delete(emoteName);
    io.emit("emote-deleted", emoteName);

    if (ENABLE_LOGGING) console.log(`${user.username} deleted emote: ${emoteName}`);
  });

  socket.on("disconnect", () => {
    const user = users.get(socket.id);

    if (user) {
      // Clean up reverse mapping for registered users
      if (user.dbUserId) {
        const currentSocketForUser = dbUserIdToSocketId.get(user.dbUserId);
        if (currentSocketForUser === socket.id) {
          dbUserIdToSocketId.delete(user.dbUserId);
        }
      }

      users.delete(socket.id);
      typingUsers.delete(socket.id);

      // Clean up channel tracking
      const channelId = userCurrentChannel.get(socket.id);
      if (channelId) {
        const channelTyping = channelTypingUsers.get(channelId);
        if (channelTyping) {
          channelTyping.delete(socket.id);
        }
        userCurrentChannel.delete(socket.id);
      }

      if (screenSharers.has(socket.id)) {
        screenSharers.delete(socket.id);
        // Fixed: emit object with userId, not just socket.id string
        socket.broadcast.emit("screen-share-stopped", { userId: socket.id });
      }

      // Clean up active calls — notify orphaned peers
      const callPeers = removeAllCallPeers(socket.id);
      for (const peerId of callPeers) {
        io.to(peerId).emit("call-ended", { userId: socket.id });
      }

      // Remove user from all voice channels and emit leave events
      const stableUserId = getStableUserId(socket);
      for (const [voiceChannelId, participants] of voiceChannelParticipants.entries()) {
        if (!participants.has(stableUserId)) continue;

        participants.delete(stableUserId);
        if (participants.size === 0) {
          voiceChannelParticipants.delete(voiceChannelId);
        }

        emitVoiceChannelState(voiceChannelId);
        emitToVoiceAudience(voiceChannelId, "voice-channel-user-left", {
          channelId: voiceChannelId,
          userId: stableUserId,
          socketId: socket.id
        });
      }
      removeAllVoicePeerLinks(stableUserId);
      removeAllVoiceSubscriptionsForSocket(socket.id);

      socket.broadcast.emit("user-left", {
        id: socket.id,
        username: user.username
      });

      pluginLoader.triggerOnUserLeave(socket.id).catch((error) => {
        console.error('[Plugins] Failed to trigger onUserLeave hook:', error);
      });
      dispatchWebhookEvent('user.left', {
        id: socket.id,
        username: user.username,
        dbUserId: user.dbUserId || null
      }).catch((error) => {
        console.error('[Webhooks] Failed to dispatch user.left:', error);
      });

      if (ENABLE_LOGGING) console.log(`${user.username} left the chat`);
    }
  });
});

// Relay health monitor: mark stale relays as offline every 60 seconds
const RELAY_HEALTH_TIMEOUT = parseInt(process.env.RELAY_HEALTH_TIMEOUT || '300', 10);
setInterval(() => {
  const marked = relayRepository.markStaleRelaysOffline(RELAY_HEALTH_TIMEOUT);
  if (marked > 0 && ENABLE_LOGGING) {
    console.log(`[Relay] Marked ${marked} stale relay(s) as offline`);
  }
}, 60_000);

console.log(`🚀 Community Chat server running on port ${PORT}`);
console.log(`📁 Serving static files from: ${STATIC_DIR}`);
console.log(`💚 Health check available at: http://localhost:${PORT}/health`);
