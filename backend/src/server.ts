import { Server } from "socket.io";
import { createServer } from "http";
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { PluginLoader } from "./plugins/loader";
import { getAllEmojis, getEmojiByName, addCustomEmoji, deleteCustomEmoji, type Emoji } from "./emojis";

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
}>();

const typingUsers = new Set<string>();
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
const DATA_DIR = './data';
const MESSAGES_FILE = join(DATA_DIR, 'messages.json');

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
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

const PORT = process.env.PORT || 3000;
const STATIC_DIR = process.env.STATIC_DIR || join(import.meta.dir, "../../static");
const EMOTES_DIR = join(STATIC_DIR, "emotes");
const ENABLE_LOGGING = process.env.ENABLE_LOGGING === 'true';

// Ensure emotes directory exists
if (!existsSync(EMOTES_DIR)) {
  mkdirSync(EMOTES_DIR, { recursive: true });
}

// File upload storage
const UPLOADS_DIR = join(STATIC_DIR, "uploads");
if (!existsSync(UPLOADS_DIR)) {
  mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Create HTTP server using Node.js http module (Bun compatible)
const server = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // CORS headers for all requests - dynamically set based on request origin
  const allowedOrigins = [
    'http://localhost:5173',
    'https://ungruff-subtarsal-libby.ngrok-free.dev',
    process.env.FRONTEND_URL
  ].filter(Boolean);

  const requestOrigin = req.headers.origin;
  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');

  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // File upload endpoint
  if (url.pathname === "/api/upload" && req.method === "POST") {
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

  // Emoji upload endpoint
  if (url.pathname === "/api/emoji/upload" && req.method === "POST") {
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
          writeFileSync(filePath, fileData);

          // Use full URL for emoji (important for dev mode with separate ports)
          const serverUrl = `http://localhost:${PORT}`;
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

  // Serve static files in production
  if (existsSync(STATIC_DIR)) {
    // Decode the URL pathname to handle spaces and special characters
    const decodedPathname = decodeURIComponent(url.pathname);
    let filePath = join(STATIC_DIR, decodedPathname === "/" ? "index.html" : decodedPathname);

    // Check if the file exists
    if (existsSync(filePath)) {
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

// Start HTTP server
server.listen(PORT);

// Create Socket.IO server attached to HTTP server
const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:5173",
      "https://ungruff-subtarsal-libby.ngrok-free.dev",
      process.env.FRONTEND_URL
    ].filter(Boolean), // Remove undefined if FRONTEND_URL not set
    methods: ["GET", "POST"],
    credentials: true
  },
  maxHttpBufferSize: 75 * 1024 * 1024 // 75MB (to handle 50MB files after base64 encoding ~33% overhead)
});

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

io.on("connection", (socket) => {
  console.log(`🔌 WebSocket connection established: ${socket.id}`);

  // Handle user join
  socket.on("join", (username: string) => {
    const color = `#${Math.floor(Math.random()*16777215).toString(16)}`;
    users.set(socket.id, {
      id: socket.id,
      username,
      color,
      status: 'active',
      profilePicture: undefined
    });

    // Send existing channels, users, and emotes to the new user
    // Filter channels: only send public channels and channels where user is a member
    const userChannels = Array.from(channels.values()).filter(channel => {
      // Public channels (no members array) are visible to everyone
      if (!channel.members || channel.members.length === 0) {
        return true;
      }
      // DMs and groups: only visible if user is a member
      return channel.members.includes(socket.id);
    });

    const emojisData = getAllEmojis();
    console.log('[EMOJI DEBUG] Sending emojis to client:', emojisData.length, 'emojis');
    socket.emit("init", {
      channels: userChannels,
      users: Array.from(users.values()),
      excalidrawState,
      emotes: Array.from(emotes.values()),
      emojis: emojisData
    });

    // Broadcast new user to others
    socket.broadcast.emit("user-joined", {
      id: socket.id,
      username,
      color,
      status: 'active',
      profilePicture: undefined
    });

    if (ENABLE_LOGGING) console.log(`${username} joined the chat`);
  });

  // Handle profile updates
  socket.on("update-profile", (data: { status?: 'active' | 'away' | 'busy'; profilePicture?: string }) => {
    const user = users.get(socket.id);
    if (!user) return;

    if (data.status) {
      user.status = data.status;
    }
    if (data.profilePicture !== undefined) {
      user.profilePicture = data.profilePicture;
    }

    users.set(socket.id, user);

    // Broadcast profile update to all users
    io.emit("profile-updated", {
      id: socket.id,
      username: user.username,
      color: user.color,
      status: user.status,
      profilePicture: user.profilePicture
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
        emitToChannel(data.channelId, "typing", typingUsernames);
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
  socket.on("typing", (isTyping: boolean) => {
    const user = users.get(socket.id);
    if (!user) return;

    // Get the channel the user is currently in
    const channelId = userCurrentChannel.get(socket.id);
    if (!channelId) return;

    // Get or create the typing users set for this channel
    let channelTyping = channelTypingUsers.get(channelId);
    if (!channelTyping) {
      channelTyping = new Set<string>();
      channelTypingUsers.set(channelId, channelTyping);
    }

    if (isTyping) {
      typingUsers.add(socket.id);
      channelTyping.add(socket.id);
    } else {
      typingUsers.delete(socket.id);
      channelTyping.delete(socket.id);
    }

    // Only emit typing indicator to users in the same channel
    const typingUsernames = Array.from(channelTyping).map(id => users.get(id)?.username).filter(Boolean);
    emitToChannel(channelId, "typing", typingUsernames);
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
    socket.broadcast.emit("screen-share-stopped", socket.id);
  });

  socket.on("webrtc-offer", (data: { offer: RTCSessionDescriptionInit; targetId: string }) => {
    io.to(data.targetId).emit("webrtc-offer", {
      offer: data.offer,
      senderId: socket.id
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
    io.to(data.callerId).emit("call-accepted", {
      userId: socket.id,
      isVideoCall: data.isVideoCall
    });
  });

  socket.on("call-reject", (data: { callerId: string }) => {
    io.to(data.callerId).emit("call-rejected", {
      userId: socket.id
    });
  });

  socket.on("call-end", () => {
    socket.broadcast.emit("call-ended", {
      userId: socket.id
    });
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
        socket.broadcast.emit("screen-share-stopped", socket.id);
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
