/**
 * @wabi/plugin-types
 * Shared plugin infrastructure and payment types for backend addons
 *
 * Provides type definitions for:
 * - Backend plugin lifecycle and event handlers
 * - Plugin context, storage, and logging
 * - Payment plugin capabilities and configuration
 * - Payment intent lifecycle (creation, verification, status, refunds)
 * - Webhook handling and event processing
 */

import type { IncomingHttpHeaders, IncomingMessage, Server as HttpServer, ServerResponse } from 'http';
import type { Server, Socket } from 'socket.io';
import type { ClientMessage } from '../../../shared/messageRetention.js';
import type {
  PaymentCheckoutMode,
  PaymentIntentStatus,
  PaymentMethodCapability,
  PaymentProviderCapability
} from '../../../shared/paymentContracts.js';

// ============================================================================
// TYPE RE-EXPORTS
// ============================================================================

export type {
  PaymentCheckoutMode,
  PaymentIntentStatus,
  PaymentMethodCapability,
  PaymentProviderCapability
} from '../../../shared/paymentContracts.js';

// ============================================================================
// UTILITY TYPES
// ============================================================================

export type JsonPrimitive = string | number | boolean | null;
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export type PluginSocketPayload = JsonValue | Buffer;
export type PluginHttpSendPayload = JsonValue | string | Buffer;
export type PluginLoggerMeta = Record<string, JsonValue | undefined>;

// ============================================================================
// PLUGIN RUNTIME TYPES
// ============================================================================

export interface PluginChannel {
  id: string;
  name: string;
  description?: string;
  watchQueueEnabled?: boolean;
  minRole?: string;
  createdAt: number;
  type?: 'text' | 'voice' | 'dm' | 'group' | 'public' | 'thread_public' | 'thread_private';
  members?: string[];
  parentChannelId?: string;
  isBreakout?: boolean;
  breakoutIndex?: number;
  parentMessageId?: string;
  threadArchived?: boolean;
  threadLocked?: boolean;
  threadAutoArchiveMinutes?: number;
  threadLastActivityAt?: number;
  autoDeleteAfter?: string | null;
  isTemporary?: boolean;
  persistMessages?: boolean;
  pinnedBy?: string[];
  recipientNotified?: boolean;
  voiceSettings?: {
    bitrateMode?: 'auto' | 'low' | 'standard' | 'high';
    userLimit?: number | null;
    forceSolo?: boolean;
  };
}

export interface PluginUser {
  id: string;
  username: string;
  handle?: string;
  color: string;
  status: 'active' | 'away' | 'busy';
  profilePicture?: string;
  joinedAt?: number;
  workspaceId?: string;
  dbUserId?: number;
  roles?: string[];
  highestRole?: string;
  roleColor?: string | null;
  usernameFont?: {
    family?: string;
    size?: string;
    weight?: string;
    style?: string;
  };
}

export type PluginChannelMessage = ClientMessage & {
  senderStableId?: string;
  scheduledDeletionTime?: number;
};

export interface PluginHttpRequest {
  raw: IncomingMessage;
  method: string;
  headers: IncomingHttpHeaders;
  url: string;
  path: string;
  query: Record<string, string>;
  params: {
    pluginId: string;
    path: string;
  };
  json: <T = JsonObject>() => Promise<T>;
  text: () => Promise<string>;
  buffer: () => Promise<Buffer>;
}

export interface PluginHttpResponse {
  raw: ServerResponse;
  status: (code: number) => PluginHttpResponse;
  setHeader: (name: string, value: string) => PluginHttpResponse;
  set: (name: string, value: string) => PluginHttpResponse;
  json: (payload: JsonValue) => void;
  send: (payload: PluginHttpSendPayload) => void;
  end: (payload?: string | Buffer) => void;
}

export interface PluginRuntimeContext {
  channels: Map<string, PluginChannel>;
  users: Map<string, PluginUser>;
  channelMessages: Map<string, PluginChannelMessage[]>;
  emitToChannel: (channelId: string, event: string, data: PluginSocketPayload) => void;
}

export interface PluginLogger {
  debug: (message: string, meta?: PluginLoggerMeta) => void;
  info: (message: string, meta?: PluginLoggerMeta) => void;
  warn: (message: string, meta?: PluginLoggerMeta) => void;
  error: (message: string, meta?: PluginLoggerMeta) => void;
}

export interface PluginStorage {
  get: <T = JsonValue>(key: string) => Promise<T | null>;
  set: (key: string, value: JsonValue) => Promise<void>;
  delete: (key: string) => Promise<void>;
  list: () => Promise<string[]>;
}

export interface PluginContext extends PluginRuntimeContext {
  io: Server;
  httpServer: HttpServer;
  storage: PluginStorage;
  logger: PluginLogger;
  emit: (event: string, data: PluginSocketPayload) => void;
}

// ============================================================================
// PAYMENT TYPES
// ============================================================================

export interface PaymentPluginCapabilities extends PaymentProviderCapability {}

export interface PaymentCreateIntentInput {
  intentId?: string;
  workspaceId?: string;
  channelId?: string;
  createdByUserId?: number;
  amountMinor: number;
  currency: string;
  countryCode?: string;
  methodId: string;
  description?: string;
  customerRef?: string;
  idempotencyKey: string;
  metadata?: JsonObject;
}

export type PaymentPresentationData =
  | {
      mode: 'qr';
      qrData: string;
      qrFormat?: 'raw' | 'emvco' | 'image_url' | 'base64_png';
      qrImageUrl?: string;
      deepLinkUrl?: string;
      expiresAt?: number;
    }
  | {
      mode: 'payment_link' | 'redirect';
      url: string;
      expiresAt?: number;
    }
  | {
      mode: 'app_switch';
      deepLinkUrl: string;
      fallbackUrl?: string;
      universalLinkUrl?: string;
      packageName?: string;
      expiresAt?: number;
    }
  | {
      mode: 'tap_to_pay';
      providerSessionId: string;
      instructions?: string;
      expiresAt?: number;
    };

export interface PaymentCreateIntentResult {
  providerIntentId: string;
  status: PaymentIntentStatus;
  checkoutMode: PaymentCheckoutMode;
  presentation: PaymentPresentationData;
  expiresAt?: number;
  metadata?: JsonObject;
}

export interface PaymentProviderEvent {
  eventId: string;
  eventType: string;
  intentId?: string;
  providerIntentId?: string;
  status?: PaymentIntentStatus;
  amountMinor?: number;
  currency?: string;
  occurredAt: number;
  idempotencyKey?: string;
  raw?: JsonObject;
}

export interface PaymentVerifyWebhookInput {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  query?: Record<string, string | string[] | undefined>;
}

export interface PaymentWebhookVerificationResult {
  valid: boolean;
  reason?: string;
  event?: PaymentProviderEvent;
}

export interface PaymentGetIntentStatusInput {
  intentId?: string;
  providerIntentId?: string;
}

export interface PaymentGetIntentStatusResult {
  status: PaymentIntentStatus;
  providerIntentId?: string;
  amountMinor?: number;
  currency?: string;
  metadata?: JsonObject;
}

export interface PaymentRefundInput {
  intentId?: string;
  providerIntentId?: string;
  amountMinor?: number;
  reason?: string;
  idempotencyKey: string;
  metadata?: JsonObject;
}

export interface PaymentRefundResult {
  status: Extract<PaymentIntentStatus, 'refunded' | 'failed' | 'pending'>;
  providerRefundId?: string;
  metadata?: JsonObject;
}

export interface PaymentPlugin {
  getCapabilities(ctx: PluginContext): Promise<PaymentPluginCapabilities> | PaymentPluginCapabilities;
  createIntent(ctx: PluginContext, input: PaymentCreateIntentInput): Promise<PaymentCreateIntentResult> | PaymentCreateIntentResult;
  verifyWebhook(
    ctx: PluginContext,
    input: PaymentVerifyWebhookInput
  ): Promise<PaymentWebhookVerificationResult> | PaymentWebhookVerificationResult;
  getIntentStatus?(
    ctx: PluginContext,
    input: PaymentGetIntentStatusInput
  ): Promise<PaymentGetIntentStatusResult> | PaymentGetIntentStatusResult;
  refundIntent?(ctx: PluginContext, input: PaymentRefundInput): Promise<PaymentRefundResult> | PaymentRefundResult;
}

// ============================================================================
// BACKEND PLUGIN INTERFACE
// ============================================================================

export interface BackendPlugin {
  name: string;

  onLoad?(ctx: PluginContext): void | Promise<void>;
  onUnload?(ctx: PluginContext): void | Promise<void>;

  onConnection?(socket: Socket, ctx: PluginContext): void;
  onDisconnect?(socket: Socket, ctx: PluginContext): void;

  onMessage?(channelId: string, message: PluginChannelMessage, ctx: PluginContext): void | Promise<void>;
  onChannelCreate?(channel: PluginChannel, ctx: PluginContext): void | Promise<void>;
  onUserJoin?(user: PluginUser, ctx: PluginContext): void | Promise<void>;
  onUserLeave?(userId: string, ctx: PluginContext): void;

  socketHandlers?: Record<string, (socket: Socket, data: PluginSocketPayload, ctx: PluginContext) => void | Promise<void>>;

  routes?: {
    method?: 'get' | 'post' | 'put' | 'delete';
    path: string;
    handler: (req: PluginHttpRequest, res: PluginHttpResponse) => void | Promise<void>;
  }[];

  payment?: PaymentPlugin;
}
