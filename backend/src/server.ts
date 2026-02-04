import { Server } from "socket.io";
import { createServer } from "http";
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from "fs";
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
import { handleRegister, handleLogin, handleUpgrade, handleGetUserSettings, handleSaveUserSettings } from "./api/authRoutes.js";
import { handleGetThemePreferences, handleSaveThemePreferences, handleResetThemePreferences } from "./api/themeRoutes.js";
import { corsCallback, getCORSHeaders, getAllowedOrigins, isOriginAllowed } from "./config/cors.js";
// In-memory data store
interface Channel {
  id: string;
  name: string;
  createdAt: number;
  type?: 'public' | 'dm' | 'group';
  members?: string[]; // User IDs for DMs and group chats
  autoDeleteAfter?: '1h' | '6h' | '12h' | '24h' | '3d' | '7d' | '14d' | '30d' | null;
  isTemporary?: boolean;
  persistMessages?: boolean; // Opt-in flag for message persistence
  pinnedBy?: string[]; // Array of user IDs who have pinned this channel
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
  color: string;
  status: 'active' | 'away' | 'busy';
  profilePicture?: string;
  workspaceId?: string; // Business workspace the user belongs to
  usernameFont?: {
    family?: string;
    size?: string;
    weight?: string;
    style?: string;
  };
}>();

// Session management for persistence across reconnects
const sessions = new Map<string, { userId: string; username: string; color: string; profilePicture?: string; createdAt: number }>();

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
    origin: corsCallback,
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

          // Use PUBLIC_URL if available, otherwise construct from request host
          const serverUrl = process.env.PUBLIC_URL || `http://${req.headers.host}`;
          const profilePictureUrl = `${serverUrl}/uploads/${fileId}`;

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

          // Use PUBLIC_URL if available, otherwise construct from request host
          const serverUrl = process.env.PUBLIC_URL || `http://${req.headers.host}`;
          const backgroundImageUrl = `${serverUrl}/uploads/${fileId}`;

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

      const data = businessWorkspaces.get(workspaceId) || initializeWorkspace(workspaceId);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        data
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

        // Broadcast update to all other connected users in this workspace
        io.emit('business-data-updated', {
          workspaceId,
          data: businessData
        });

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

  // Helper function to extract user ID from request
  function getAuthenticatedUserId(req: IncomingMessage): number | null {
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

      const workspaceId = defaultWorkspaceId;
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
        const workspaceId = defaultWorkspaceId;
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
        const workspaceId = defaultWorkspaceId;
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

      const workspaceId = defaultWorkspaceId;
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
            isCustom: true
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
      const file = readFileSync(filePath);
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

      res.writeHead(200, { "Content-Type": contentTypes[ext || ''] || 'application/octet-stream' });
      res.end(file);
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
    channel.members.forEach(memberId => {
      io.to(memberId).emit(event, data);
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

        users.set(socket.id, {
          id: socket.id,
          username: registeredUsername,
          color: registeredColor,
          status: 'active',
          profilePicture: registeredProfilePic,
          usernameFont
        });

        const userChannels = Array.from(channels.values()).filter(channel => {
          if (!channel.members || channel.members.length === 0) return true;
          return channel.members.includes(socket.id);
        });

        const emojisData = getAllEmojis();
        socket.emit("init", {
          channels: userChannels,
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
          color: registeredColor,
          status: 'active',
          profilePicture: registeredProfilePic,
          usernameFont
        });

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

      const userChannels = Array.from(channels.values()).filter(channel => {
        if (!channel.members || channel.members.length === 0) return true;
        return channel.members.includes(socket.id);
      });

      const emojisData = getAllEmojis();
      socket.emit("init", {
        channels: userChannels,
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

      const userChannels = Array.from(channels.values()).filter(channel => {
        if (!channel.members || channel.members.length === 0) return true;
        return channel.members.includes(socket.id);
      });

      const emojisData = getAllEmojis();
      socket.emit("init", {
        channels: userChannels,
        users: Array.from(users.values()),
        excalidrawState,
        emotes: Array.from(emotes.values()),
        emojis: emojisData,
        sessionId: sessionId
      });

      socket.broadcast.emit("user-joined", {
        id: socket.id,
        username,
        color,
        status: 'active',
        profilePicture: undefined
      });

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

    // Create/update user object with existing session data
    users.set(socket.id, {
      id: socket.id,
      username: session.username,
      color: session.color,
      status: 'active',
      profilePicture: session.profilePicture
    });

    // Send existing channels, users, and emotes to the reconnecting user
    const userChannels = Array.from(channels.values()).filter(channel => {
      if (!channel.members || channel.members.length === 0) {
        return true;
      }
      return channel.members.includes(socket.id);
    });

    const emojisData = getAllEmojis();
    socket.emit("init", {
      channels: userChannels,
      users: Array.from(users.values()),
      excalidrawState,
      emotes: Array.from(emotes.values()),
      emojis: emojisData,
      sessionId: sessionId
    });

    // Broadcast user rejoin
    const rejoinUser = users.get(socket.id);
    socket.broadcast.emit("user-joined", {
      id: socket.id,
      username: session.username,
      color: rejoinUser?.color,
      status: 'active',
      profilePicture: rejoinUser?.profilePicture
    });

    if (ENABLE_LOGGING) console.log(`${session.username} rejoined the chat`);
  });

  // Handle profile updates
  socket.on("update-profile", (data: { status?: 'active' | 'away' | 'busy'; profilePicture?: string; usernameFont?: { family?: string; size?: string; weight?: string; style?: string } }) => {
    const user = users.get(socket.id);
    if (!user) return;

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
      }
    }

    // For temp users, update in-memory session
    const sessions_array = Array.from(sessions.entries());
    for (const [sessionId, session] of sessions_array) {
      if (session.userId === socket.id) {
        session.profilePicture = user.profilePicture;
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
      usernameFont: user.usernameFont
    });

    if (ENABLE_LOGGING) console.log(`${user.username} updated profile: status=${user.status}`);
  });

  // Handle joining a channel
  socket.on("join-channel", (channelId: string) => {
    const channel = channels.get(channelId);
    if (!channel) return;

    // Track which channel the user is in
    userCurrentChannel.set(socket.id, channelId);

    // Send channel messages to the user
    const messages = channelMessages.get(channelId) || [];
    socket.emit("channel-messages", { channelId, messages });
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
  }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const channel = channels.get(data.channelId);
    if (!channel) return;

    // Calculate deletion time: use channel auto-delete setting, or default to 1 day
    const DEFAULT_SERVER_EXPIRATION = 24 * 60 * 60 * 1000; // 1 day in milliseconds
    const deletionTime = channel.autoDeleteAfter
      ? Date.now() + getAutoDeleteMs(channel.autoDeleteAfter)
      : Date.now() + DEFAULT_SERVER_EXPIRATION;

    const message = {
      id: `${Date.now()}-${socket.id}`,
      user: user.username,
      userId: socket.id,
      text: data.text,
      timestamp: Date.now(),
      type: data.type,
      gifUrl: data.gifUrl,
      emojiUrl: data.emojiUrl,
      emojiName: data.emojiName,
      fileUrl: data.fileUrl,
      fileName: data.fileName,
      fileSize: data.fileSize,
      files: data.files,
      isPinned: false,
      isEdited: false,
      replyTo: data.replyTo,
      isSpoiler: data.isSpoiler,
      // All messages have scheduled deletion time (either custom or default 1-day)
      scheduledDeletionTime: deletionTime
    };

    // Add message to channel
    const messages = channelMessages.get(data.channelId) || [];
    messages.push(message);
    channelMessages.set(data.channelId, messages);

    emitToChannel(data.channelId, "message", { channelId: data.channelId, message });

    // Schedule auto-deletion for ALL messages (either custom time or default 1-day)
    const deletionDuration = channel.autoDeleteAfter || '24h';
    scheduleMessageDeletion(data.channelId, message.id, deletionDuration);

    // Note: We do NOT save messages to server disk anymore
    // Clients save messages to their own localStorage if persistence is enabled

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
    if (!message || message.userId !== socket.id) return;

    message.text = data.newText;
    message.isEdited = true;

    emitToChannel(data.channelId, "message-edited", { channelId: data.channelId, messageId: data.messageId, newText: data.newText });
  });

  // Handle message delete
  socket.on("delete-message", (data: { messageId: string; channelId: string }) => {
    const messages = channelMessages.get(data.channelId);
    if (!messages) return;

    const messageIndex = messages.findIndex(m => m.id === data.messageId);
    if (messageIndex === -1) return;

    const message = messages[messageIndex];
    if (message.userId !== socket.id) return;

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
  });

  socket.on("call-reject", (data: { callerId: string }) => {
    io.to(data.callerId).emit("call-rejected", {
      userId: socket.id
    });
  });

  socket.on("call-end", (data?: { participants?: string[] }) => {
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
    io.to(data.targetId).emit("call-offer", {
      offer: data.offer,
      senderId: socket.id
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
  socket.on("create-channel", (channelName: string) => {
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
      createdAt: Date.now()
    };

    channels.set(channelId, channel);
    channelMessages.set(channelId, []);
    pinnedMessages.set(channelId, new Set());

    io.emit("channel-created", channel);
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
    channels.set(data.channelId, channel);

    // Notify all clients about the update
    io.emit("channel-settings-updated", {
      channelId: data.channelId,
      autoDeleteAfter: data.autoDeleteAfter,
      persistMessages: data.persistMessages
    });

    if (ENABLE_LOGGING) {
      console.log(`Channel ${data.channelId} settings updated:`, {
        autoDeleteAfter: data.autoDeleteAfter || 'disabled',
        persistMessages: data.persistMessages
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

    // Create DM channel ID by sorting user IDs to ensure consistency
    const memberIds = [socket.id, data.targetUserId].sort();
    const dmId = `dm-${memberIds.join('-')}`;

    // Check if DM already exists
    if (channels.has(dmId)) {
      // DM exists, just notify the creator to switch to it
      socket.emit("dm-created", {
        channelId: dmId,
        otherUser: {
          id: targetUser.id,
          username: targetUser.username,
          color: targetUser.color,
          status: targetUser.status,
          profilePicture: targetUser.profilePicture
        }
      });
      return;
    }

    // Create new DM channel
    const dmChannel: Channel = {
      id: dmId,
      name: `${user.username}, ${targetUser.username}`,
      createdAt: Date.now(),
      type: 'dm',
      members: memberIds
    };

    channels.set(dmId, dmChannel);
    channelMessages.set(dmId, []);
    pinnedMessages.set(dmId, new Set());

    // Notify both users about the DM
    socket.emit("dm-created", {
      channelId: dmId,
      otherUser: {
        id: targetUser.id,
        username: targetUser.username,
        color: targetUser.color,
        status: targetUser.status,
        profilePicture: targetUser.profilePicture
      }
    });

    io.to(data.targetUserId).emit("dm-created", {
      channelId: dmId,
      otherUser: {
        id: user.id,
        username: user.username,
        color: user.color,
        status: user.status,
        profilePicture: user.profilePicture
      }
    });

    if (ENABLE_LOGGING) console.log(`DM created: ${dmId} between ${user.username} and ${targetUser.username}`);
  });

  // Group chat creation
  socket.on("create-group", (data: { name: string; memberIds: string[] }) => {
    const user = users.get(socket.id);
    if (!user) return;

    // Validate group name
    if (!/^[a-zA-Z0-9\s-]+$/.test(data.name)) {
      socket.emit("channel-error", "Group name must be alphanumeric");
      return;
    }

    // Ensure creator is in the member list
    const memberIds = [...new Set([socket.id, ...data.memberIds])];

    // Create group chat ID
    const groupId = `group-${Date.now()}-${socket.id}`;

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

    // Notify all members about the group
    memberIds.forEach(memberId => {
      io.to(memberId).emit("group-created", {
        id: groupId,
        name: data.name,
        createdAt: groupChannel.createdAt,
        type: 'group',
        members: memberIds.map(id => {
          const u = users.get(id);
          return u ? {
            id: u.id,
            username: u.username,
            color: u.color,
            status: u.status,
            profilePicture: u.profilePicture
          } : null;
        }).filter(Boolean)
      });
    });

    if (ENABLE_LOGGING) console.log(`Group created: ${data.name} (${groupId}) by ${user.username}`);
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

  // Handle disconnect
  // Emoji management
  socket.on("emoji-added", (emoji: Emoji) => {
    // Broadcast new emoji to all clients
    io.emit("emoji-added", emoji);
  });

  socket.on("delete-emoji", (emojiName: string) => {
    const deleted = deleteCustomEmoji(emojiName);
    if (deleted) {
      io.emit("emoji-deleted", emojiName);
    }
  });

  socket.on("disconnect", () => {
    const user = users.get(socket.id);

    if (user) {
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

      socket.broadcast.emit("user-left", {
        id: socket.id,
        username: user.username
      });

      if (ENABLE_LOGGING) console.log(`${user.username} left the chat`);
    }
  });
});

console.log(`🚀 Community Chat server running on port ${PORT}`);
console.log(`📁 Serving static files from: ${STATIC_DIR}`);
console.log(`💚 Health check available at: http://localhost:${PORT}/health`);
