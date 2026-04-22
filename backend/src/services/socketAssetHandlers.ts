interface UserLike {
  username: string;
}

interface EmoteLike {
  uploadedBy: string;
}

interface SocketAssetHandlerSocketLike {
  id: string;
  emit(event: string, payload: unknown): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

interface RegisterSocketAssetHandlersOptions<TUser extends UserLike, TEmote extends EmoteLike> {
  socket: SocketAssetHandlerSocketLike;
  users: Map<string, TUser>;
  emotes: Map<string, TEmote>;
  getAllEmojis: () => unknown[];
  addCustomEmoji: (emoji: unknown) => void;
  deleteCustomEmoji: (emojiName: string) => boolean;
  saveEmoteFile: (fileName: string, buffer: Uint8Array) => void;
  addEmote: (emoteName: string, emote: TEmote) => void;
  emitToAllSockets: (event: string, payload: unknown) => void;
  logEnabled: boolean;
  log: (...args: unknown[]) => void;
}

export function registerSocketAssetHandlers<TUser extends UserLike, TEmote extends EmoteLike>({
  socket,
  users,
  emotes,
  getAllEmojis,
  addCustomEmoji,
  deleteCustomEmoji,
  saveEmoteFile,
  addEmote,
  emitToAllSockets,
  logEnabled,
  log
}: RegisterSocketAssetHandlersOptions<TUser, TEmote>): void {
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
    const emoji = {
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
    emitToAllSockets("emoji-added", emoji);
  });

  socket.on("delete-emoji", (emojiName: string) => {
    const success = deleteCustomEmoji(emojiName);
    if (success) {
      emitToAllSockets("emoji-deleted", emojiName);
    }
  });

  socket.on("upload-emote", (data: { name: string; imageData: string; type: 'static' | 'animated' }) => {
    const user = users.get(socket.id);
    if (!user) return;

    if (!/^[a-zA-Z0-9_]+$/.test(data.name)) {
      socket.emit("emote-error", "Emote name must be alphanumeric");
      return;
    }

    if (emotes.has(data.name)) {
      socket.emit("emote-error", "Emote name already exists");
      return;
    }

    const matches = data.imageData.match(/^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/);
    if (!matches) {
      socket.emit("emote-error", "Invalid image data (only PNG, JPEG, GIF, WebP allowed)");
      return;
    }

    const ext = matches[1];
    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.length > 2 * 1024 * 1024) {
      socket.emit("emote-error", "File too large (max 2MB)");
      return;
    }

    const fileName = `${data.name}.${ext}`;
    try {
      saveEmoteFile(fileName, buffer);

      const emote = {
        name: data.name,
        url: `/emotes/${fileName}`,
        type: data.type,
        uploadedBy: user.username,
        timestamp: Date.now()
      } as TEmote;

      addEmote(data.name, emote);
      emitToAllSockets("emote-added", emote);

      if (logEnabled) {
        log(`${user.username} added emote: ${data.name}`);
      }
    } catch (error) {
      console.error("Error saving emote:", error);
      socket.emit("emote-error", "Failed to save emote");
    }
  });

  socket.on("delete-emote", (emoteName: string) => {
    const emote = emotes.get(emoteName);
    if (!emote) return;

    const user = users.get(socket.id);
    if (!user || emote.uploadedBy !== user.username) {
      socket.emit("emote-error", "You can only delete your own emotes");
      return;
    }

    emotes.delete(emoteName);
    emitToAllSockets("emote-deleted", emoteName);

    if (logEnabled) {
      log(`${user.username} deleted emote: ${emoteName}`);
    }
  });
}
