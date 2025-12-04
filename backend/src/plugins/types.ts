import type { Server, Socket } from 'socket.io';
import type { Server as HttpServer } from 'http';

export interface PluginContext {
  io: Server;
  httpServer: HttpServer;
  channels: Map<string, any>;
  users: Map<string, any>;
  channelMessages: Map<string, any[]>;
  storage: PluginStorage;
  emit: (event: string, data: any) => void;
  emitToChannel: (channelId: string, event: string, data: any) => void;
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

  permissions?: string[];
  dependencies?: string[];
  enabled?: boolean;
}
