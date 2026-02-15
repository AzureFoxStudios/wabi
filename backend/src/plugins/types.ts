import type { Server, Socket } from 'socket.io';
import type { Server as HttpServer } from 'http';

export const PLUGIN_PERMISSIONS = {
  MESSAGES_READ: 'messages.read',
  MESSAGES_WRITE: 'messages.write',
  USERS_READ: 'users.read',
  CHANNELS_READ: 'channels.read',
  CHANNELS_MANAGE: 'channels.manage',
  EVENTS_EMIT: 'events.emit'
} as const;

export type PluginPermission = typeof PLUGIN_PERMISSIONS[keyof typeof PLUGIN_PERMISSIONS];

export interface PluginUsersService {
  list: () => any[];
  getBySocketId: (socketId: string) => any | null;
}

export interface PluginChannelsService {
  list: () => any[];
  getById: (channelId: string) => any | null;
}

export interface PluginMessagesService {
  listByChannel: (channelId: string) => any[];
}

export interface PluginContext {
  io: Server;
  httpServer: HttpServer;
  users?: PluginUsersService;
  channels?: PluginChannelsService;
  messages?: PluginMessagesService;
  storage: PluginStorage;
  emit?: (event: string, data: any) => void;
  emitToChannel?: (channelId: string, event: string, data: any) => void;
  hasPermission: (permission: PluginPermission) => boolean;
}

export interface PluginStorage {
  get: (key: string) => Promise<any>;
  set: (key: string, value: any) => Promise<void>;
  delete: (key: string) => Promise<void>;
  list: () => Promise<string[]>;
}

export interface BackendPlugin {
  name: string;

  // Lifecycle hooks
  onLoad?(ctx: PluginContext): void | Promise<void>;
  onUnload?(ctx: PluginContext): void | Promise<void>;

  // Socket handlers
  onConnection?(socket: Socket, ctx: PluginContext): void;
  onDisconnect?(socket: Socket, ctx: PluginContext): void;

  // Event hooks (tap into core events)
  onMessage?(channelId: string, message: any, ctx: PluginContext): void;
  onChannelCreate?(channel: any, ctx: PluginContext): void;
  onUserJoin?(user: any, ctx: PluginContext): void;
  onUserLeave?(userId: string, ctx: PluginContext): void;

  // Custom socket event handlers
  socketHandlers?: Record<string, (socket: Socket, data: any, ctx: PluginContext) => void>;

  // HTTP routes (optional)
  routes?: {
    method?: 'get' | 'post' | 'put' | 'delete';
    path: string;
    handler: (req: any, res: any) => void;
  }[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;

  backend?: {
    entry: string;
    socketEvents?: string[];
    socketEventPermissions?: Record<string, PluginPermission[]>;
  };

  frontend?: {
    entry: string;
    extensions?: {
      sidebar?: {
        icon: string;
        label: string;
        component: string;
        position?: number;
      };
      channelTypes?: string[];
      commands?: string[];
    };
  };

  permissions?: PluginPermission[];
  dependencies?: string[];
  enabled?: boolean;
}
