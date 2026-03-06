import type { Server, Socket } from 'socket.io';
import type { Server as HttpServer } from 'http';

export type PaymentIntentStatus =
  | 'draft'
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'refunded'
  | 'disputed'
  | 'canceled';

export type PaymentCheckoutMode = 'qr' | 'payment_link' | 'app_switch' | 'redirect' | 'tap_to_pay';

export interface PaymentMethodCapability {
  id: string;
  label: string;
  checkoutModes: PaymentCheckoutMode[];
  countries?: string[];
  currencies?: string[];
  minAmountMinor?: number;
  maxAmountMinor?: number;
  requiresMobile?: boolean;
  requiresDesktop?: boolean;
  estimatedSharePercent?: number;
  enabledByDefault?: boolean;
  notes?: string;
}

export interface PaymentPluginCapabilities {
  pluginId: string;
  providerName: string;
  countries: string[];
  currencies: string[];
  methods: PaymentMethodCapability[];
  nonCustodialOnly: boolean;
  webhookSignatureRequired: boolean;
  supportsRefunds: boolean;
  supportsDisputes: boolean;
  notes?: string;
}

export interface PaymentCreateIntentInput {
  // Optional Wabi-side intent identifier for provider correlation.
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
  metadata?: Record<string, unknown>;
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
  metadata?: Record<string, unknown>;
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
  raw?: Record<string, unknown>;
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
  metadata?: Record<string, unknown>;
}

export interface PaymentRefundInput {
  intentId?: string;
  providerIntentId?: string;
  amountMinor?: number;
  reason?: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface PaymentRefundResult {
  status: Extract<PaymentIntentStatus, 'refunded' | 'failed' | 'pending'>;
  providerRefundId?: string;
  metadata?: Record<string, unknown>;
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

export interface PluginContext {
  io: Server;
  httpServer: HttpServer;
  channels: Map<string, any>;
  users: Map<string, any>;
  channelMessages: Map<string, any[]>;
  storage: PluginStorage;
  logger: PluginLogger;
  emit: (event: string, data: any) => void;
  emitToChannel: (channelId: string, event: string, data: any) => void;
}

export interface PluginLogger {
  debug: (message: string, meta?: Record<string, any>) => void;
  info: (message: string, meta?: Record<string, any>) => void;
  warn: (message: string, meta?: Record<string, any>) => void;
  error: (message: string, meta?: Record<string, any>) => void;
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
  // Mounted under /api/plugins/runtime/:pluginId
  routes?: {
    method?: 'get' | 'post' | 'put' | 'delete';
    path: string;
    handler: (req: any, res: any) => void;
  }[];

  // Payment rail adapter (optional, non-custodial).
  payment?: PaymentPlugin;
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
  firstParty?: boolean;
  security?: {
    threatNotes?: string;
  };
  integrity?: {
    algorithm?: 'sha256';
    checksum?: string;
    signature?: string;
  };
  signer?: {
    keyId?: string;
    publicKey?: string;
    algorithm?: 'ed25519';
  };
  distribution?: {
    source?: 'local' | 'zip' | 'registry';
    registryUrl?: string;
  };
  capabilities?: {
    tier?: 'ui-only' | 'network-limited' | 'tauri-unsafe';
    notes?: string;
  };
  payment?: {
    providerName?: string;
    countries?: string[];
    currencies?: string[];
    methods?: Array<{
      id: string;
      label: string;
      checkoutModes: PaymentCheckoutMode[];
      estimatedSharePercent?: number;
      enabledByDefault?: boolean;
      notes?: string;
    }>;
    nonCustodialOnly?: boolean;
    excludesFedNow?: boolean;
    excludesCbdcRails?: boolean;
  };
  enabled?: boolean;
}
