import { Server } from "socket.io";
import { createServer } from "http";
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";

// In-memory data store
interface Channel {
  id: string;
  name: string;
  createdAt: number;
}

const channels = new Map<string, Channel>();
channels.set('general', { id: 'general', name: 'general', createdAt: Date.now() });

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

io.on("connection", (socket) => {
  if (ENABLE_LOGGING) console.log(`User connected: ${socket.id}`);

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
    socket.emit("init", {
      channels: Array.from(channels.values()),
      users: Array.from(users.values()),
      excalidrawState,
      emotes: Array.from(emotes.values())
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

    // Send channel messages to the user
    const messages = channelMessages.get(channelId) || [];
    socket.emit("channel-messages", { channelId, messages });
  });

  // Handle chat messages
  socket.on("message", (data: {
    text: string;
    type: 'text' | 'gif' | 'file';
    channelId: string;
    gifUrl?: string;
    fileUrl?: string;
    fileName?: string;
    fileSize?: number;
    files?: { fileUrl: string; fileName: string; fileSize: number }[];
    replyTo?: string;
  }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const channel = channels.get(data.channelId);
    if (!channel) return;

    const message = {
      id: `${Date.now()}-${socket.id}`,
      user: user.username,
      userId: socket.id,
      text: data.text,
      timestamp: Date.now(),
      type: data.type,
      gifUrl: data.gifUrl,
      fileUrl: data.fileUrl,
      fileName: data.fileName,
      fileSize: data.fileSize,
      files: data.files,
      isPinned: false,
      isEdited: false,
      replyTo: data.replyTo
    };

    // Add message to channel
    const messages = channelMessages.get(data.channelId) || [];
    messages.push(message);
    channelMessages.set(data.channelId, messages);

    io.emit("message", { channelId: data.channelId, message });

    // Clear typing indicator
    if (typingUsers.has(socket.id)) {
      typingUsers.delete(socket.id);
      io.emit("typing", Array.from(typingUsers).map(id => users.get(id)?.username).filter(Boolean));
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

    io.emit("message-edited", { channelId: data.channelId, messageId: data.messageId, newText: data.newText });
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

    io.emit("message-deleted", { channelId: data.channelId, messageId: data.messageId });
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

    io.emit("message-pin-toggled", { channelId: data.channelId, messageId: data.messageId, isPinned: message.isPinned });
  });

  // Handle typing indicator
  socket.on("typing", (isTyping: boolean) => {
    const user = users.get(socket.id);
    if (!user) return;

    if (isTyping) {
      typingUsers.add(socket.id);
    } else {
      typingUsers.delete(socket.id);
    }

    io.emit("typing", Array.from(typingUsers).map(id => users.get(id)?.username).filter(Boolean));
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
  socket.on("disconnect", () => {
    const user = users.get(socket.id);

    if (user) {
      users.delete(socket.id);
      typingUsers.delete(socket.id);

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
