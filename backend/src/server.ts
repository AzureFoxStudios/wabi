import { Server } from "socket.io";
import { createServer } from "http";
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync, createReadStream } from "fs";
import { join, basename } from "path";
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
import { handleGetRelays, handleRelayRegister, handleRelayHealth, handleRelayApprove, handleGetAllRelays } from "./api/relayRoutes.js";
import { handleGetMediaRuntime, handleMediaGatewayHeartbeat } from "./api/mediaRoutes.js";
import { handleCreateWebhook, handleListWebhooks, handleDeleteWebhook, handleListWebhookDeliveries } from "./api/webhookRoutes.js";
import { relayRepository } from "./db/repositories/relayRepository.js";
import { corsCallback, getCORSHeaders, getAllowedOrigins, isOriginAllowed } from "./config/cors.js";
import { channelRepository } from "./db/repositories/channelRepository.js";
import { channelMemberRepository } from "./db/repositories/channelMemberRepository.js";
import { messageRepository } from "./db/repositories/messageRepository.js";
import { serverSettingsRepository } from "./db/repositories/serverSettingsRepository.js";
import { blockedUsernameRepository } from "./db/repositories/blockedUsernameRepository.js";
import { userSanctionRepository } from "./db/repositories/userSanctionRepository.js";
import { moderationTriggerRepository } from "./db/repositories/moderationTriggerRepository.js";
import { getUserRoles, assignRole, removeRole } from "./auth/roleMiddleware.js";
import { dispatchWebhookEvent } from "./webhooks/deliveryService.js";

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


function hasStaffPower(dbUserId?: number): boolean {
  if (!dbUserId) return false;
  const roleInfo = getUserRoleInfo(dbUserId);
  return ['owner', 'admin', 'mod'].includes(roleInfo.highestRole);
}

function normalizeName(value: string): string {
  return value.trim().replace(/^@/, '').toLowerCase();
}
// In-memory data store
interface Channel {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  type?: 'public' | 'dm' | 'group';
  members?: string[]; // User IDs for DMs and group chats
  autoDeleteAfter?: '1h' | '6h' | '12h' | '24h' | '3d' | '7d' | '14d' | '30d' | null;
  isTemporary?: boolean;
  persistMessages?: boolean; // Opt-in flag for message persistence
  pinnedBy?: string[]; // Array of user IDs who have pinned this channel
  recipientNotified?: boolean;
}

const channels = new Map<string, Channel>();
channels.set('general', { id: 'general', name: 'general', createdAt: Date.now(), type: 'public' });

const channelMessages = new Map<string, Array<{
  id: string;
  user: string;
  userId: string;
  text: string;
  timestamp: number;
  type: 'text' | 'gif' | 'file';
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

const pinnedMessages = new Map<string, Set<string>>(); // channelId -> Set of messageIds
pinnedMessages.set('general', new Set());

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

// WebRTC signaling state
const screenSharers = new Map<string, {
  userId: string;
  username: string;
}>();

// Track active call peers: socketId -> Set of partner socketIds
const activeCallPeers = new Map<string, Set<string>>();

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
const DATA_DIR = '/app/data';
const MESSAGES_FILE = join(DATA_DIR, 'messages.json');
const BUSINESS_DATA_DIR = join(DATA_DIR, 'business');

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

// File upload storage - OUTSIDE build folder to persist across rebuilds
const UPLOADS_DIR = '/app/uploads';
if (!existsSync(UPLOADS_DIR)) {
  mkdirSync(UPLOADS_DIR, { recursive: true });
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
  if (url.pathname === "/api/upload" && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
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
          writeFileSync(filePath, fileBuffer);

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
            const fileId = `${Date.now()}-${fileName}`;
            const filePath = join(UPLOADS_DIR, fileId);
            // Ensure uploads dir exists (may have been wiped by redeploy)
            if (!existsSync(UPLOADS_DIR)) {
              mkdirSync(UPLOADS_DIR, { recursive: true });
            }
            writeFileSync(filePath, fileData);

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

  if (url.pathname === "/api/media/runtime" && req.method === "GET") {
    await handleGetMediaRuntime(req, res);
    return;
  }

  if (url.pathname === "/api/media/gateway-heartbeat" && req.method === "POST") {
    await handleMediaGatewayHeartbeat(req, res);
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
    return {
      ...data,
      todos: data.todos.filter(t => (t.visibility ?? 'public') === 'public'),
      projects: data.projects.filter(p => (p.visibility ?? 'public') === 'public'),
      sprints: data.sprints.filter(s => (s.visibility ?? 'public') === 'public'),
      calendarEvents: data.calendarEvents.filter(e => (e.visibility ?? 'public') === 'public'),
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
            url: emojiUrl,
            category,
            isCustom: true,
            type: emojiType
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

  // Server moderation settings
  if (url.pathname === "/api/server-settings" && req.method === "GET") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized - authentication required' }));
      return;
    }

    if (!hasStaffPower(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Insufficient permissions' }));
      return;
    }

    const settings = serverSettingsRepository.get();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      registrationOpen: settings.registration_open === 1,
      raidModeEnabled: settings.raid_mode_enabled === 1,
      raidModeExpiresAt: settings.raid_mode_expires_at || null
    }));
    return;
  }

  if (url.pathname === "/api/server-settings" && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized - authentication required' }));
      return;
    }

    if (!hasStaffPower(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Insufficient permissions' }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const updates: any = {};
        if (typeof body.registrationOpen === 'boolean') updates.registration_open = body.registrationOpen ? 1 : 0;
        if (typeof body.raidModeEnabled === 'boolean') updates.raid_mode_enabled = body.raidModeEnabled ? 1 : 0;
        if (body.raidModeExpiresAt === null || typeof body.raidModeExpiresAt === 'number') updates.raid_mode_expires_at = body.raidModeExpiresAt;
        const settings = serverSettingsRepository.set(updates);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          registrationOpen: settings.registration_open === 1,
          raidModeEnabled: settings.raid_mode_enabled === 1,
          raidModeExpiresAt: settings.raid_mode_expires_at || null
        }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
      }
    });
    return;
  }

  if (url.pathname === "/api/blocked-usernames" && req.method === "GET") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized - authentication required' }));
      return;
    }

    if (!hasStaffPower(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Insufficient permissions' }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, items: blockedUsernameRepository.list() }));
    return;
  }

  if (url.pathname === "/api/blocked-usernames" && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized - authentication required' }));
      return;
    }

    if (!hasStaffPower(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Insufficient permissions' }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const value = String(body.value || '').trim();
        if (!value) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: 'value is required' }));
          return;
        }
        blockedUsernameRepository.add(normalizeName(value), body.reason, userId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
      }
    });
    return;
  }

  if (url.pathname === "/api/blocked-usernames" && req.method === "DELETE") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized - authentication required' }));
      return;
    }

    if (!hasStaffPower(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Insufficient permissions' }));
      return;
    }

    const value = url.searchParams.get('value');
    if (!value) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'value query param is required' }));
      return;
    }

    blockedUsernameRepository.remove(value);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  if (url.pathname === "/api/moderation-triggers" && req.method === "GET") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized - authentication required' }));
      return;
    }

    if (!hasStaffPower(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Insufficient permissions' }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, items: moderationTriggerRepository.listActive() }));
    return;
  }

  if (url.pathname === "/api/moderation-triggers" && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized - authentication required' }));
      return;
    }

    if (!hasStaffPower(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Insufficient permissions' }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!body.phrase || !body.action) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: 'phrase and action are required' }));
          return;
        }
        moderationTriggerRepository.add({
          phrase: String(body.phrase),
          action: body.action === 'ban' ? 'ban' : 'timeout',
          duration_minutes: Number.isFinite(Number(body.duration_minutes)) ? Number(body.duration_minutes) : 30,
          severity: ['low','medium','high'].includes(body.severity) ? body.severity : 'medium',
          is_active: 1,
          created_by: userId
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
      }
    });
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

    const roleInfo = getUserRoleInfo(userId);
    if (!['owner', 'admin'].includes(roleInfo.highestRole)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Insufficient permissions' }));
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
            unlinkSync(join(UPLOADS_DIR, file));
            deletedCount++;
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
      const etag = `"${stat.size}-${Math.floor(stat.mtimeMs)}"`;

      const headers: Record<string, string | number> = {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'ETag': etag,
        'Last-Modified': stat.mtime.toUTCString(),
        'Accept-Ranges': 'bytes',
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
      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (match) {
          const start = parseInt(match[1], 10);
          const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
          if (start >= stat.size || end >= stat.size || start > end) {
            res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
            res.end();
            return;
          }
          headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
          headers['Content-Length'] = end - start + 1;
          res.writeHead(206, headers);
          createReadStream(filePath, { start, end }).pipe(res);
          return;
        }
      }

      // Full response with streaming
      headers['Content-Length'] = stat.size;
      res.writeHead(200, headers);
      createReadStream(filePath).pipe(res);
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

  // Ensure general channel exists in DB and load public channels
  channelRepository.ensureGeneralExists();
  const dbChannels = channelRepository.getPublicChannels();
  dbChannels.forEach(ch => {
    if (!channels.has(ch.channel_id)) {
      channels.set(ch.channel_id, {
        id: ch.channel_id,
        name: ch.name,
        description: ch.description || '',
        createdAt: ch.created_at,
        type: ch.channel_type,
        persistMessages: ch.persist_messages === 1
      });
      if (!channelMessages.has(ch.channel_id)) {
        channelMessages.set(ch.channel_id, []);
      }
    }
  });
  console.log(`[Database] ✅ Loaded ${dbChannels.length} channels from database`);
} catch (error) {
  console.error('[Database] ❌ Initialization failed:', error);
  process.exit(1);
}

// Start background job for expired offline message cleanup (hourly)
setInterval(() => {
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

// Cleanup on shutdown
process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down...');
  closeDatabase();
  process.exit(0);
});

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
          createdAt: dbChannel.created_at,
          type: dbChannel.channel_type,
          members: memberIds,
          persistMessages: dbChannel.persist_messages === 1,
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
    // Public channels are accessible to everyone
    if (!channel.members || channel.members.length === 0) return true;
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

      if (userSanctionRepository.hasActiveType(payload.userId, 'ban')) {
        return next(new Error('Account banned'));
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

  // Handle user join
  socket.on("join", async (username: string) => {
    // Check if this is a registered user (authenticated via JWT in middleware)
    if ((socket as any).isRegistered && (socket as any).sessionId) {
      // Registered user - use their DB session instead of creating a temp session
      const dbSession = sessionRepository.findById((socket as any).sessionId);

      if (dbSession) {
        if (userSanctionRepository.hasActiveType((socket as any).dbUserId, 'ban')) {
          socket.emit('force-logout', { reason: 'Account banned', banned: true });
          socket.disconnect(true);
          return;
        }

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
          excalidrawState,
          emotes: Array.from(emotes.values()),
          emojis: emojisData,
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
        excalidrawState,
        emotes: Array.from(emotes.values()),
        emojis: emojisData,
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
        excalidrawState,
        emotes: Array.from(emotes.values()),
        emojis: emojisData2,
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
      excalidrawState,
      emotes: Array.from(emotes.values()),
      emojis: emojisData,
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
  socket.on("update-profile", (data: { status?: 'active' | 'away' | 'busy'; profilePicture?: string; usernameFont?: { family?: string; size?: string; weight?: string; style?: string } }, callback?: (response: { success: boolean; error?: string }) => void) => {
    const user = users.get(socket.id);
    if (!user) {
      if (callback) callback({ success: false, error: 'User not found' });
      return;
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
            profile_picture: user.profilePicture || null
          });

          // Also update the user's main profile
          if (dbSession.user_id) {
            const userUpdateData: any = {
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
    const channel = channels.get(channelId);
    if (!channel) {
      console.error(`[join-channel] Channel ${channelId} not found for user ${socket.id}`);
      socket.emit("channel-error", `Channel ${channelId} does not exist`);
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

    // Check membership for DMs and groups
    if (channel.members && channel.members.length > 0) {
      if (!channel.members.includes(socket.id)) {
        socket.emit("channel-error", "Access denied to this channel");
        return;
      }
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
    type: 'text' | 'gif' | 'file' | 'emoji';
    channelId: string;
    gifUrl?: string;
    emojiUrl?: string;
    emojiName?: string;
    fileUrl?: string;
    fileName?: string;
    fileSize?: number;
    files?: { fileUrl: string; fileName: string; fileSize: number }[];
    replyTo?: string;
    isSpoiler?: boolean;
    encrypted?: boolean;
    iv?: string;
  }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const channel = channels.get(data.channelId);
    if (!channel) return;

    if (user.dbUserId && userSanctionRepository.hasActiveType(user.dbUserId, 'ban')) {
      socket.emit('force-logout', { reason: 'Account banned', banned: true });
      socket.disconnect(true);
      return;
    }

    if (user.dbUserId && userSanctionRepository.hasActiveType(user.dbUserId, 'timeout')) {
      socket.emit('channel-error', 'You are timed out and cannot send messages right now.');
      return;
    }

    const textForModeration = (data.text || '').toLowerCase();
    if (user.dbUserId && textForModeration) {
      const triggers = moderationTriggerRepository.listActive();
      const hit = triggers.find(t => textForModeration.includes((t.phrase || '').toLowerCase()));
      if (hit) {
        if (hit.action === 'ban') {
          userSanctionRepository.add(user.dbUserId, 'ban', `Triggered phrase: ${hit.phrase}`, null);
          socket.emit('force-logout', { reason: 'Account banned by moderation trigger', banned: true });
          socket.disconnect(true);
          return;
        }
        const duration = hit.duration_minutes && hit.duration_minutes > 0 ? hit.duration_minutes : 30;
        userSanctionRepository.add(user.dbUserId, 'timeout', `Triggered phrase: ${hit.phrase}`, null, duration);
        socket.emit('channel-error', `You have been timed out for ${duration} minutes.`);
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
    const messages = channelMessages.get(data.channelId);
    if (!messages) return;

    const messageIndex = messages.findIndex(m => m.id === data.messageId);
    if (messageIndex === -1) return;

    const message = messages[messageIndex];
    const user = users.get(socket.id);
    // Allow delete if userId matches current socket.id OR stable user ID or user has staff power
    const stableId = getStableUserId(socket);
    const canModerateDelete = hasStaffPower(user?.dbUserId);
    if (message.userId !== socket.id && message.userId !== stableId && !canModerateDelete) return;

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
    const messages = channelMessages.get(data.channelId);
    if (!messages) return;

    const message = messages.find(m => m.id === data.messageId);
    if (!message) return;

    const user = users.get(socket.id);
    if (!user) return;

    // Initialize reactions object if needed
    if (!message.reactions) {
      message.reactions = {};
    }

    // Initialize emoji reaction array if needed
    if (!message.reactions[data.emojiId]) {
      message.reactions[data.emojiId] = [];
    }

    // Add user to reaction if not already present
    if (!message.reactions[data.emojiId].includes(user.id)) {
      message.reactions[data.emojiId].push(user.id);
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
      userId: user.id,
      reactions: message.reactions
    });
  });

  socket.on("remove-reaction", (data: { messageId: string; channelId: string; emojiId: string }) => {
    const messages = channelMessages.get(data.channelId);
    if (!messages) return;

    const message = messages.find(m => m.id === data.messageId);
    if (!message || !message.reactions) return;

    const user = users.get(socket.id);
    if (!user) return;

    // Remove user from reaction
    if (message.reactions[data.emojiId]) {
      message.reactions[data.emojiId] = message.reactions[data.emojiId].filter(id => id !== user.id);

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
      userId: user.id,
      reactions: message.reactions
    });
  });

  // Handle emoji management
  socket.on("get-emojis", () => {
    socket.emit("emojis-list", getAllEmojis());
  });

  socket.on("upload-emoji", (data: { name: string; url: string; category: string }) => {
    const emoji: Emoji = {
      id: `custom_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: data.name,
      url: data.url,
      category: data.category,
      isCustom: true
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
  });

  socket.on("call-reject", (data: { callerId: string }) => {
    io.to(data.callerId).emit("call-rejected", {
      userId: socket.id
    });
  });

  socket.on("call-end", (data?: { participants?: string[] }) => {
    // Clean up call peer tracking
    removeAllCallPeers(socket.id);

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

  socket.on("call-offer", (data: { offer: RTCSessionDescriptionInit; targetId: string }) => {
    const user = users.get(socket.id);
    io.to(data.targetId).emit("call-offer", {
      offer: data.offer,
      senderId: socket.id,
      username: user?.username || 'Unknown'
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
  socket.on("create-channel", (data: string | { name: string; description?: string }) => {
    // Backward compat: accept plain string or object
    const channelName = typeof data === 'string' ? data : data.name;
    const channelDescription = typeof data === 'string' ? '' : (data.description || '');
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
      createdAt: Date.now()
    };

    channels.set(channelId, channel);
    channelMessages.set(channelId, []);
    pinnedMessages.set(channelId, new Set());

    io.emit("channel-created", channel);

    pluginLoader.triggerOnChannelCreate(channel).catch((error) => {
      console.error('[Plugins] Failed to trigger onChannelCreate hook:', error);
    });
    dispatchWebhookEvent('channel.created', {
      channelId: channel.id,
      name: channel.name,
      type: channel.type || 'public'
    }).catch((error) => {
      console.error('[Webhooks] Failed to dispatch channel.created:', error);
    });

    if (ENABLE_LOGGING) console.log(`Channel created: ${channelName}`);
  });

  socket.on("delete-channel", (channelId: string) => {
    // Prevent deletion of general channel
    if (channelId === 'general') {
      socket.emit("channel-error", "Cannot delete general channel");
      return;
    }

    if (!channels.has(channelId)) {
      socket.emit("channel-error", "Channel does not exist");
      return;
    }

    channels.delete(channelId);
    channelMessages.delete(channelId);
    pinnedMessages.delete(channelId);

    io.emit("channel-deleted", channelId);
    if (ENABLE_LOGGING) console.log(`Channel deleted: ${channelId}`);
  });

  // Update channel auto-delete settings
  socket.on("update-channel-settings", (data: {
    channelId: string;
    autoDeleteAfter?: '1h' | '6h' | '12h' | '24h' | '3d' | '7d' | '14d' | '30d' | null;
    persistMessages?: boolean;
    description?: string;
  }) => {
    const channel = channels.get(data.channelId);
    if (!channel) {
      socket.emit("channel-error", "Channel does not exist");
      return;
    }

    // Update channel settings
    channel.autoDeleteAfter = data.autoDeleteAfter;
    if (data.persistMessages !== undefined) {
      channel.persistMessages = data.persistMessages;
    }
    if (data.description !== undefined) {
      channel.description = data.description;
    }
    channels.set(data.channelId, channel);

    // Persist description to database
    if (data.description !== undefined) {
      try {
        channelRepository.updateSettings(data.channelId, { description: data.description });
      } catch (e) {
        // Channel may not exist in DB yet (in-memory only)
      }
    }

    // Notify all clients about the update
    io.emit("channel-settings-updated", {
      channelId: data.channelId,
      autoDeleteAfter: data.autoDeleteAfter,
      persistMessages: data.persistMessages,
      description: data.description
    });

    if (ENABLE_LOGGING) {
      console.log(`Channel ${data.channelId} settings updated:`, {
        autoDeleteAfter: data.autoDeleteAfter || 'disabled',
        persistMessages: data.persistMessages,
        description: data.description
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
      const newRoleInfo = getUserRoleInfo(data.targetUserId);

      // Find the target user's socket and update their info
      for (const [sid, u] of users.entries()) {
        if (u.dbUserId === data.targetUserId) {
          u.roles = newRoleInfo.roles;
          u.highestRole = newRoleInfo.highestRole;
          u.roleColor = newRoleInfo.roleColor;
          users.set(sid, u);

          // Broadcast role change to all clients
          io.emit("user-role-changed", {
            userId: sid,
            dbUserId: data.targetUserId,
            roles: newRoleInfo.roles,
            highestRole: newRoleInfo.highestRole,
            roleColor: newRoleInfo.roleColor
          });
          break;
        }
      }
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
      const newRoleInfo = getUserRoleInfo(data.targetUserId);

      for (const [sid, u] of users.entries()) {
        if (u.dbUserId === data.targetUserId) {
          u.roles = newRoleInfo.roles;
          u.highestRole = newRoleInfo.highestRole;
          u.roleColor = newRoleInfo.roleColor;
          users.set(sid, u);

          io.emit("user-role-changed", {
            userId: sid,
            dbUserId: data.targetUserId,
            roles: newRoleInfo.roles,
            highestRole: newRoleInfo.highestRole,
            roleColor: newRoleInfo.roleColor
          });
          break;
        }
      }
    } catch (e) {
      socket.emit("channel-error", "Failed to remove role");
    }
  });

  socket.on("mod-ban-user", (data: { targetUserId: number; reason?: string }) => {
    const user = users.get(socket.id);
    if (!user || !user.dbUserId || !hasStaffPower(user.dbUserId)) {
      socket.emit("channel-error", "Insufficient permissions to ban user");
      return;
    }

    userSanctionRepository.add(data.targetUserId, 'ban', data.reason || 'Banned by moderator', user.dbUserId);

    for (const [sid, u] of users.entries()) {
      if (u.dbUserId === data.targetUserId) {
        io.to(sid).emit('force-logout', { reason: 'Account banned', banned: true });
        const targetSocket = io.sockets.sockets.get(sid);
        targetSocket?.disconnect(true);
      }
    }
  });

  socket.on("mod-timeout-user", (data: { targetUserId: number; durationMinutes?: number; reason?: string }) => {
    const user = users.get(socket.id);
    if (!user || !user.dbUserId || !hasStaffPower(user.dbUserId)) {
      socket.emit("channel-error", "Insufficient permissions to timeout user");
      return;
    }

    const duration = data.durationMinutes && data.durationMinutes > 0 ? data.durationMinutes : 30;
    userSanctionRepository.add(data.targetUserId, 'timeout', data.reason || 'Timed out by moderator', user.dbUserId, duration);
  });

  socket.on("mod-unban-user", (data: { targetUserId: number }) => {
    const user = users.get(socket.id);
    if (!user || !user.dbUserId || !hasStaffPower(user.dbUserId)) {
      socket.emit("channel-error", "Insufficient permissions to unban user");
      return;
    }

    userSanctionRepository.clearType(data.targetUserId, 'ban');
  });

  socket.on("mod-clear-timeout", (data: { targetUserId: number }) => {
    const user = users.get(socket.id);
    if (!user || !user.dbUserId || !hasStaffPower(user.dbUserId)) {
      socket.emit("channel-error", "Insufficient permissions to clear timeout");
      return;
    }

    userSanctionRepository.clearType(data.targetUserId, 'timeout');
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
