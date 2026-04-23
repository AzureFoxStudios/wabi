import { Server } from "socket.io";
import { createServer } from "http";
import { readFileSync, existsSync, writeFileSync, mkdirSync, createReadStream, openSync, closeSync, writeSync, readdirSync, unlinkSync, statSync } from "fs";
import { readFile as readFileAsync, stat as statAsync, unlink as unlinkAsync, open as openFileAsync } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";
import { PluginLoader } from "./plugins/loader";
import {
  createEmptyBusinessData,
  sanitizeBusinessData,
  sanitizeBusinessResourceCreate,
  sanitizeBusinessResourceUpdate,
  type BusinessData
} from "./business/validation.js";
import { getAllEmojis, getEmojiByName, addCustomEmoji, deleteCustomEmoji, type Emoji } from "./emojis";

import { __dirname } from "./_dirname.js";
import db, { initializeDatabase, closeDatabase } from "./db/database.js";
import { type DbChannel } from "./db/repositories/channelRepository.js";
import { offlineMessageRepository } from "./db/repositories/offlineMessageRepository.js";
import { messageRepository, type ClientMessage, type DbMessage, type MessageEntity } from "./db/repositories/messageRepository.js";
import { settingsRepository } from "./db/repositories/settingsRepository.js";
import { themeRepository } from "./db/repositories/themeRepository.js";
import { guestCodeRepository } from "./db/repositories/guestCodeRepository.js";
import {
  whiteboardRepository,
  type WhiteboardRecord
} from "./db/repositories/whiteboardRepository.js";
import { verifyToken } from "./auth/jwt.js";
import { getAuthenticatedUserIdFromRequest, getAuthTokenFromHeaders } from "./auth/requestAuth.js";
import {
  handleRegister,
  handleLogin,
  handleUpgrade,
  handleGetUserSettings,
  handleSaveUserSettings,
  handleGetPublicKey,
  handleStoreEncryptionKeys,
  handleChangePassword,
  handleAdminResetUserPassword,
  handleAdminClearLoginLockout
} from "./api/authRoutes.js";
import { handleGetThemePreferences, handleSaveThemePreferences, handleResetThemePreferences } from "./api/themeRoutes.js";
import { handleGetLaunchPageConfig } from "./api/launchPageRoutes.js";
import {
  handleGetRelays,
  handleRelayRegister,
  handleRelayHealth,
  handleRelayApprove,
  handleGetAllRelays,
  handleRelayDelete,
  handleDesktopHelperRegister,
  handleDesktopHelperHeartbeat,
  handleDesktopHelperOffline
} from "./api/relayRoutes.js";
import {
  handleGetMediaRuntime,
  handleGetTurnCredentials,
  handleCreateLivekitToken,
  handleMediaGatewayHeartbeat,
  handleCreateMediaGatewaySession,
  handleListMediaGatewaySessions,
  handleGetMediaGatewaySession,
  handleCloseMediaGatewaySession,
  handleRenewMediaGatewaySession,
  handleGetMediaGatewayControlSessions
} from "./api/mediaRoutes.js";
import {
  handleCreateWebhook,
  handleListWebhooks,
  handleDeleteWebhook,
  handleListWebhookDeliveries,
  handleUpdateWebhook,
  handleRotateWebhookSecret,
  handleTestWebhook,
  handleGetWebhookDelivery,
  handleRetryWebhookDelivery
} from "./api/webhookRoutes.js";
import {
  handleCancelPaymentIntent,
  handleCreateAdminOfflineDonation,
  handleCreatePaymentIntent,
  handleDeletePaymentAccountLink,
  handleDeletePaymentUserBlock,
  handleGetPaymentAccess,
  handleGetPaymentAccessPolicy,
  handleGetPaymentDonationConfig,
  handleGetPaymentDonationSummary,
  handleGetPaymentIntent,
  handleListAdminOfflineDonations,
  handleListAdminPaymentDonations,
  handleListPaymentAccountLinks,
  handleListPaymentHistory,
  handleListPaymentUserBlocks,
  handleListPaymentProviders,
  handlePaymentWebhook,
  handleRefundAdminPaymentDonation,
  handleSavePaymentAccessPolicy,
  handleSavePaymentDonationConfig,
  handleUpsertPaymentAccountLink,
  handleUpsertPaymentUserBlock,
  handleVoidAdminOfflineDonation
} from "./api/paymentRoutes.js";
import {
  handleCancelManualCashSettlement,
  handleConfirmManualCashSettlement,
  handleCreateManualCashSettlement,
  handleDisputeManualCashSettlement,
  handleListManualCashSettlements
} from "./api/manualSettlementRoutes.js";
import { handlePollFollowedChannelActivity } from "./api/followRoutes.js";
import { handleDictionaryLookup, handleDictionaryUpsert, handleDictionaryDelete } from "./api/dictionaryRoutes.js";
import { getPlaceRecordById, handleDeletePlace, handleGetPlaces, handleUpsertPlace, isKnownPlaceId } from "./api/placeRoutes.js";
import {
  handleListAlbums,
  handleCreateAlbum,
  handleListAlbumItems,
  handleAddAlbumItem,
  handleSetAlbumFeatured,
  handleReorderAlbumItems,
  handleDeleteAlbum,
  handleDeleteAlbumItem
} from "./api/albumRoutes.js";
import {
  cloneDefaultAlbumUploadLimits,
  sanitizeAlbumUploadLimitConfig,
  type AlbumUploadLimitConfig
} from "./services/albumUploadLimits.js";
import type {
  DownloadLimitConfig,
  RuntimeTuningConfig,
  UploadLimitConfig,
  UploadRoleTier
} from "../../shared/runtimeAdminContracts.js";
import {
  DEFAULT_DM_RETENTION,
  messageRetentionToMs,
  normalizeMessageRetentionDuration,
  type MessageRetentionDuration
} from "../../shared/messageRetention.js";
import { handleRuntimeAdminRoutes } from "./api/runtimeAdminRoutes.js";
import { handleUploadRoutes } from "./api/uploadRoutes.js";
import { relayRepository } from "./db/repositories/relayRepository.js";
import { corsCallback, getCORSHeaders, getAllowedOrigins, isOriginAllowed } from "./config/cors.js";
import { appPolicyRepository } from "./db/repositories/appPolicyRepository.js";
import {
  cloneDefaultCommunityNodeAnnouncementsPolicy,
  registerCommunityNodeAnnouncementDispatcher,
  sanitizeCommunityNodeAnnouncementsPolicy,
  type CommunityNodeAnnouncementsPolicy
} from "./communityNodeAnnouncements.js";
import {
  cloneDefaultCommunityNodeAccessPolicy,
  sanitizeCommunityNodeAccessPolicy
} from "./communityNodeAccess.js";
import {
  cloneDefaultFrontendAppMetadataPolicy,
  sanitizeFrontendAppMetadataPolicy,
  type FrontendAppMetadataPolicy
} from "./frontendAppMetadata.js";
import { getUserRoles, assignRole, removeRole } from "./auth/roleMiddleware.js";
import {
  DEFAULT_PAYMENT_ACCESS_POLICY,
  getPaymentAccessPolicyBootstrapFromEnv,
  sanitizePaymentAccessPolicy,
  type PaymentAccessPolicy
} from "./payments/accessPolicy.js";
import { setPaymentRealtimeNotifier } from "./payments/realtime.js";
import {
  stateUserStore as userRepository,
  stateSessionStore as sessionRepository,
  stateRbacStore,
  stateChannelStore as channelRepository,
  stateChannelMemberStore as channelMemberRepository,
  stateMessageStore,
  getStatePlaneConfigFromEnv,
  getStatePlaneRuntimeStats,
  configureStateMeshRuntime,
  startStateMeshRuntime,
  stopStateMeshRuntime,
  registerStateMeshSocketLease,
  releaseStateMeshSocketLease,
  findStateMeshSocketLeaseByStableUserId,
  getCurrentStateMeshInstanceId,
  listActiveStateMeshInstanceLeases,
  sendStateMeshRemoteDelivery,
  upsertStateMeshPresenceLease,
  deleteStateMeshPresenceLease,
  listStateMeshPresenceLeases,
  startStatePlaneRuntime,
  stopStatePlaneRuntime,
  recordStatePlaneEvent,
  stateReducerIngress
} from "./state-plane/index.js";
import { dispatchWebhookEvent } from "./webhooks/deliveryService.js";
import {
  getCompressionMetricsSnapshot,
  recordClientVideoCompressionSample,
  recordCompressionDownloadSample,
  recordCompressionUploadSample,
  resetCompressionMetrics
} from "./observability/compressionMetrics.js";
import { startSelfHostedBoosterRelayAdvertiser } from "./relay/selfHostedBoosterRelay.js";
import {
  getRuntimeGuardrailsSnapshot,
  initRuntimeGuardrails
} from "./observability/runtimeGuardrails.js";
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
import {
  HTTP_TEXT_COMPRESSION_BROTLI_QUALITY,
  HTTP_TEXT_COMPRESSION_ENABLED,
  HTTP_TEXT_COMPRESSION_GZIP_LEVEL,
  HTTP_TEXT_COMPRESSION_MIN_BYTES,
  maybeCompressTextResponse
} from "./utils/httpCompression.js";
import {
  isInvalidJsonBodyError,
  isRequestBodyTooLargeError,
  parseBooleanRequestValue,
  readJsonObjectBody,
  readRequestBuffer,
  readMultipartSingleFile
} from "./utils/requestBodies.js";
import { fetchExternalUrlWithGuards } from "./utils/safeExternalFetch.js";
import {
  cleanupWhiteboardOrphanUploads,
  createUploadFileId,
  createWhiteboardUploadFileId,
  createWhiteboardUploadUrl,
  decodePathSegment,
  deleteUploadFileByUrl,
  ensureUploadDirectories,
  FILE_ENCRYPTION_KEY,
  getFileExtension,
  getMimeTypeFromDataUrl,
  getUploadOwnerKey,
  getUploadTokenFromRequest,
  getUploadedBytes,
  isAtRestEncryptedBuffer,
  isSafeRasterImageUpload,
  isWhiteboardUploadFileIdForBoard,
  loadResumableMeta,
  maybeCompressUploadPayloadNonBlocking,
  maybeDecompressUploadPayload,
  maybeDecryptFromAtRest,
  normalizeClientFileAttachment,
  normalizeClientUploadUrl,
  normalizeUploadFileIdSegment,
  normalizeUploadFileIdFromUrl,
  resolveUploadPath,
  sanitizeUploadFileName,
  saveResumableMeta,
  signUploadToken,
  UPLOAD_COMPRESSION_ENABLED,
  UPLOAD_COMPRESSION_GZIP_LEVEL,
  UPLOAD_COMPRESSION_MIN_BYTES,
  UPLOAD_COMPRESSION_ROLLOUT_PERCENT,
  verifyUploadToken,
  writeUploadFileNonBlocking,
  type AttachmentEncryptionMeta,
  type AttachmentStorageMeta,
  type ResumableUploadMeta
} from "./services/uploadSupport.js";
import {
  buildWorkspaceRoleLookup,
  getRoleDefinitions,
  getRolePriority,
  getUserRoleInfo,
  type WorkspaceRoleLookup
} from "./services/roleLookup.js";
import {
  createPresenceMeshRuntime,
  type ActiveUserRecord
} from "./services/presenceMeshRuntime.js";
import { registerChannelMutationHandlers } from "./services/channelMutationHandlers.js";
import { registerConversationChannelHandlers } from "./services/conversationChannelHandlers.js";
import { registerPeerRelayHandlers } from "./services/peerRelayHandlers.js";
import {
  createDirectCallRuntime
} from "./services/directCallRuntime.js";
import { createDirectCallLifecycle } from "./services/directCallLifecycle.js";
import { registerCallSignalRelayHandlers } from "./services/callSignalRelayHandlers.js";
import { registerCallSocketHandlers } from "./services/callSocketHandlers.js";
import {
  createMessageLifecycle,
  type RealtimeChannelMessage
} from "./services/messageLifecycle.js";
import { registerMessageInteractionHandlers } from "./services/messageInteractionHandlers.js";
import { registerMessagePipelineHandlers } from "./services/messagePipelineHandlers.js";
import {
  createGroupCallRuntime
} from "./services/groupCallRuntime.js";
import { createGroupCallLifecycle } from "./services/groupCallLifecycle.js";
import { createUploadFileServing } from "./services/uploadFileServing.js";
import { registerDisconnectCleanupHandler } from "./services/disconnectCleanupHandler.js";
import { registerJoinInitializationHandler } from "./services/joinInitializationHandler.js";
import { deliverOfflineMessagesToSocket } from "./services/offlineMessageDelivery.js";
import { registerSessionProfileHandlers } from "./services/sessionProfileHandlers.js";
import { registerSocketAssetHandlers } from "./services/socketAssetHandlers.js";
import { buildServerMembersSnapshot as buildServerMembersSnapshotView, enrichDmChannels as enrichDmChannelsView, loadUserChannelsFromDb } from "./services/userChannelViews.js";
import { createVoiceChannelRuntime } from "./services/voiceChannelRuntime.js";
import { createVoiceRecordingRuntime } from "./services/voiceRecordingRuntime.js";
import { registerRoleModerationHandlers } from "./services/roleModerationHandlers.js";
import { registerVoiceBreakoutHandlers } from "./services/voiceBreakoutHandlers.js";
import { registerVoiceSocketHandlers } from "./services/voiceSocketHandlers.js";
import { createSocketChannelGuards } from "./services/socketChannelGuards.js";
import { disconnectOtherRegisteredSockets as disconnectOtherRegisteredSocketsForSocket } from "./services/registeredSocketSessions.js";
import { createRoleRuntimeSupport } from "./services/roleRuntimeSupport.js";
import { applySocketRateLimiting } from "./services/socketRateLimit.js";
import { getAccessibleWhiteboardForRequest as resolveAccessibleWhiteboardForRequest } from "./services/whiteboardAccess.js";
import { registerWhiteboardSocketHandlers } from "./services/whiteboardSocketHandlers.js";

type UploadLimitBytes = number | null;

type PolicyKey =
  | 'upload_limits'
  | 'download_limits'
  | 'runtime_tuning'
  | 'album_upload_limits'
  | 'payments_access'
  | 'community_node_announcements'
  | 'community_node_access'
  | 'frontend_app_metadata';
const UPLOAD_LIMITS_POLICY_KEY: PolicyKey = 'upload_limits';
const RUNTIME_TUNING_POLICY_KEY: PolicyKey = 'runtime_tuning';
const ALBUM_UPLOAD_LIMITS_POLICY_KEY: PolicyKey = 'album_upload_limits';
const PAYMENTS_ACCESS_POLICY_KEY: PolicyKey = 'payments_access';
const COMMUNITY_NODE_ANNOUNCEMENTS_POLICY_KEY: PolicyKey = 'community_node_announcements';
const FRONTEND_APP_METADATA_POLICY_KEY: PolicyKey = 'frontend_app_metadata';
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

const DEFAULT_RUNTIME_TUNING_CONFIG: RuntimeTuningConfig = {
  applyOnRestart: true,
  threadPoolSize: null,
  heavyProfilingEnabled: false,
  heavyProfilingSampleRate: 0.1
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

function cloneDefaultRuntimeTuning(): RuntimeTuningConfig {
  return {
    ...DEFAULT_RUNTIME_TUNING_CONFIG
  };
}

function cloneDefaultPaymentAccessPolicy(): PaymentAccessPolicy {
  return {
    ...DEFAULT_PAYMENT_ACCESS_POLICY,
    allowedRoleNames: [...DEFAULT_PAYMENT_ACCESS_POLICY.allowedRoleNames]
  };
}

function normalizeLimitValue(value: unknown): UploadLimitBytes {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function normalizeCountValue(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function sanitizeUploadLimitConfig(raw: unknown): UploadLimitConfig {
  const config = cloneDefaultUploadLimits();
  if (!raw || typeof raw !== 'object') return config;

  const input = raw as Partial<UploadLimitConfig>;
  const perRole = input.perRoleBytes as Partial<Record<UploadRoleTier, unknown>> | undefined;
  if (perRole && typeof perRole === 'object') {
    for (const tier of ['new', 'trusted', 'moderator', 'admin', 'owner'] as UploadRoleTier[]) {
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
  const perRole = input.perRoleBytes as Partial<Record<UploadRoleTier, unknown>> | undefined;
  if (perRole && typeof perRole === 'object') {
    for (const tier of ['new', 'trusted', 'moderator', 'admin', 'owner'] as UploadRoleTier[]) {
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

function normalizeThreadPoolSize(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const int = Math.floor(n);
  if (int < 1) return null;
  return Math.min(64, int);
}

function sanitizeRuntimeTuningConfig(raw: unknown): RuntimeTuningConfig {
  const config = cloneDefaultRuntimeTuning();
  if (!raw || typeof raw !== 'object') return config;
  const input = raw as Partial<Record<keyof RuntimeTuningConfig, unknown>>;
  config.threadPoolSize = normalizeThreadPoolSize(input.threadPoolSize);
  config.heavyProfilingEnabled = Boolean(input.heavyProfilingEnabled);
  const sampleRate = Number(input.heavyProfilingSampleRate);
  config.heavyProfilingSampleRate = Number.isFinite(sampleRate)
    ? Math.max(0.01, Math.min(1, sampleRate))
    : DEFAULT_RUNTIME_TUNING_CONFIG.heavyProfilingSampleRate;
  config.applyOnRestart = true;
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
  },
  runtime_tuning: {
    defaultValue: cloneDefaultRuntimeTuning(),
    sanitize: sanitizeRuntimeTuningConfig
  },
  album_upload_limits: {
    defaultValue: cloneDefaultAlbumUploadLimits(),
    sanitize: sanitizeAlbumUploadLimitConfig
  },
  payments_access: {
    defaultValue: cloneDefaultPaymentAccessPolicy(),
    sanitize: sanitizePaymentAccessPolicy
  },
  community_node_announcements: {
    defaultValue: cloneDefaultCommunityNodeAnnouncementsPolicy(),
    sanitize: sanitizeCommunityNodeAnnouncementsPolicy
  },
  community_node_access: {
    defaultValue: cloneDefaultCommunityNodeAccessPolicy(),
    sanitize: sanitizeCommunityNodeAccessPolicy
  },
  [FRONTEND_APP_METADATA_POLICY_KEY]: {
    defaultValue: cloneDefaultFrontendAppMetadataPolicy(),
    sanitize: sanitizeFrontendAppMetadataPolicy
  }
};

function isKnownPolicyKey(value: string): value is PolicyKey {
  return Object.prototype.hasOwnProperty.call(POLICY_DEFINITIONS, value);
}

const policyCache = new Map<string, { value: unknown; cachedAt: number }>();
const POLICY_CACHE_TTL_MS = 60_000;

function getPolicyValue<TValue>(key: PolicyKey): TValue {
  const now = Date.now();
  const cached = policyCache.get(key);
  if (cached && (now - cached.cachedAt) < POLICY_CACHE_TTL_MS) {
    return cached.value as TValue;
  }
  const definition = POLICY_DEFINITIONS[key] as PolicyDefinition<TValue>;
  const raw = appPolicyRepository.getRaw(`policy:${key}`);
  let value: TValue;
  if (!raw) {
    value = definition.defaultValue;
  } else {
    try {
      value = definition.sanitize(JSON.parse(raw));
    } catch (error) {
      console.warn(`[Policies] Failed to parse policy '${key}'; falling back to defaults`);
      value = definition.defaultValue;
    }
  }
  policyCache.set(key, { value, cachedAt: now });
  return value;
}

function collectFrontendMetadataUploadUrls(policy: FrontendAppMetadataPolicy | null | undefined): Set<string> {
  const urls = new Set<string>();
  const normalizedIconUrl = normalizeClientUploadUrl(policy?.iconUrl);
  if (normalizedIconUrl) {
    urls.add(normalizedIconUrl);
  }
  const normalizedBannerUrl = normalizeClientUploadUrl(policy?.bannerUrl);
  if (normalizedBannerUrl) {
    urls.add(normalizedBannerUrl);
  }
  return urls;
}

function cleanupReplacedFrontendMetadataUploads(
  previousPolicy: FrontendAppMetadataPolicy | null | undefined,
  nextPolicy: FrontendAppMetadataPolicy
): void {
  const previousUrls = collectFrontendMetadataUploadUrls(previousPolicy);
  if (previousUrls.size === 0) return;
  const nextUrls = collectFrontendMetadataUploadUrls(nextPolicy);
  for (const previousUrl of previousUrls) {
    if (!nextUrls.has(previousUrl)) {
      deleteUploadFileByUrl(previousUrl, FRONTEND_APP_METADATA_POLICY_KEY);
    }
  }
}

function savePolicyValue<TValue>(key: PolicyKey, rawInput: unknown): TValue {
  const definition = POLICY_DEFINITIONS[key] as PolicyDefinition<TValue>;
  const previousFrontendMetadata =
    key === FRONTEND_APP_METADATA_POLICY_KEY
      ? getPolicyValue<FrontendAppMetadataPolicy>(FRONTEND_APP_METADATA_POLICY_KEY)
      : null;
  const sanitized = definition.sanitize(rawInput);
  appPolicyRepository.setRaw(`policy:${key}`, JSON.stringify(sanitized));
  policyCache.delete(key);
  if (key === FRONTEND_APP_METADATA_POLICY_KEY) {
    cleanupReplacedFrontendMetadataUploads(
      previousFrontendMetadata,
      sanitized as FrontendAppMetadataPolicy
    );
  }
  return sanitized;
}

function getPolicyDefaults<TValue>(key: PolicyKey): TValue {
  const definition = POLICY_DEFINITIONS[key] as PolicyDefinition<TValue>;
  return definition.defaultValue;
}

// Initialize database before any policy/settings queries
initializeDatabase();

const paymentAccessBootstrap = getPaymentAccessPolicyBootstrapFromEnv();
if (paymentAccessBootstrap.mode !== 'off') {
  const paymentsPolicyStorageKey = `policy:${PAYMENTS_ACCESS_POLICY_KEY}`;
  const hasStoredPaymentPolicy = appPolicyRepository.getRaw(paymentsPolicyStorageKey) !== null;
  if (paymentAccessBootstrap.mode === 'force' || !hasStoredPaymentPolicy) {
    appPolicyRepository.setRaw(paymentsPolicyStorageKey, JSON.stringify(paymentAccessBootstrap.policy));
    console.log(
      `[Payments] ${
        hasStoredPaymentPolicy ? 'Applied' : 'Seeded'
      } access policy from env bootstrap (mode=${paymentAccessBootstrap.mode}, enabled=${paymentAccessBootstrap.policy.enabled}, allowGuest=${paymentAccessBootstrap.policy.allowGuest}, roles=${paymentAccessBootstrap.policy.allowedRoleNames.join(',') || 'none'})`
    );
  }
}

const startupRuntimeTuning = getPolicyValue<RuntimeTuningConfig>(RUNTIME_TUNING_POLICY_KEY);
if (!process.env.UV_THREADPOOL_SIZE && startupRuntimeTuning.threadPoolSize) {
  process.env.UV_THREADPOOL_SIZE = String(startupRuntimeTuning.threadPoolSize);
}
void initRuntimeGuardrails({
  heavyProfilingEnabled: startupRuntimeTuning.heavyProfilingEnabled
});

function resolveUploadRoleTier(userId: number | null, guestSessionId: string | null): UploadRoleTier {
  if (!userId) return guestSessionId ? 'new' : 'new';
  const roles = getUserRoles(userId, 'default-workspace');
  if (roles.includes('owner')) return 'owner';
  if (roles.includes('admin')) return 'admin';
  if (roles.includes('mod')) return 'moderator';
  return 'trusted';
}

function getEffectiveUploadCapBytes(roleTier: UploadRoleTier, config: UploadLimitConfig): UploadLimitBytes {
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
  watchQueueEnabled?: boolean;
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
  autoDeleteAfter?: MessageRetentionDuration | null;
  isTemporary?: boolean;
  persistMessages?: boolean; // Opt-in flag for message persistence
  pinnedBy?: string[]; // Array of user IDs who have pinned this channel
  recipientNotified?: boolean;
  voiceSettings?: {
    bitrateMode?: 'auto' | 'low' | 'standard' | 'high';
    userLimit?: number | null;
    forceSolo?: boolean;
  };
}

function normalizeChannelType(raw?: string): 'text' | 'voice' | 'dm' | 'group' | 'thread_public' | 'thread_private' {
  if (raw === 'voice' || raw === 'dm' || raw === 'group' || raw === 'text' || raw === 'thread_public' || raw === 'thread_private') return raw;
  return 'text'; // legacy 'public' and undefined map to text
}

function resolvePersistedChannelRetention(
  rawValue: string | null | undefined,
  channelType?: string | null
): MessageRetentionDuration | null {
  const normalized = normalizeMessageRetentionDuration(rawValue);
  if (normalized) return normalized;
  return channelType === 'dm' || channelType === 'group' ? DEFAULT_DM_RETENTION : null;
}

const channels = new Map<string, Channel>();
channels.set('general', { id: 'general', name: 'general', createdAt: Date.now(), type: 'text' });
channels.set('voice', { id: 'voice', name: 'voice', createdAt: Date.now(), type: 'voice' });

const channelMessages = new Map<string, RealtimeChannelMessage[]>();

// Initialize general channel with empty messages
channelMessages.set('general', []);
channelMessages.set('voice', []);

const pinnedMessages = new Map<string, Set<string>>(); // channelId -> Set of messageIds
pinnedMessages.set('general', new Set());
pinnedMessages.set('voice', new Set());

const messagePersistenceRetryAttempts = new Map<string, number>();
let realtimeMessageSequence = 0;

function createRealtimeMessageId(senderStableId: string): string {
  realtimeMessageSequence = (realtimeMessageSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${realtimeMessageSequence.toString(36)}-${senderStableId}`;
}

function formatMessagePersistenceError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  const detail = String(error || '').trim();
  return detail || 'Unknown persistence error';
}

function buildPersistedMessageFromRealtime(
  channelId: string,
  message: RealtimeChannelMessage
): Omit<DbMessage, 'id' | 'deleted_at'> {
  return {
    message_id: message.id,
    channel_id: channelId,
    sender_id: message.senderStableId || message.userId,
    sender_username: message.user,
    sender_color: message.color,
    message_type: message.type,
    content: message.text,
    gif_url: message.gifUrl,
    file_url: message.fileUrl,
    file_name: message.fileName,
    file_size: message.fileSize,
    files_json: message.files ? JSON.stringify(message.files) : undefined,
    entities_json: message.entities ? JSON.stringify(message.entities) : undefined,
    attachment_encryption_json: message.attachmentEncryption ? JSON.stringify(message.attachmentEncryption) : undefined,
    attachment_storage_json: message.attachmentStorage ? JSON.stringify(message.attachmentStorage) : undefined,
    reply_to_id: message.replyTo,
    is_spoiler: message.isSpoiler ? 1 : 0,
    is_pinned: message.isPinned ? 1 : 0,
    is_edited: message.isEdited ? 1 : 0,
    is_encrypted: message.encrypted ? 1 : 0,
    encryption_iv: message.iv || undefined,
    created_at: message.timestamp,
    expires_at: message.scheduledDeletionTime
  };
}

function buildOfflineDeliveryClientMessage(
  channelId: string,
  message: RealtimeChannelMessage
): ClientMessage {
  const clientMessage = messageRepository.toClientFormat({
    ...buildPersistedMessageFromRealtime(channelId, message)
  } as DbMessage);

  clientMessage.senderStableId = message.senderStableId || clientMessage.userId;
  return clientMessage;
}

function queueOfflineConversationMessages(
  channelId: string,
  message: RealtimeChannelMessage,
  sender: { username: string; dbUserId?: number },
  senderStableId: string
): number[] {
  const channel = channels.get(channelId);
  if (!channel || !Array.isArray(channel.members)) return [];
  if (channel.type !== 'dm' && channel.type !== 'group') return [];

  const queuedMessage = buildOfflineDeliveryClientMessage(channelId, {
    ...message,
    senderStableId: message.senderStableId || senderStableId
  });
  const queuedRecipientDbUserIds: number[] = [];
  const seenRecipients = new Set<number>();

  for (const memberId of channel.members) {
    if (!memberId || memberId === senderStableId || !memberId.startsWith('user-')) {
      continue;
    }

    const recipientDbUserId = Number.parseInt(memberId.substring(5), 10);
    if (!Number.isFinite(recipientDbUserId) || seenRecipients.has(recipientDbUserId)) {
      continue;
    }
    if (isStableUserConnected(memberId)) {
      continue;
    }
    if (!sender.dbUserId && !settingsRepository.allowsTempMessages(recipientDbUserId)) {
      continue;
    }

    const retentionMs = settingsRepository.getRetentionMs(recipientDbUserId);
    const expiresAt =
      retentionMs >= Number.MAX_SAFE_INTEGER / 2
        ? Number.MAX_SAFE_INTEGER
        : Date.now() + retentionMs;

    try {
      offlineMessageRepository.queue({
        from_user_id: sender.dbUserId,
        from_username: sender.username,
        to_user_id: recipientDbUserId,
        channel_id: channelId,
        message_content: message.text,
        message_type: message.type,
        gif_url: message.gifUrl,
        file_url: message.fileUrl,
        file_name: message.fileName,
        file_size: message.fileSize,
        message_payload_json: JSON.stringify(queuedMessage),
        created_at: message.timestamp,
        expires_at: expiresAt
      });
      queuedRecipientDbUserIds.push(recipientDbUserId);
      seenRecipients.add(recipientDbUserId);
    } catch (error) {
      console.error(
        `[Offline] Failed to queue offline message ${message.id} for recipient ${recipientDbUserId}:`,
        error
      );
    }
  }

  return queuedRecipientDbUserIds;
}

async function persistRealtimeMessageForSocket(
  socket: any,
  channelId: string,
  message: RealtimeChannelMessage,
  options: { notifyOnSuccess?: boolean; skipExistingCheck?: boolean } = {}
): Promise<boolean> {
  if (!options.skipExistingCheck) {
    try {
      const existing = stateMessageStore.findByMessageId(message.id);
      if (existing) {
        const attempts = messagePersistenceRetryAttempts.get(message.id) ?? 0;
        messagePersistenceRetryAttempts.delete(message.id);
        if (options.notifyOnSuccess) {
          socket.emit("message-persisted", { channelId, messageId: message.id, attempts });
        }
        return true;
      }
    } catch (lookupError) {
      console.warn('[MessageRepository] Failed persistence preflight lookup:', lookupError);
    }
  }

  try {
    const asyncCreate = (stateMessageStore as any).createAsync;
    const payload = buildPersistedMessageFromRealtime(channelId, message);
    if (typeof asyncCreate === 'function') {
      await asyncCreate.call(stateMessageStore, payload);
    } else {
      stateMessageStore.create(payload);
    }
    const attempts = messagePersistenceRetryAttempts.get(message.id) ?? 0;
    messagePersistenceRetryAttempts.delete(message.id);
    if (options.notifyOnSuccess) {
      socket.emit("message-persisted", { channelId, messageId: message.id, attempts });
    }
    return true;
  } catch (dbError) {
    const attempts = (messagePersistenceRetryAttempts.get(message.id) ?? 0) + 1;
    messagePersistenceRetryAttempts.set(message.id, attempts);
    const detail = formatMessagePersistenceError(dbError);
    console.error('[MessageRepository] Failed to persist message:', dbError);
    socket.emit("message-persist-failed", {
      channelId,
      messageId: message.id,
      attempts,
      error: 'Message was shown, but it was not saved. Retry to store it again.',
      detail
    });
    return false;
  }
}

// Helper: get the stable identity key for a user (dbUserId string for registered, socket.id for guests)
function getStableUserId(socket: any): string {
  if ((socket as any).isRegistered && (socket as any).dbUserId) {
    return `user-${(socket as any).dbUserId}`;
  }
  return socket.id;
}

function parseVoiceSettings(raw: string | null | undefined): Channel['voiceSettings'] {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const candidate = parsed as {
        bitrateMode?: unknown;
        userLimit?: unknown;
        forceSolo?: unknown;
      };
      const next: NonNullable<Channel['voiceSettings']> = {};
      if (
        candidate.bitrateMode === 'auto' ||
        candidate.bitrateMode === 'low' ||
        candidate.bitrateMode === 'standard' ||
        candidate.bitrateMode === 'high'
      ) {
        next.bitrateMode = candidate.bitrateMode;
      }
      if (candidate.userLimit !== undefined && candidate.userLimit !== null && candidate.userLimit !== '') {
        const parsedLimit = Math.floor(Number(candidate.userLimit));
        if (Number.isFinite(parsedLimit) && parsedLimit >= 1) {
          next.userLimit = Math.min(99, parsedLimit);
        }
      }
      if (candidate.forceSolo === true) {
        next.forceSolo = true;
      }
      return Object.keys(next).length > 0 ? next : undefined;
    }
  } catch (error) {
    console.warn('[Voice] Invalid channel voice settings JSON; ignoring persisted value');
  }
  return undefined;
}

function getVoiceChannelUserLimit(channel: Channel | undefined): number | null {
  if (!channel || channel.type !== 'voice') return null;
  const configuredLimit = channel.voiceSettings?.userLimit;
  if (configuredLimit == null) return null;
  const parsedLimit = Math.floor(Number(configuredLimit));
  if (!Number.isFinite(parsedLimit) || parsedLimit < 1) return null;
  return Math.min(99, parsedLimit);
}

function isVoiceChannelFocusedAudio(channel: Channel | undefined): boolean {
  return Boolean(channel && channel.type === 'voice' && channel.voiceSettings?.forceSolo);
}

// Session management for persistence across reconnects
const sessions = new Map<string, { userId: string; username: string; color: string; profilePicture?: string; createdAt: number; usernameFont?: any }>();

const MESSAGE_PURGE_VERSION_KEY = 'message_purge_version';

function getMessagePurgeVersion(): number {
  const raw = appPolicyRepository.getRaw(MESSAGE_PURGE_VERSION_KEY);
  const parsed = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function bumpMessagePurgeVersion(): number {
  const next = Date.now();
  appPolicyRepository.setRaw(MESSAGE_PURGE_VERSION_KEY, String(next));
  return next;
}

// Generate a random session ID
function generateSessionId(): string {
	return randomBytes(24).toString('base64url');
}

const typingUsers = new Set<string>();

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
  return stateRbacStore.workspaceHasOwner('default-workspace');
}

function ensureWorkspaceOwnerForRegisteredUser(dbUserId: number, username: string): { roles: string[]; highestRole: string; roleColor: string | null } {
  if (!workspaceHasOwner()) {
    assignRole(dbUserId, 'owner', 'default-workspace');
    console.log(`[Roles] Auto-assigned owner to ${username} (user_id=${dbUserId}) because workspace had no owner`);
  }
  return getUserRoleInfo(dbUserId);
}

// WebRTC signaling state
const screenSharers = new Map<string, {
  userId: string;
  username: string;
}>();

// Voice channel runtime state (transient, never persisted)
let emitDirectCallRecordingPresenceForSocket: (socketId: string) => void = () => {};
let emitDirectCallRecordingPresenceForSocketSet: (socketIds: Iterable<string>) => void = () => {};
let emitGroupCallRecordingPresence: (channelId: string) => void = () => {};
let emitVoiceChannelRecordingPresence: (channelId: string) => void = () => {};
let removeRecorderFromGroupChannels: (stableUserId: string, channelId?: string) => void = () => {};
let syncVoiceRecordingPresenceForSocket: (stableUserId: string, socketId: string) => void = () => {};
let clearAllRecordingPresenceForStableUser: (stableUserId: string, socketId?: string) => void = () => {};
let setRecordingActiveForSocket: (request: {
  socketId: string;
  stableUserId: string;
  active: boolean;
  scope?: "direct" | "group" | "channel";
  channelId?: string;
}) => { ok: true } | { ok: false; error: string } = () => ({ ok: false, error: 'Voice recording runtime unavailable.' });

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

function resolveStableUserIdFromAny(rawId: string): string | null {
  if (!rawId) return null;
  if (rawId.startsWith('user-')) return rawId;
  const user = users.get(rawId);
  if (user?.dbUserId) return `user-${user.dbUserId}`;
  if (users.has(rawId)) return rawId;
  return null;
}

function getGroupChannelById(channelId?: string): Channel | null {
  if (!channelId) return null;
  const channel = channels.get(channelId);
  if (!channel || channel.type !== 'group') return null;
  return channel;
}

function isStableUserConnected(stableUserId: string): boolean {
  const socketId = resolveSocketId(stableUserId);
  if (socketId && users.has(socketId)) return true;
  if (stableUserId.startsWith('user-')) {
    return Boolean(findStateMeshSocketLeaseByStableUserId(stableUserId));
  }
  return false;
}

function applyWorkspaceChannelsToMemory(workspaceChannels: DbChannel[]): void {
  workspaceChannels.forEach(ch => {
    channels.set(ch.channel_id, {
      id: ch.channel_id,
      name: ch.name,
      description: ch.description || '',
      watchQueueEnabled: (ch as any).watch_queue_enabled === 1,
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
      autoDeleteAfter: resolvePersistedChannelRetention(ch.auto_delete_after, ch.channel_type),
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
}

const WHITEBOARD_ROOM_PREFIX = "whiteboard:";
const WHITEBOARD_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const WHITEBOARD_MAX_LIVE_PAYLOAD_BYTES = 128 * 1024;
const WHITEBOARD_ORPHAN_UPLOAD_CLEANUP_STARTUP_DELAY_MS = 30 * 1000;

function getWhiteboardRoomId(boardId: string): string {
  return `${WHITEBOARD_ROOM_PREFIX}${boardId}`;
}

function getSerializedPayloadBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getWhiteboardPresenceUsers(boardId: string): Array<{ userId: string; username: string; color: string | null }> {
  const room = io.sockets.adapter.rooms.get(getWhiteboardRoomId(boardId));
  if (!room || room.size === 0) return [];

  const uniqueUsers = new Map<string, { userId: string; username: string; color: string | null }>();
  for (const socketId of room) {
    const participantSocket = io.sockets.sockets.get(socketId);
    if (!participantSocket) continue;
    const stableUserId = getStableUserId(participantSocket as any);
    if (uniqueUsers.has(stableUserId)) continue;
    const participant = users.get(socketId);
    uniqueUsers.set(stableUserId, {
      userId: stableUserId,
      username: participant?.username || 'Unknown',
      color: participant?.color || null
    });
  }

  return Array.from(uniqueUsers.values());
}

function emitWhiteboardPresence(boardId: string): void {
  io.to(getWhiteboardRoomId(boardId)).emit("whiteboard:presence", {
    boardId,
    users: getWhiteboardPresenceUsers(boardId)
  });
}

// Emote storage
const emotes = new Map<string, {
  name: string;
  url: string;
  type: 'static' | 'animated';
  uploadedBy: string;
  timestamp: number;
}>();

const BUSINESS_DATA_DIR = join(DATA_DIR, BUSINESS_DATA_DIR_NAME);

// Ensure data directories exist
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}
if (!existsSync(BUSINESS_DATA_DIR)) {
  mkdirSync(BUSINESS_DATA_DIR, { recursive: true });
}

let getAutoDeleteMs: (duration: MessageRetentionDuration | null | undefined) => number = () => 0;
let scheduleMessageDeletion: (
  channelId: string,
  messageId: string,
  duration: MessageRetentionDuration | null | undefined
) => void = () => {};
let clearAllMessageDeletionTimers: () => void = () => {};
let deleteRealtimeMessage: (channelId: string, messageId: string, reason: string) => boolean = () => false;

// Business data persistence functions
function getBusinessDataPath(workspaceId: string): string {
  return join(BUSINESS_DATA_DIR, `${workspaceId}.json`);
}

function loadBusinessData(workspaceId: string): BusinessData | null {
  try {
    const filePath = getBusinessDataPath(workspaceId);
    if (existsSync(filePath)) {
      const data = sanitizeBusinessData(JSON.parse(readFileSync(filePath, 'utf-8')) as unknown, workspaceId);
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
    const sanitized = sanitizeBusinessData(data, workspaceId);
    sanitized.lastUpdated = Date.now();
    businessWorkspaces.set(workspaceId, sanitized);
    writeFileSync(filePath, JSON.stringify(sanitized, null, 2));
    const enableLogging = process.env.ENABLE_LOGGING === 'true';
    if (enableLogging) console.log(`💾 Saved business data for workspace: ${workspaceId}`);
  } catch (error) {
    console.error(`Error saving business data for workspace ${workspaceId}:`, error);
  }
}

function initializeWorkspace(workspaceId: string): BusinessData {
  const data = createEmptyBusinessData(workspaceId);

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

function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return fallback;
}

// Initialize default workspace on startup
initializeWorkspace(defaultWorkspaceId);

function resolvePort(): number {
  const raw = process.env.BACKEND_PORT || process.env.PORT || '3000';
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return 3000;
}

const PORT = resolvePort();
const STATIC_DIR = process.env.STATIC_DIR || DEFAULT_STATIC_DIR;
const EMOTES_DIR = join(STATIC_DIR, "emotes");
const MULTIPART_UPLOAD_MAX_BYTES = (() => {
  const env = process.env.WABI_MULTIPART_MAX_BYTES;
  if (env) {
    const parsed = parseInt(env, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 10 * 1024 * 1024 * 1024; // 10 GB default — owners can override via WABI_MULTIPART_MAX_BYTES
})();
const ENABLE_LOGGING = process.env.ENABLE_LOGGING === 'true';
const statePlaneConfig = getStatePlaneConfigFromEnv();
const PLUGINS_ENABLED = envFlag(process.env.PLUGINS_ENABLED, false);
const PLUGINS_ALLOW_INSTALL = envFlag(process.env.PLUGINS_ALLOW_INSTALL, false);
const PRELOAD_CHANNEL_HISTORY_ON_LOGIN = envFlag(
  process.env.WABI_PRELOAD_CHANNEL_HISTORY_ON_LOGIN,
  false
);
const VIDEO_COMPRESSION_CLIENT_METRICS_ENABLED = envFlag(
  process.env.WABI_VIDEO_COMPRESSION_CLIENT_METRICS_ENABLED,
  false
);

console.log(
  `[StatePlane] mode=stdb_primary subs=${statePlaneConfig.stdbSubscriptionsEnabled} rbac=${statePlaneConfig.enforceRbac} schemaVersion=${statePlaneConfig.planeSchemaVersion} schemaAutoApply=${statePlaneConfig.planeSchemaAutoApply} outboxRedactSensitive=${statePlaneConfig.outboxRedactSensitive} outboxMaxBytes=${statePlaneConfig.outboxMaxBytes} outboxTruncateMinBytes=${statePlaneConfig.outboxTruncateMinBytes} reducerIngress=${statePlaneConfig.reducerIngressEnabled} reducerIngressRequireSignature=${statePlaneConfig.reducerIngressRequireSignature}`
);

// Ensure emotes directory exists
if (!existsSync(EMOTES_DIR)) {
  mkdirSync(EMOTES_DIR, { recursive: true });
}

ensureUploadDirectories();

const { serveUploadByFileId } = createUploadFileServing({
  resolveUploadPath,
  isAtRestEncryptedBuffer,
  maybeDecryptFromAtRest,
  maybeDecompressUploadPayload,
  getFileExtension,
  recordCompressionDownloadSample
});

function normalizeClientMessageEntities(rawEntities: unknown, rawText: string, allowEntities: boolean): MessageEntity[] {
  if (!allowEntities || !Array.isArray(rawEntities) || typeof rawText !== 'string' || rawText.length === 0) {
    return [];
  }

  const normalized: MessageEntity[] = [];
  const textLength = rawText.length;

  for (const entry of rawEntities) {
    if (!entry || typeof entry !== 'object') continue;

    const candidate = entry as Record<string, unknown>;
    if (candidate.kind !== 'place') continue;

    const start = Math.floor(Number(candidate.start));
    const end = Math.floor(Number(candidate.end));
    const placeId =
      typeof candidate.placeId === 'string'
        ? candidate.placeId.trim().toLowerCase()
        : typeof candidate.id === 'string'
          ? candidate.id.trim().toLowerCase()
          : '';
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > textLength) {
      continue;
    }
    if (!placeId || !isKnownPlaceId(placeId)) continue;
    const placeRecord = getPlaceRecordById(placeId);
    if (!placeRecord) continue;
    const poiId =
      typeof candidate.poiId === 'string' && candidate.poiId.trim().length > 0
        ? candidate.poiId.trim().toLowerCase()
        : '';
    const poiRecord = poiId ? placeRecord.pois?.find((poi) => poi.id === poiId) || null : null;
    const layerId =
      typeof candidate.layerId === 'string' && candidate.layerId.trim().length > 0
        ? candidate.layerId.trim().toLowerCase()
        : '';
    const normalizedLayerId =
      (poiRecord?.layerId && placeRecord.mapLayers?.some((layer) => layer.id === poiRecord.layerId)
        ? poiRecord.layerId
        : layerId && placeRecord.mapLayers?.some((layer) => layer.id === layerId)
          ? layerId
          : '');

    const displayText =
      typeof candidate.displayText === 'string' && candidate.displayText.trim().length > 0
        ? candidate.displayText
        : rawText.slice(start, end);
    const label =
      typeof candidate.label === 'string' && candidate.label.trim().length > 0
        ? candidate.label.trim()
        : displayText.trim();
    if (!label || !displayText) continue;

    normalized.push({
      kind: 'place',
      start,
      end,
      placeId,
      layerId: normalizedLayerId || undefined,
      poiId: poiRecord?.id || undefined,
      label,
      displayText
    });
  }

  normalized.sort((a, b) => a.start - b.start || a.end - b.end);

  const deduped: MessageEntity[] = [];
  let lastEnd = -1;
  for (const entity of normalized) {
    if (entity.start < lastEnd) continue;
    deduped.push(entity);
    lastEnd = entity.end;
  }
  return deduped;
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
  return getAuthenticatedUserIdFromRequest(req);
}

function isPluginAdmin(userId: number | null): boolean {
  if (!userId) return false;
  if (userId === 1) return true;
  const roles = getUserRoles(userId, 'default-workspace');
  return roles.includes('owner') || roles.includes('admin');
}

function requireAuthenticatedUser(
  req: any,
  res: any,
  unauthorizedPayload: Record<string, unknown> = { error: 'Unauthorized' }
): number | null {
  const userId = getAuthenticatedUserId(req);
  if (!userId) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify(unauthorizedPayload));
    return null;
  }
  return userId;
}

function requirePluginAdminUser(req: any, res: any): number | null {
  const userId = getAuthenticatedUserIdFromRequest(req);
  if (!isPluginAdmin(userId)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: "Admin permissions required" }));
    return null;
  }
  return userId;
}

const {
  users,
  dbUserIdToSocketId,
  getPublicUserId,
  normalizePresenceStatus,
  toPublicUser,
  upsertPresenceLeaseForUser,
  deletePresenceLeaseForUser,
  getMeshConnectionCounts,
  recordPresenceStateEvent,
  resolveSocketId,
  getMeshSharedToken,
  constantTimeEqualString,
  hasSeenMeshDelivery,
  markSeenMeshDelivery,
  emitMeshBroadcast,
  emitGlobalEvent,
  emitToStableUser,
  emitToChannelLocal,
  normalizeMeshInboundDelivery,
  applyInboundMeshDelivery,
  emitToRegisteredUser,
  emitToPaymentAdmins,
  buildDistributedUsersSnapshot
} = createPresenceMeshRuntime({
  io,
  channels,
  defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
  getStableUserId,
  recordStatePlaneEvent,
  upsertStateMeshPresenceLease,
  deleteStateMeshPresenceLease,
  listStateMeshPresenceLeases,
  getCurrentStateMeshInstanceId,
  listActiveStateMeshInstanceLeases,
  sendStateMeshRemoteDelivery,
  findStateMeshSocketLeaseByStableUserId,
  isPluginAdmin,
  getAllDbUsers: () => userRepository.getAll(),
  buildWorkspaceRoleLookup,
  getUserRoleInfo
});

const {
  activeCallPeers,
  addCallPeer,
  removeAllCallPeers
} = createDirectCallRuntime();

const {
  voiceChannelParticipants,
  socketVoiceSubscriptions,
  getVoiceChannelMembers,
  canJoinVoiceChannel,
  canSubscribeToVoiceChannel,
  addVoiceSubscription,
  removeVoiceSubscription,
  removeAllVoiceSubscriptionsForSocket,
  getVoiceAudienceSocketIds,
  emitToVoiceAudience,
  getVoiceStatePayload,
  emitVoiceChannelState,
  getBreakoutChannelsForParent,
  moveVoiceParticipant,
  addVoicePeerLink,
  removeVoicePeerLink,
  removeAllVoicePeerLinks
} = createVoiceChannelRuntime({
  channels,
  resolveSocketId,
  buildVoiceParticipant,
  getVoiceChannelUserLimit,
  isVoiceChannelFocusedAudio,
  canSocketAccessChannel: (targetSocket: any, channel) => {
    if (!channel.members || channel.members.length === 0) {
      const requiredRole = channel.minRole || 'guest';
      if (requiredRole === 'guest') return true;
      const user = users.get(targetSocket.id);
      const highestRole = user?.highestRole || 'guest';
      return getRolePriority(highestRole) >= getRolePriority(requiredRole);
    }
    return channel.members.includes(getStableUserId(targetSocket));
  },
  listSockets: () => io.sockets.sockets.values(),
  emitStateToSocket: (targetSocket: any, event, payload) => {
    targetSocket.emit(event, payload);
  },
  emitToSocketId: (socketId, event, payload) => {
    io.to(socketId).emit(event, payload);
  }
});

const {
  groupCallSessions,
  isGroupCallEstablished,
  cancelPendingGroupCallInvites,
  cleanupIdleGroupCallSession,
  emitGroupCallInviteCleared,
  joinGroupCallSession,
  removeGroupCallParticipantFromSession
} = createGroupCallRuntime({
  emitToStableUser,
  findDisplayName: (stableUserId) => findUserByStableId(stableUserId)?.username
});

const {
  initiateGroupCall,
  answerGroupCall,
  rejectGroupCall,
  cancelGroupCall,
  stopRingingForGroupCall,
  leaveGroupCall
} = createGroupCallLifecycle({
  groupCallSessions,
  getGroupChannelById,
  isStableUserConnected,
  resolveStableUserIdFromAny,
  emitToStableUser,
  emitToSocketId: (socketId, event, payload) => {
    io.to(socketId).emit(event, payload);
  },
  isGroupCallEstablished,
  cancelPendingGroupCallInvites,
  cleanupIdleGroupCallSession,
  emitGroupCallInviteCleared,
  joinGroupCallSession,
  removeGroupCallParticipantFromSession,
  emitGroupCallRecordingPresence: (channelId) => {
    emitGroupCallRecordingPresence(channelId);
  },
  removeRecorderFromGroupChannels: (stableUserId, channelId) => {
    removeRecorderFromGroupChannels(stableUserId, channelId);
  }
});

({
  emitDirectCallRecordingPresenceForSocket,
  emitDirectCallRecordingPresenceForSocketSet,
  emitGroupCallRecordingPresence,
  emitVoiceChannelRecordingPresence,
  removeRecorderFromGroupChannels,
  syncVoiceRecordingPresenceForSocket,
  clearAllRecordingPresenceForStableUser,
  setRecordingActiveForSocket
} = createVoiceRecordingRuntime({
  users,
  activeCallPeers,
  groupCallSessions,
  socketVoiceSubscriptions,
  getPublicUserId,
  buildVoiceParticipant,
  resolveSocketId,
  emitToSocket: (socketId, event, payload) => {
    io.to(socketId).emit(event, payload);
  },
  emitToStableUser,
  emitToVoiceAudience
}));

setPaymentRealtimeNotifier({
  notifyPaymentIntentUpdated(update) {
    emitToRegisteredUser(update.createdByUserId, 'payments:intent-updated', {
      workspaceId: update.workspaceId,
      intentId: update.intentId,
      status: update.status,
      channelId: update.channelId,
      isDonation: update.isDonation
    });
    if (update.isDonation) {
      io.emit('payments:donations-updated', {
        workspaceId: update.workspaceId,
        reason: 'intent',
        intentId: update.intentId,
        status: update.status
      });
      emitToPaymentAdmins('payments:donations-admin-updated', {
        workspaceId: update.workspaceId,
        reason: 'intent',
        intentId: update.intentId,
        status: update.status
      });
    }
  },
  notifyDonationUpdated(update) {
    io.emit('payments:donations-updated', {
      workspaceId: update.workspaceId,
      reason: update.reason,
      intentId: update.intentId || null,
      settlementId: update.settlementId || null,
      status: update.status || null
    });
    emitToPaymentAdmins('payments:donations-admin-updated', {
      workspaceId: update.workspaceId,
      reason: update.reason,
      intentId: update.intentId || null,
      settlementId: update.settlementId || null,
      status: update.status || null
    });
  },
  notifyManualCashUpdated(update) {
    for (const participantUserId of update.participantUserIds) {
      emitToRegisteredUser(participantUserId, 'manual-cash:updated', {
        workspaceId: update.workspaceId,
        settlementId: update.settlementId,
        channelId: update.channelId,
        status: update.status
      });
    }
  },
  notifyPaymentAccountLinksUpdated(update) {
    emitToRegisteredUser(update.userId, 'payments:account-links-updated', {
      workspaceId: update.workspaceId
    });
  },
  notifyPaymentUserBlocksUpdated(update) {
    emitToPaymentAdmins('payments:user-blocks-updated', {
      workspaceId: update.workspaceId,
      userId: update.userId
    });
  },
  notifyPaymentAccessUpdated(update) {
    if (update.userId && Number.isFinite(update.userId)) {
      emitToRegisteredUser(update.userId, 'payments:access-updated', {
        workspaceId: update.workspaceId,
        userId: update.userId
      });
      return;
    }
    io.emit('payments:access-updated', {
      workspaceId: update.workspaceId,
      userId: null
    });
  }
});

function getGuestSessionId(req: any): string | null {
  const sessionHeader = req.headers['x-session-id'];
  if (typeof sessionHeader === 'string' && sessionHeader.trim().length > 0) {
    return sessionHeader.trim();
  }
  return null;
}

function resolveUploadOwnerKey(userId: number | null, guestSessionId: string | null): string | null {
  return getUploadOwnerKey(userId, guestSessionId, (sessionId) => sessions.has(sessionId));
}

function getRequestStableActorId(userId: number | null, guestSessionId: string | null): string | null {
  if (typeof userId === 'number' && Number.isFinite(userId) && userId > 0) {
    return `user-${Math.floor(userId)}`;
  }
  if (guestSessionId && sessions.has(guestSessionId)) {
    return `guest-session:${guestSessionId}`;
  }
  return null;
}

function getAccessibleWhiteboardForRequest(
  req: any,
  boardId: string,
  options: {
    createIfMissing?: boolean;
  } = {}
): { allowed: true; board: WhiteboardRecord; channel: DbChannel; actorStableId: string } | { allowed: false; status: number; error: string } {
  const userId = getAuthenticatedUserId(req);
  const guestSessionId = getGuestSessionId(req);
  const actorStableId = getRequestStableActorId(userId, guestSessionId);
  return resolveAccessibleWhiteboardForRequest(
    {
      userId,
      guestSessionId,
      actorStableId
    },
    boardId,
    {
      channelRepository,
      channelMemberRepository,
      whiteboardRepository,
      hasGuestSession: (sessionId) => sessions.has(sessionId),
      getHighestRole: (resolvedUserId) => getUserRoleInfo(resolvedUserId).highestRole,
      getRolePriority
    },
    options
  );
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

  // Plugin runtime HTTP routes (namespaced under /api/plugins/runtime/:pluginId/*)
  if (await pluginLoader.handleHttpRoute(req, res, url)) {
    return;
  }

  if (await handleRuntimeAdminRoutes(req, res, url, {
    pluginLoader,
    getAuthenticatedUserId,
    isPluginAdmin,
    isKnownPolicyKey,
    getPolicyValue,
    getPolicyDefaults,
    savePolicyValue,
    runtimePolicyKey: RUNTIME_TUNING_POLICY_KEY,
    uploadLimitsPolicyKey: UPLOAD_LIMITS_POLICY_KEY,
    getCompressionMetricsSnapshot,
    compressionConfig: {
      httpTextCompression: {
        enabled: HTTP_TEXT_COMPRESSION_ENABLED,
        minBytes: HTTP_TEXT_COMPRESSION_MIN_BYTES,
        brotliQuality: HTTP_TEXT_COMPRESSION_BROTLI_QUALITY,
        gzipLevel: HTTP_TEXT_COMPRESSION_GZIP_LEVEL
      },
      uploadCompression: {
        enabled: UPLOAD_COMPRESSION_ENABLED,
        minBytes: UPLOAD_COMPRESSION_MIN_BYTES,
        gzipLevel: UPLOAD_COMPRESSION_GZIP_LEVEL,
        rolloutPercent: UPLOAD_COMPRESSION_ROLLOUT_PERCENT
      }
    },
    getRuntimeGuardrailsSnapshot,
    startupRuntimeTuning,
    stateReducerIngress,
    getMeshSharedToken,
    constantTimeEqualString,
    normalizeMeshInboundDelivery,
    hasSeenMeshDelivery,
    applyInboundMeshDelivery,
    markSeenMeshDelivery,
    getStatePlaneRuntimeStats,
    resetCompressionMetrics
  })) {
    return;
  }

  if (await handleUploadRoutes(req, res, url, {
    getAuthenticatedUserId,
    getGuestSessionId,
    hasGuestSession: (sessionId) => sessions.has(sessionId),
    resolveUploadOwnerKey,
    enforceUploadLimit,
    multipartUploadMaxBytes: MULTIPART_UPLOAD_MAX_BYTES,
    isVideoCompressionClientMetricsEnabled: VIDEO_COMPRESSION_CLIENT_METRICS_ENABLED,
    isAtRestEncryptionEnabled: Boolean(FILE_ENCRYPTION_KEY),
    recordClientVideoCompressionSample,
    recordCompressionUploadSample
  })) {
    return;
  }

  const whiteboardImageUploadMatch = url.pathname.match(/^\/api\/whiteboard\/boards\/([^/]+)\/images$/);
  if (whiteboardImageUploadMatch && req.method === "POST") {
    const boardId = decodePathSegment(whiteboardImageUploadMatch[1] || '')?.trim() || '';
    if (!boardId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Invalid whiteboard id' }));
      return;
    }
    const access = getAccessibleWhiteboardForRequest(req, boardId, { createIfMissing: true });
    if (!access.allowed) {
      res.writeHead(access.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: access.error }));
      return;
    }

    try {
      const uploadStartedAt = Date.now();
      const userId = getAuthenticatedUserId(req);
      const guestSessionId = getGuestSessionId(req);
      const ownerKey = resolveUploadOwnerKey(userId, guestSessionId) || access.actorStableId;
      const bodyBuffer = await readRequestBuffer(req);
      const uploaded =
        readMultipartSingleFile(req.headers['content-type'], bodyBuffer, 'file') ||
        readMultipartSingleFile(req.headers['content-type'], bodyBuffer, 'image');

      if (!uploaded) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Image file is required (multipart/form-data)' }));
        return;
      }

      const safeFileName = sanitizeUploadFileName(uploaded.fileName || 'whiteboard-image.bin');
      if (!enforceUploadLimit(res, userId, guestSessionId, uploaded.data.length, safeFileName, 'direct-upload')) {
        return;
      }

      const fileId = createWhiteboardUploadFileId(access.board.boardId, safeFileName);
      const filePath = resolveUploadPath(fileId);
      if (!filePath) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Failed to resolve whiteboard upload path' }));
        return;
      }

      if (!existsSync(UPLOADS_DIR)) {
        mkdirSync(UPLOADS_DIR, { recursive: true });
      }

      const mimeType = uploaded.contentType || 'application/octet-stream';
      const storageResult = await maybeCompressUploadPayloadNonBlocking(
        safeFileName,
        mimeType,
        uploaded.data,
        `${ownerKey}:${access.board.boardId}:${safeFileName}:${uploaded.data.length}`
      );
      await writeUploadFileNonBlocking(filePath, storageResult.payload);
      const storedBytes = (await statAsync(filePath)).size;
      recordCompressionUploadSample({
        timestamp: Date.now(),
        source: 'direct-upload-multipart',
        fileExt: getFileExtension(safeFileName),
        mimeType,
        originalBytes: storageResult.meta.originalSize,
        storedBytes,
        durationMs: Date.now() - uploadStartedAt,
        atRestEncrypted: Boolean(FILE_ENCRYPTION_KEY)
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        boardId: access.board.boardId,
        fileId,
        fileUrl: createWhiteboardUploadUrl(access.board.boardId, fileId),
        fileName: safeFileName,
        fileSize: uploaded.data.length,
        mimeType,
        attachmentStorage: { ...storageResult.meta, storedSize: storedBytes }
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Whiteboard image upload failed';
      const status = message.startsWith('request_body_too_large') ? 413 : 500;
      console.error('[Whiteboard] Upload error:', error);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: status === 413 ? 'Whiteboard image exceeds server request limit' : message }));
    }
    return;
  }

  const whiteboardImageReadMatch = url.pathname.match(/^\/api\/whiteboard\/boards\/([^/]+)\/files\/([^/]+)$/);
  if (whiteboardImageReadMatch && (req.method === "GET" || req.method === "HEAD")) {
    const boardId = decodePathSegment(whiteboardImageReadMatch[1] || '')?.trim() || '';
    if (!boardId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Invalid whiteboard id' }));
      return;
    }
    const fileId = normalizeUploadFileIdSegment(whiteboardImageReadMatch[2] || '');
    if (!fileId) {
      res.writeHead(403);
      res.end("Access denied");
      return;
    }

    const access = getAccessibleWhiteboardForRequest(req, boardId);
    if (!access.allowed) {
      res.writeHead(access.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: access.error }));
      return;
    }

    if (!isWhiteboardUploadFileIdForBoard(access.board.boardId, fileId)) {
      res.writeHead(403);
      res.end("Access denied");
      return;
    }

    serveUploadByFileId(req, res, fileId, {
      cacheControl: 'private, max-age=300',
      allowRange: false
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

  // State-plane diagnostic endpoint (STDB connectivity, mode, stats)
  if (url.pathname === "/state-plane/healthz") {
    const stats = getStatePlaneRuntimeStats();
    const summarizeStore = (s: { mode?: string; writesAttempted?: number; writesSucceeded?: number; writesFailed?: number; lastError?: string | null; lastErrorAt?: number | null } | null) => {
      if (!s) return null;
      return {
        mode: s.mode ?? null,
        writes_attempted: s.writesAttempted ?? null,
        writes_succeeded: s.writesSucceeded ?? null,
        writes_failed: s.writesFailed ?? null,
        last_error: s.lastError ?? null,
        last_error_at: s.lastErrorAt ?? null
      };
    };
    const body = {
      mode: 'stdb_primary',
      schema_version: stats.schema?.version ?? null,
      schema_mismatch: stats.schema?.mismatch ?? false,
      message_store: summarizeStore(stats.messageStore as Parameters<typeof summarizeStore>[0]),
      channel_store: summarizeStore(stats.channelStore as Parameters<typeof summarizeStore>[0]),
      channel_member_store: summarizeStore(stats.channelMemberStore as Parameters<typeof summarizeStore>[0]),
      user_store: summarizeStore(stats.userStore as Parameters<typeof summarizeStore>[0]),
      session_store: summarizeStore(stats.sessionStore as Parameters<typeof summarizeStore>[0]),
      rbac_store: summarizeStore(stats.rbacStore as Parameters<typeof summarizeStore>[0]),
      outbox: stats.outbox ? {
        enabled: stats.outbox.enabled,
        written: stats.outbox.written,
        errors: stats.outbox.errors,
        last_error: stats.outbox.lastError,
        last_error_at: stats.outbox.lastErrorAt
      } : null,
      uptime: process.uptime()
    };
    const healthy = stats.schema?.mismatch !== true;
    res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
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

  // Setup status endpoint (public, no auth) — returns whether owner bootstrap is needed
  if (url.pathname === "/api/setup/status" && req.method === "GET") {
    try {
      const row = db.prepare('SELECT COUNT(*) as count FROM users WHERE is_active = 1').get() as { count: number } | undefined;
      const userCount = row?.count ?? 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ setupRequired: userCount === 0 }));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ setupRequired: false }));
    }
    return;
  }

  // Setup network hint endpoint — saves operator network config notes via the app policy store

  // Setup branding endpoint — writes data/launch-page.json for login page customization

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

  if (url.pathname === "/api/auth/change-password" && req.method === "POST") {
    await handleChangePassword(req, res);
    return;
  }

  if (url.pathname === "/api/admin/users/reset-password" && req.method === "POST") {
    await handleAdminResetUserPassword(req, res);
    return;
  }

  if (url.pathname === "/api/admin/users/clear-login-lockout" && req.method === "POST") {
    await handleAdminClearLoginLockout(req, res);
    return;
  }

  // Public launch page config (branding / login hero content)
  if (url.pathname === "/api/public/launch-page" && req.method === "GET") {
    await handleGetLaunchPageConfig(req, res);
    return;
  }

  // Public frontend shell metadata (server rail / switcher branding)
  if (url.pathname === "/api/public/frontend-app-metadata" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=30"
    });
    res.end(JSON.stringify(getPolicyValue(FRONTEND_APP_METADATA_POLICY_KEY)));
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

  if (url.pathname === "/api/following/poll" && req.method === "POST") {
    const guestSessionId = getGuestSessionId(req);
    const guestStableUserId =
      guestSessionId && sessions.has(guestSessionId)
        ? sessions.get(guestSessionId)?.userId || null
        : null;
    await handlePollFollowedChannelActivity(req, res, { guestStableUserId });
    return;
  }

  // Non-custodial payments endpoints
  if (url.pathname === "/api/payments/access" && req.method === "GET") {
    await handleGetPaymentAccess(req, res);
    return;
  }

  if (url.pathname === "/api/payments/account-links" && req.method === "GET") {
    await handleListPaymentAccountLinks(req, res);
    return;
  }

  if (url.pathname === "/api/payments/account-links" && req.method === "POST") {
    await handleUpsertPaymentAccountLink(req, res);
    return;
  }

  const paymentAccountLinkDeleteMatch = url.pathname.match(/^\/api\/payments\/account-links\/([A-Za-z0-9_-]{1,96})$/);
  if (paymentAccountLinkDeleteMatch && req.method === "DELETE") {
    await handleDeletePaymentAccountLink(req, res, decodeURIComponent(paymentAccountLinkDeleteMatch[1]));
    return;
  }

  if (url.pathname === "/api/payments/providers" && req.method === "GET") {
    await handleListPaymentProviders(req, res, pluginLoader, url);
    return;
  }

  if (url.pathname === "/api/payments/history" && req.method === "GET") {
    await handleListPaymentHistory(req, res, url);
    return;
  }

  if (url.pathname === "/api/payments/donations" && req.method === "GET") {
    await handleGetPaymentDonationSummary(req, res);
    return;
  }

  if (url.pathname === "/api/manual-cash" && req.method === "POST") {
    await handleCreateManualCashSettlement(req, res);
    return;
  }

  const manualCashListMatch = url.pathname.match(/^\/api\/manual-cash\/([^/]+)$/);
  if (manualCashListMatch && req.method === "GET") {
    await handleListManualCashSettlements(req, res, decodeURIComponent(manualCashListMatch[1]), url);
    return;
  }

  const manualCashConfirmMatch = url.pathname.match(/^\/api\/manual-cash\/([A-Za-z0-9._:-]{8,128})\/confirm$/);
  if (manualCashConfirmMatch && req.method === "POST") {
    await handleConfirmManualCashSettlement(req, res, decodeURIComponent(manualCashConfirmMatch[1]));
    return;
  }

  const manualCashCancelMatch = url.pathname.match(/^\/api\/manual-cash\/([A-Za-z0-9._:-]{8,128})\/cancel$/);
  if (manualCashCancelMatch && req.method === "POST") {
    await handleCancelManualCashSettlement(req, res, decodeURIComponent(manualCashCancelMatch[1]));
    return;
  }

  const manualCashDisputeMatch = url.pathname.match(/^\/api\/manual-cash\/([A-Za-z0-9._:-]{8,128})\/dispute$/);
  if (manualCashDisputeMatch && req.method === "POST") {
    await handleDisputeManualCashSettlement(req, res, decodeURIComponent(manualCashDisputeMatch[1]));
    return;
  }

  const paymentWebhookMatch = url.pathname.match(/^\/api\/payments\/webhooks\/([A-Za-z0-9_-]{1,96})$/);
  if (paymentWebhookMatch && req.method === "POST") {
    await handlePaymentWebhook(req, res, pluginLoader, paymentWebhookMatch[1], url);
    return;
  }

  if (url.pathname === "/api/payments/create" && req.method === "POST") {
    await handleCreatePaymentIntent(req, res, pluginLoader);
    return;
  }

  const paymentCancelMatch = url.pathname.match(/^\/api\/payments\/([A-Za-z0-9._:-]{8,128})\/cancel$/);
  if (paymentCancelMatch && req.method === "POST") {
    await handleCancelPaymentIntent(req, res, pluginLoader, decodeURIComponent(paymentCancelMatch[1]));
    return;
  }

  const paymentIntentMatch = url.pathname.match(/^\/api\/payments\/([A-Za-z0-9._:-]{8,128})$/);
  if (paymentIntentMatch && req.method === "GET") {
    await handleGetPaymentIntent(req, res, pluginLoader, decodeURIComponent(paymentIntentMatch[1]), url);
    return;
  }

  if (url.pathname === "/api/admin/payments/access" && req.method === "GET") {
    await handleGetPaymentAccessPolicy(req, res);
    return;
  }

  if (url.pathname === "/api/admin/payments/access" && req.method === "POST") {
    await handleSavePaymentAccessPolicy(req, res);
    return;
  }

  if (url.pathname === "/api/admin/payments/donations" && req.method === "GET") {
    await handleGetPaymentDonationConfig(req, res);
    return;
  }

  if (url.pathname === "/api/admin/payments/donations" && req.method === "POST") {
    await handleSavePaymentDonationConfig(req, res);
    return;
  }

  if (url.pathname === "/api/admin/payments/donations/log" && req.method === "GET") {
    await handleListAdminPaymentDonations(req, res, url);
    return;
  }

  if (url.pathname === "/api/admin/payments/donations/offline" && req.method === "GET") {
    await handleListAdminOfflineDonations(req, res, url);
    return;
  }

  if (url.pathname === "/api/admin/payments/donations/offline" && req.method === "POST") {
    await handleCreateAdminOfflineDonation(req, res);
    return;
  }

  const paymentDonationRefundMatch = url.pathname.match(/^\/api\/admin\/payments\/donations\/([A-Za-z0-9._:-]{8,128})\/refund$/);
  if (paymentDonationRefundMatch && req.method === "POST") {
    await handleRefundAdminPaymentDonation(req, res, pluginLoader, decodeURIComponent(paymentDonationRefundMatch[1]));
    return;
  }

  const offlineDonationVoidMatch = url.pathname.match(/^\/api\/admin\/payments\/donations\/offline\/([A-Za-z0-9._:-]{8,128})\/void$/);
  if (offlineDonationVoidMatch && req.method === "POST") {
    await handleVoidAdminOfflineDonation(req, res, decodeURIComponent(offlineDonationVoidMatch[1]));
    return;
  }

  if (url.pathname === "/api/admin/payments/blocks" && req.method === "GET") {
    await handleListPaymentUserBlocks(req, res, url);
    return;
  }

  if (url.pathname === "/api/admin/payments/blocks" && req.method === "POST") {
    await handleUpsertPaymentUserBlock(req, res);
    return;
  }

  const paymentUserBlockDeleteMatch = url.pathname.match(/^\/api\/admin\/payments\/blocks\/(\d+)$/);
  if (paymentUserBlockDeleteMatch && req.method === "DELETE") {
    await handleDeletePaymentUserBlock(req, res, parseInt(paymentUserBlockDeleteMatch[1], 10));
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

  if (url.pathname === "/api/desktop-helper/register" && req.method === "POST") {
    await handleDesktopHelperRegister(req, res);
    return;
  }

  if (url.pathname === "/api/desktop-helper/heartbeat" && req.method === "POST") {
    await handleDesktopHelperHeartbeat(req, res);
    return;
  }

  if (url.pathname === "/api/desktop-helper/offline" && req.method === "POST") {
    await handleDesktopHelperOffline(req, res);
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
    const userId = requireAuthenticatedUser(req, res, { error: 'Missing or invalid authorization' });
    if (!userId) return;

    await handleGetTurnCredentials(req, res, userId);
    return;
  }

  if (url.pathname === "/api/media/livekit/token" && req.method === "POST") {
    const userId = requireAuthenticatedUser(req, res, { error: 'Missing or invalid authorization' });
    if (!userId) return;

    await handleCreateLivekitToken(req, res, userId);
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
    const userId = requireAuthenticatedUser(req, res, { error: 'Missing or invalid authorization' });
    if (!userId) return;
    await handleCreateMediaGatewaySession(req, res, userId);
    return;
  }

  if (url.pathname === "/api/media/gateway/sessions" && req.method === "GET") {
    const userId = requireAuthenticatedUser(req, res, { error: 'Missing or invalid authorization' });
    if (!userId) return;
    await handleListMediaGatewaySessions(req, res, userId);
    return;
  }

  const mediaGatewaySessionMatch = url.pathname.match(/^\/api\/media\/gateway\/session\/([a-f0-9]{16,64})$/);
  if (mediaGatewaySessionMatch && req.method === "GET") {
    const userId = requireAuthenticatedUser(req, res, { error: 'Missing or invalid authorization' });
    if (!userId) return;
    await handleGetMediaGatewaySession(req, res, userId, mediaGatewaySessionMatch[1]);
    return;
  }

  const mediaGatewaySessionCloseMatch = url.pathname.match(/^\/api\/media\/gateway\/session\/([a-f0-9]{16,64})\/close$/);
  if (mediaGatewaySessionCloseMatch && req.method === "POST") {
    const userId = requireAuthenticatedUser(req, res, { error: 'Missing or invalid authorization' });
    if (!userId) return;
    await handleCloseMediaGatewaySession(req, res, userId, mediaGatewaySessionCloseMatch[1]);
    return;
  }

  const mediaGatewaySessionRenewMatch = url.pathname.match(/^\/api\/media\/gateway\/session\/([a-f0-9]{16,64})\/renew$/);
  if (mediaGatewaySessionRenewMatch && req.method === "POST") {
    const userId = requireAuthenticatedUser(req, res, { error: 'Missing or invalid authorization' });
    if (!userId) return;
    await handleRenewMediaGatewaySession(req, res, userId, mediaGatewaySessionRenewMatch[1]);
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

  const webhookDeliveryMatch = url.pathname.match(/^\/api\/webhooks\/deliveries\/(\d+)$/);
  if (webhookDeliveryMatch && req.method === "GET") {
    await handleGetWebhookDelivery(req, res, parseInt(webhookDeliveryMatch[1], 10));
    return;
  }

  const webhookDeliveryRetryMatch = url.pathname.match(/^\/api\/webhooks\/deliveries\/(\d+)\/retry$/);
  if (webhookDeliveryRetryMatch && req.method === "POST") {
    await handleRetryWebhookDelivery(req, res, parseInt(webhookDeliveryRetryMatch[1], 10));
    return;
  }

  const webhookPatchMatch = url.pathname.match(/^\/api\/webhooks\/(\d+)$/);
  if (webhookPatchMatch && req.method === "PATCH") {
    await handleUpdateWebhook(req, res, parseInt(webhookPatchMatch[1], 10));
    return;
  }

  const webhookRotateMatch = url.pathname.match(/^\/api\/webhooks\/(\d+)\/rotate-secret$/);
  if (webhookRotateMatch && req.method === "POST") {
    await handleRotateWebhookSecret(req, res, parseInt(webhookRotateMatch[1], 10));
    return;
  }

  const webhookTestMatch = url.pathname.match(/^\/api\/webhooks\/(\d+)\/test$/);
  if (webhookTestMatch && req.method === "POST") {
    await handleTestWebhook(req, res, parseInt(webhookTestMatch[1], 10));
    return;
  }

  const webhookDeleteMatch = url.pathname.match(/^\/api\/webhooks\/(\d+)$/);
  if (webhookDeleteMatch && req.method === "DELETE") {
    await handleDeleteWebhook(req, res, parseInt(webhookDeleteMatch[1], 10));
    return;
  }

  if (url.pathname === "/api/places" && req.method === "GET") {
    await handleGetPlaces(req, res);
    return;
  }

  if (url.pathname === "/api/places" && req.method === "POST") {
    const userId = requirePluginAdminUser(req, res);
    if (!userId) return;
    await handleUpsertPlace(req, res);
    return;
  }

  const placeDeleteMatch = url.pathname.match(/^\/api\/places\/([^/]+)$/);
  if (placeDeleteMatch && req.method === "DELETE") {
    const userId = requirePluginAdminUser(req, res);
    if (!userId) return;
    await handleDeletePlace(req, res, decodeURIComponent(placeDeleteMatch[1]));
    return;
  }

  // Verify guest access code
  if (url.pathname === "/api/guest/verify-code" && req.method === "POST") {
    try {
      const body = await readJsonObjectBody(req);
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      if (!code) {
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
      if (isRequestBodyTooLargeError(error)) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ valid: false, error: 'Verification payload too large' }));
        return;
      }
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ valid: false, error: 'Invalid verification payload' }));
    }
    return;
  }

  // Get list of registered users for task assignment
  if (url.pathname === "/api/users" && req.method === "GET") {
    const userId = requireAuthenticatedUser(req, res);
    if (!userId) return;

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

  if (url.pathname === "/api/dictionary" && req.method === "GET") {
    await handleDictionaryLookup(req, res, url);
    return;
  }

  if (url.pathname === "/api/albums" && req.method === "GET") {
    const userId = requireAuthenticatedUser(req, res);
    if (!userId) return;
    await handleListAlbums(req, res, url, userId);
    return;
  }

  if (url.pathname === "/api/albums" && req.method === "POST") {
    const userId = requireAuthenticatedUser(req, res);
    if (!userId) return;
    await handleCreateAlbum(req, res, userId);
    return;
  }

  const albumDeleteMatch = url.pathname.match(/^\/api\/albums\/(\d+)$/);
  if (albumDeleteMatch && req.method === "DELETE") {
    const userId = requireAuthenticatedUser(req, res);
    if (!userId) return;
    await handleDeleteAlbum(req, res, userId, albumDeleteMatch[1]);
    return;
  }

  const albumFeaturedMatch = url.pathname.match(/^\/api\/albums\/(\d+)\/featured$/);
  if (albumFeaturedMatch && req.method === "PATCH") {
    const userId = requireAuthenticatedUser(req, res);
    if (!userId) return;
    await handleSetAlbumFeatured(req, res, userId, albumFeaturedMatch[1]);
    return;
  }

  const albumItemsMatch = url.pathname.match(/^\/api\/albums\/(\d+)\/items$/);
  if (albumItemsMatch && req.method === "GET") {
    const userId = requireAuthenticatedUser(req, res);
    if (!userId) return;
    await handleListAlbumItems(req, res, url, userId, albumItemsMatch[1]);
    return;
  }

  if (albumItemsMatch && req.method === "POST") {
    const userId = requireAuthenticatedUser(req, res);
    if (!userId) return;
    await handleAddAlbumItem(
      req,
      res,
      userId,
      albumItemsMatch[1],
      getPolicyValue<AlbumUploadLimitConfig>(ALBUM_UPLOAD_LIMITS_POLICY_KEY)
    );
    return;
  }

  const albumItemsReorderMatch = url.pathname.match(/^\/api\/albums\/(\d+)\/items\/reorder$/);
  if (albumItemsReorderMatch && req.method === "PATCH") {
    const userId = requireAuthenticatedUser(req, res);
    if (!userId) return;
    await handleReorderAlbumItems(req, res, userId, albumItemsReorderMatch[1]);
    return;
  }

  const albumItemDeleteMatch = url.pathname.match(/^\/api\/albums\/(\d+)\/items\/(\d+)$/);
  if (albumItemDeleteMatch && req.method === "DELETE") {
    const userId = requireAuthenticatedUser(req, res);
    if (!userId) return;
    await handleDeleteAlbumItem(req, res, userId, albumItemDeleteMatch[1], albumItemDeleteMatch[2]);
    return;
  }

  if (url.pathname === "/api/dictionary" && req.method === "POST") {
    const userId = requireAuthenticatedUser(req, res);
    if (!userId) return;
    await handleDictionaryUpsert(req, res, userId);
    return;
  }

  if (url.pathname === "/api/dictionary" && req.method === "DELETE") {
    const userId = requireAuthenticatedUser(req, res);
    if (!userId) return;
    const roles = getUserRoles(userId, 'default-workspace');
    const canModerate = roles.includes('owner') || roles.includes('admin') || roles.includes('mod');
    await handleDictionaryDelete(req, res, userId, canModerate);
    return;
  }

  // Toggle business private mode
  if (url.pathname === "/api/user/business-private-mode" && req.method === "POST") {
    const userId = requireAuthenticatedUser(req, res);
    if (!userId) return;

    try {
      const body = await readJsonObjectBody(req);
      const privateMode = parseBooleanRequestValue(body.privateMode);
      if (privateMode == null) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: 'privateMode must be a boolean value' }));
        return;
      }

      settingsRepository.set(userId, { business_private_mode: privateMode ? 1 : 0 });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, privateMode }));
    } catch (error) {
      if (isRequestBodyTooLargeError(error)) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: 'Setting payload too large' }));
        return;
      }
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Invalid setting payload' }));
    }
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
  if (_businessSyncInFlight) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: 'Singleton sync in progress' }));
    return;
  }
  _businessSyncInFlight = true;
    // Default: shared workspace for collaboration
    let workspaceId = defaultWorkspaceId;

    // Check if user wants private workspace
    const userId = getAuthenticatedUserId(req);

    // Guest validation: check for verified guest code
    if (!userId) {
      // This is a guest - check for guest code header
      const guestCode = req.headers['x-guest-code'] as string;

      if (!guestCode || !guestCodeRepository.isValidCode(guestCode)) {
        _businessSyncInFlight = false;
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

    try {
      const body = await readJsonObjectBody(req);
      const businessData = sanitizeBusinessData(body, workspaceId);

      businessWorkspaces.set(workspaceId, businessData);
      saveBusinessData(workspaceId, businessData);

      // If this is a private mode user, mirror signed items to the shared workspace
      if (userId && workspaceId !== defaultWorkspaceId) {
        const sharedData = businessWorkspaces.get(defaultWorkspaceId) || initializeWorkspace(defaultWorkspaceId);

        // Extract signed items from this user's data
        const signedTodos = businessData.todos.filter((t) => t.signedBy);
        const signedProjects = businessData.projects.filter((p) => p.signedBy);
        const signedSprints = businessData.sprints.filter((s) => s.signedBy);
        const signedCalendarEvents = businessData.calendarEvents.filter((e) => e.signedBy);

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
      if (isRequestBodyTooLargeError(error)) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Business sync payload too large' }));
      } else if (isInvalidJsonBodyError(error)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON payload' }));
      } else {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Failed to sync business data' }));
      }
    } finally {
      _businessSyncInFlight = false;
    }
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
      const userId = requireAuthenticatedUser(req, res, { error: 'Missing or invalid authorization' });
      if (!userId) return;

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
    try {
      const userId = requireAuthenticatedUser(req, res, { error: 'Missing or invalid authorization' });
      if (!userId) return;

      const resourceData = await readJsonObjectBody(req);
      const workspaceId = resolveWorkspaceId(userId);
      const workspace = businessWorkspaces.get(workspaceId) || initializeWorkspace(workspaceId);

      const newResource = sanitizeBusinessResourceCreate(resourceData, {
        id: `res-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
        createdBy: String(userId),
        workspaceId
      });
      if (!newResource) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Invalid resource payload' }));
        return;
      }

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
      if (isRequestBodyTooLargeError(error)) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Resource payload too large' }));
      } else if (isInvalidJsonBodyError(error)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON payload' }));
      } else {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Failed to create resource' }));
      }
    }
    return;
  }

  // Update a resource
  if (url.pathname.startsWith("/api/business/resource/") && req.method === "PUT") {
    const resourceId = url.pathname.split("/").pop();
    try {
      const userId = requireAuthenticatedUser(req, res, { error: 'Missing or invalid authorization' });
      if (!userId) return;

      const updates = await readJsonObjectBody(req);
      const workspaceId = resolveWorkspaceId(userId);
      const workspace = businessWorkspaces.get(workspaceId) || initializeWorkspace(workspaceId);

      const resourceIndex = workspace.resources.findIndex((r) => r.id === resourceId);
      if (resourceIndex === -1) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Resource not found' }));
        return;
      }

      const updatedResource = sanitizeBusinessResourceUpdate(workspace.resources[resourceIndex], updates);
      if (!updatedResource) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Invalid resource update payload' }));
        return;
      }

      workspace.resources[resourceIndex] = updatedResource;

      businessWorkspaces.set(workspaceId, workspace);
      saveBusinessData(workspaceId, workspace);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        resource: updatedResource
      }));
    } catch (error) {
      console.error('Update resource error:', error);
      if (isRequestBodyTooLargeError(error)) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Resource payload too large' }));
      } else if (isInvalidJsonBodyError(error)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON payload' }));
      } else {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Failed to update resource' }));
      }
    }
    return;
  }

  // Delete a resource
  if (url.pathname.startsWith("/api/business/resource/") && req.method === "DELETE") {
    const resourceId = url.pathname.split("/").pop();
    try {
      const userId = requireAuthenticatedUser(req, res, { error: 'Missing or invalid authorization' });
      if (!userId) return;

      const workspaceId = resolveWorkspaceId(userId);
      const workspace = businessWorkspaces.get(workspaceId) || initializeWorkspace(workspaceId);

      workspace.resources = workspace.resources.filter((r) => r.id !== resourceId);
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
    const userId = requireAuthenticatedUser(req, res, { success: false, error: 'Unauthorized - authentication required' });
    if (!userId) return;

    let chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MULTIPART_UPLOAD_MAX_BYTES) {
        req.destroy();
        chunks = [];
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (totalBytes > MULTIPART_UPLOAD_MAX_BYTES) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Upload too large' }));
        return;
      }
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

          if (!isSafeRasterImageUpload(fileName, fileData)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: 'Invalid file type. Only PNG, JPG, JPEG, GIF, WEBP are allowed.' }));
            return;
          }

          // Save file
          const fileId = createUploadFileId('emoji-', fileName);
          const filePath = resolveUploadPath(fileId);
          if (!filePath) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: 'Failed to resolve upload path' }));
            return;
          }
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
      res.writeHead(400, { "Content-Type": "application/json", ...getCORSHeaders(req.headers.origin as string) });
      res.end(JSON.stringify({ error: 'Missing url parameter' }));
      return;
    }

    try {
      const PREVIEW_FETCH_TIMEOUT_MS = 8000;
      const OEMBED_FETCH_TIMEOUT_MS = 3000;

      const decodeHtmlEntities = (str: string): string =>
        str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

      const parseYoutubeId = (rawUrl: string): string | null => {
        try {
          const parsed = new URL(rawUrl);
          let candidate: string | null = null;
          const host = parsed.hostname.toLowerCase();
          if (host.includes('youtube.com')) {
            candidate = parsed.searchParams.get('v');
            if (!candidate) {
              const segments = parsed.pathname.split('/').filter(Boolean);
              if (segments.length >= 2 && (segments[0] === 'embed' || segments[0] === 'shorts' || segments[0] === 'live')) {
                candidate = segments[1];
              }
            }
          } else if (host.includes('youtu.be')) {
            candidate = parsed.pathname.slice(1) || null;
          }
          if (!candidate) return null;
          const normalized = candidate.trim();
          if (!/^[A-Za-z0-9_-]{6,20}$/.test(normalized)) return null;
          return normalized;
        } catch {
          return null;
        }
      };

      const youtubeId = parseYoutubeId(targetUrl);
      if (youtubeId) {
        let title: string | null = null;
        let channelName: string | null = null;
        let description: string | null = null;
        const image = `https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg`;
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), OEMBED_FETCH_TIMEOUT_MS);
          try {
            const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${youtubeId}&format=json`;
            const oembedRes = await fetchExternalUrlWithGuards(oembedUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; WabiBot/1.0; +https://wabi.chat)',
                'Accept': 'application/json'
              },
              signal: controller.signal
            });
            if (oembedRes.ok) {
              const oembed = await oembedRes.json() as {
                title?: string;
                author_name?: string;
                thumbnail_url?: string;
              };
              if (typeof oembed.title === 'string') title = oembed.title.trim() || null;
              if (typeof oembed.author_name === 'string') channelName = oembed.author_name.trim() || null;
            }
          } finally {
            clearTimeout(timeout);
          }
        } catch {
          // Best effort only; return stable fallback payload below.
        }

        res.writeHead(200, { "Content-Type": "application/json", ...getCORSHeaders(req.headers.origin as string) });
        res.end(JSON.stringify({
          title: title || 'YouTube',
          description,
          image,
          siteName: 'YouTube',
          type: 'video.other',
          youtubeId,
          channelName,
          video: {
            url: `https://www.youtube.com/embed/${youtubeId}`,
            type: 'text/html',
            width: '1280',
            height: '720'
          },
          twitterCard: 'player',
          twitterPlayer: `https://www.youtube.com/embed/${youtubeId}`
        }));
        return;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PREVIEW_FETCH_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetchExternalUrlWithGuards(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; WabiBot/1.0; +https://wabi.chat)',
            'Accept': 'text/html'
          },
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        res.writeHead(502, { "Content-Type": "application/json", ...getCORSHeaders(req.headers.origin as string) });
        res.end(JSON.stringify({ error: 'Failed to fetch URL' }));
        return;
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) {
        res.writeHead(400, { "Content-Type": "application/json", ...getCORSHeaders(req.headers.origin as string) });
        res.end(JSON.stringify({ error: 'URL is not an HTML page' }));
        return;
      }

      const html = await response.text();

      // Parse OpenGraph and meta tags with simple regex (no dependency needed)
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

      const channelName: string | null = null;
      const previewYoutubeId: string | null = null;

      // For non-YouTube links we keep HTML metadata extraction only.

      res.writeHead(200, { "Content-Type": "application/json", ...getCORSHeaders(req.headers.origin as string) });
      res.end(JSON.stringify({
        title, description, image, siteName, type, youtubeId: previewYoutubeId, channelName,
        video: videoUrl ? { url: videoUrl, type: videoType, width: videoWidth, height: videoHeight } : null,
        twitterCard, twitterPlayer
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch URL preview';
      const status = message.toLowerCase().includes('not allowed') || message.toLowerCase().includes('private')
        ? 400
        : 502;
      res.writeHead(status, { "Content-Type": "application/json", ...getCORSHeaders(req.headers.origin as string) });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // Image proxy endpoint - proxy images to avoid hotlink protection (Instagram, etc.)
  if (url.pathname === "/api/image-proxy" && req.method === "GET") {
    const imageUrl = url.searchParams.get('url');
    if (!imageUrl) {
      res.writeHead(400, { "Content-Type": "application/json", ...getCORSHeaders(req.headers.origin as string) });
      res.end(JSON.stringify({ error: 'Missing url parameter' }));
      return;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      let response: Response;
      try {
        response = await fetchExternalUrlWithGuards(imageUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; WabiBot/1.0; +https://wabi.chat)',
            'Accept': 'image/*'
          },
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        res.writeHead(502, { "Content-Type": "application/json", ...getCORSHeaders(req.headers.origin as string) });
        res.end(JSON.stringify({ error: 'Failed to fetch image' }));
        return;
      }

      const contentType = response.headers.get('content-type') || 'image/jpeg';
      const buffer = Buffer.from(await response.arrayBuffer());

      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400",
        ...getCORSHeaders(req.headers.origin as string)
      });
      res.end(buffer);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to proxy image';
      const status = message.toLowerCase().includes('not allowed') || message.toLowerCase().includes('private')
        ? 400
        : 502;
      res.writeHead(status, { "Content-Type": "application/json", ...getCORSHeaders(req.headers.origin as string) });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // Delete all messages endpoint
  if (url.pathname === "/api/debug/message-stats" && req.method === "GET") {
    const userId = requireAuthenticatedUser(
      req,
      res,
      { success: false, error: 'Unauthorized - authentication required' }
    );
    if (!userId) return;

    try {
      const dbMessagesCount = (db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number }).count;
      const dbOfflineMessagesCount = (db.prepare('SELECT COUNT(*) as count FROM offline_messages').get() as { count: number }).count;
      let inMemoryMessagesCount = 0;
      const nonEmptyChannels: Array<{ channelId: string; count: number }> = [];
      channelMessages.forEach((messages, channelId) => {
        const count = messages.length;
        inMemoryMessagesCount += count;
        if (count > 0) {
          nonEmptyChannels.push({ channelId, count });
        }
      });

      res.writeHead(200, { "Content-Type": "application/json", ...getCORSHeaders(req.headers.origin as string) });
      res.end(JSON.stringify({
        success: true,
        messagePurgeVersion: getMessagePurgeVersion(),
        dbMessagesCount,
        dbOfflineMessagesCount,
        inMemoryMessagesCount,
        nonEmptyChannels
      }));
    } catch (error) {
      console.error('Message stats error:', error);
      res.writeHead(500, { "Content-Type": "application/json", ...getCORSHeaders(req.headers.origin as string) });
      res.end(JSON.stringify({ success: false, error: 'Failed to read message stats' }));
    }
    return;
  }

  if (url.pathname === "/api/clear-messages" && req.method === "POST") {
    const userId = requireAuthenticatedUser(
      req,
      res,
      { success: false, error: 'Unauthorized - authentication required' }
    );
    if (!userId) return;

    const roles = getUserRoles(userId, 'default-workspace');
    if (!roles.includes('owner') && !roles.includes('admin')) {
      res.writeHead(403, { "Content-Type": "application/json", ...getCORSHeaders(req.headers.origin as string) });
      res.end(JSON.stringify({ success: false, error: 'Forbidden - owner/admin required' }));
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

      // Cancel and clear all pending deletion timers
      clearAllMessageDeletionTimers();

      // Clear persisted messages from database
      const deletedDbMessages = stateMessageStore.clearAll();
      const deletedOfflineMessages = offlineMessageRepository.clearAll();

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

      const messagePurgeVersion = bumpMessagePurgeVersion();

      // Notify all connected clients to clear local in-memory + persisted message state.
      io.emit("messages-cleared", { scope: "all", messagePurgeVersion });

      res.writeHead(200, { "Content-Type": "application/json", ...getCORSHeaders(req.headers.origin as string) });
      res.end(JSON.stringify({
        success: true,
        message: "All messages and files cleared from server",
        deletedDbMessages,
        deletedOfflineMessages,
        messagePurgeVersion
      }));
    } catch (error) {
      console.error('Clear messages error:', error);
      res.writeHead(500, { "Content-Type": "application/json", ...getCORSHeaders(req.headers.origin as string) });
      res.end(JSON.stringify({ success: false, error: 'Failed to clear messages' }));
    }
    return;
  }

  // Serve uploaded files from dedicated uploads directory
  if (url.pathname.startsWith('/uploads/')) {
    const fileId = normalizeUploadFileIdFromUrl(url.pathname);
    if (!fileId) {
      res.writeHead(403);
      res.end("Access denied");
      return;
    }

    serveUploadByFileId(req, res, fileId, {
      cacheControl: 'public, max-age=31536000, immutable'
    });
    return;
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
            const contentType = 'text/html';
            const compressed = maybeCompressTextResponse(req, contentType, file);
            const headers: Record<string, string | number> = {
              "Content-Type": contentType,
              "Content-Length": compressed.payload.length
            };
            if (compressed.contentEncoding) {
              headers['Content-Encoding'] = compressed.contentEncoding;
              headers['Vary'] = 'Accept-Encoding';
            }
            res.writeHead(200, headers);
            res.end(compressed.payload);
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

      const contentType = contentTypes[ext || 'html'] || 'application/octet-stream';
      const compressed = maybeCompressTextResponse(req, contentType, file);
      const headers: Record<string, string | number> = {
        "Content-Type": contentType,
        "Content-Length": compressed.payload.length
      };
      if (compressed.contentEncoding) {
        headers['Content-Encoding'] = compressed.contentEncoding;
        headers['Vary'] = 'Accept-Encoding';
      }
      res.writeHead(200, headers);
      res.end(compressed.payload);
      return;
    }

    // If file doesn't exist and it's not an API or upload request, serve index.html for client-side routing
    if (!url.pathname.startsWith('/api') && !url.pathname.startsWith('/uploads')) {
      const indexPath = join(STATIC_DIR, "index.html");
      if (existsSync(indexPath)) {
        const file = readFileSync(indexPath);
        const contentType = "text/html";
        const compressed = maybeCompressTextResponse(req, contentType, file);
        const headers: Record<string, string | number> = {
          "Content-Type": contentType,
          "Content-Length": compressed.payload.length
        };
        if (compressed.contentEncoding) {
          headers['Content-Encoding'] = compressed.contentEncoding;
          headers['Vary'] = 'Accept-Encoding';
        }
        res.writeHead(200, headers);
        res.end(compressed.payload);
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

  // Migration: add watch_queue_enabled column to channels if missing
  try {
    db.prepare('ALTER TABLE channels ADD COLUMN watch_queue_enabled INTEGER DEFAULT 0').run();
    console.log('[Database] Added watch_queue_enabled column to channels');
  } catch (_) {
    // Column already exists - ignore
  }

  // Ensure base channels exist in DB and load text/voice channels
  channelRepository.ensureBaseChannelsExist();
  const dbChannels = channelRepository.getWorkspaceChannels();
  applyWorkspaceChannelsToMemory(dbChannels);
  console.log(`[Database] ✅ Loaded ${dbChannels.length} channels from database`);
} catch (error) {
  console.error('[Database] ❌ Initialization failed:', error);
  process.exit(1);
}

// Start background job for expired offline message cleanup (hourly)
const runWhiteboardOrphanCleanup = (logLabel: string): void => {
  try {
    const stats = cleanupWhiteboardOrphanUploads(logLabel, () => whiteboardRepository.listAll(), ENABLE_LOGGING);
    if (stats.deletedFiles > 0 || stats.retainedByGrace > 0) {
      console.log(
        `[${logLabel}] scanned=${stats.scannedFiles} deleted=${stats.deletedFiles} retainedByGrace=${stats.retainedByGrace} referenced=${stats.referencedCount} boards=${stats.boardCount}`
      );
    }
  } catch (error) {
    console.error(`[${logLabel}] Failed whiteboard orphan cleanup:`, error);
  }
};

const cleanupInterval = setInterval(() => {
  try {
    const deleted = offlineMessageRepository.deleteExpired();
    if (deleted > 0) {
      console.log(`[Cleanup] Deleted ${deleted} expired offline messages`);
    }
  } catch (error) {
    console.error('[Cleanup] Failed offline message cleanup:', error);
  }

  try {
    const expiredPurged = stateMessageStore.purgeExpired();
    if (expiredPurged > 0) {
      console.log(`[Cleanup] Purged ${expiredPurged} expired retained messages from DB`);
    }
  } catch (error) {
    console.error('[Cleanup] Failed retained message expiry cleanup:', error);
  }

  try {
    // Hard-purge soft-deleted messages older than 7 days to reclaim DB space
    const purged = stateMessageStore.purgeDeleted();
    if (purged > 0) {
      console.log(`[Cleanup] Purged ${purged} soft-deleted messages from DB`);
    }
  } catch (error) {
    console.error('[Cleanup] Failed message purge cleanup:', error);
  }

  try {
    // Remove expired sessions
    const expiredSessions = sessionRepository.cleanup();
    if (expiredSessions > 0) {
      console.log(`[Cleanup] Deleted ${expiredSessions} expired sessions`);
    }
  } catch (error) {
    console.error('[Cleanup] Failed session cleanup:', error);
  }

  runWhiteboardOrphanCleanup('WhiteboardCleanup');
}, 60 * 60 * 1000); // 1 hour
const whiteboardOrphanCleanupStartupTimer = setTimeout(() => {
  runWhiteboardOrphanCleanup('WhiteboardCleanupStartup');
}, WHITEBOARD_ORPHAN_UPLOAD_CLEANUP_STARTUP_DELAY_MS);
whiteboardOrphanCleanupStartupTimer.unref();

let shuttingDown = false;
let selfHostedBoosterRelayAdvertiser: ReturnType<typeof startSelfHostedBoosterRelayAdvertiser> | null = null;
const shutdown = (signal: 'SIGINT' | 'SIGTERM') => {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n[Server] ${signal} received. Shutting down...`);
  clearInterval(cleanupInterval);
  clearTimeout(whiteboardOrphanCleanupStartupTimer);
  selfHostedBoosterRelayAdvertiser?.stop();
  stopStateMeshRuntime();
  stopStatePlaneRuntime();

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
configureStateMeshRuntime(() => getMeshConnectionCounts());
startStatePlaneRuntime();
startStateMeshRuntime();
selfHostedBoosterRelayAdvertiser = startSelfHostedBoosterRelayAdvertiser();
try {
  applyWorkspaceChannelsToMemory(channelRepository.getWorkspaceChannels());
} catch (error) {
  console.warn('[StatePlane] Failed to hydrate workspace channels from active store:', error);
}
console.log('[Server] Listening on 0.0.0.0:' + PORT);

// Helper function to emit to channel members only
function emitToChannel(channelId: string, event: string, data: any) {
  const channel = channels.get(channelId);
  if (!channel) return;

  if (channel.members && channel.members.length > 0) {
    channel.members.forEach(stableId => {
      emitToStableUser(stableId, event, data);
    });
  } else {
    io.emit(event, data);
    emitMeshBroadcast(event, data);
  }
}

function isAnnouncementCapableChannelType(type: DbChannel['channel_type']): boolean {
  return type === 'text' || type === 'public' || type === 'thread_public' || type === 'thread_private';
}

function postSystemAnnouncementToChannel(channelId: string, text: string): void {
  const dbChannel = channelRepository.findById(channelId);
  if (!dbChannel || !isAnnouncementCapableChannelType(dbChannel.channel_type)) {
    throw new Error('Community node announcements require an existing text-capable channel.');
  }

  const now = Date.now();
  const message: RealtimeChannelMessage = {
    id: createRealtimeMessageId('system'),
    user: 'System',
    userId: 'system',
    senderStableId: 'system',
    text,
    timestamp: now,
    type: 'text',
    color: '#7f8ea3'
  };

  const messages = channelMessages.get(channelId) || [];
  messages.push(message);
  channelMessages.set(channelId, messages);
  emitToChannel(channelId, "message", { channelId, message });

  try {
    stateMessageStore.create(buildPersistedMessageFromRealtime(channelId, message));
  } catch (error) {
    console.error('[CommunityNodes] Failed to persist announcement message:', error);
  }
}

registerCommunityNodeAnnouncementDispatcher(({ channelId, text }) => {
  postSystemAnnouncementToChannel(channelId, text);
});

({
  getAutoDeleteMs,
  scheduleMessageDeletion,
  clearAllDeletionTimers: clearAllMessageDeletionTimers,
  deleteMessage: deleteRealtimeMessage
} = createMessageLifecycle({
  channelMessages,
  pinnedMessages,
  deleteUploadFileByUrl,
  softDeleteMessage: (messageId) => {
    stateMessageStore.softDelete(messageId);
  },
  emitToChannel,
  onMessageRemoved: (_channelId, messageId) => {
    messagePersistenceRetryAttempts.delete(messageId);
  },
  enableLogging: ENABLE_LOGGING
}));

const loadUserChannelsFromDB = (stableUserId: string, currentHighestRole?: string): Channel[] =>
  loadUserChannelsFromDb({
    stableUserId,
    currentHighestRole,
    channels,
    channelMessages,
    preloadHistoryOnLogin: PRELOAD_CHANNEL_HISTORY_ON_LOGIN,
    enableLogging: ENABLE_LOGGING,
    findChannelsByUserId: (stableId) => channelRepository.findByUserId(stableId),
    getChannelMemberIds: (channelId) => channelMemberRepository.getMemberIds(channelId),
    buildChannel: (dbChannel, memberIds) => ({
      id: dbChannel.channel_id,
      name: dbChannel.name,
      description: dbChannel.description || '',
      watchQueueEnabled: dbChannel.watch_queue_enabled === 1,
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
      autoDeleteAfter: resolvePersistedChannelRetention(dbChannel.auto_delete_after, dbChannel.channel_type),
      persistMessages: dbChannel.persist_messages === 1,
      voiceSettings: parseVoiceSettings(dbChannel.voice_settings_json),
      recipientNotified: true
    }),
    loadRecentMessages: (channelId) => stateMessageStore.getByChannel(channelId, { limit: 50 }).map((message) => stateMessageStore.toClientFormat(message)),
    getUserRoleInfo: (dbUserId) => getUserRoleInfo(dbUserId),
    getRolePriority
  });

const enrichDMChannels = (
  channelList: Channel[],
  myStableId: string,
  registeredUsersByDbId?: Map<number, any>
): any[] =>
  enrichDmChannelsView({
    channelList,
    myStableId,
    registeredUsersByDbId,
    resolveSocketId,
    users,
    findUserById: (dbUserId) => userRepository.findById(dbUserId),
    getChannelMembers: (channelId) => channelMemberRepository.getMembers(channelId),
    findChannelById: (channelId) => channelRepository.findById(channelId)
  });

if (ENABLE_LOGGING) {
  console.log(`🚀 Community Chat server running on port ${PORT}`);
}

// Initialize plugin system
const pluginLoader = new PluginLoader(io, server, {
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
  const token =
    (typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : null) ||
    getAuthTokenFromHeaders(socket.handshake.headers);
  const sessionId = socket.handshake.auth.sessionId;

  if (token) {
    // Registered user with JWT
    try {
      const payload = verifyToken(token);
      const dbSession = sessionRepository.findById(payload.sessionId);

      if (!dbSession || (dbSession.expires_at && dbSession.expires_at < Date.now())) {
        return next(new Error('Session expired'));
      }
      const account = typeof payload.userId === 'number' ? userRepository.findById(payload.userId) : null;
      if (!account || account.is_active === 0) {
        return next(new Error('Account banned'));
      }

      (socket as any).sessionId = payload.sessionId;
      (socket as any).userId = payload.userId;
      (socket as any).isRegistered = true;
      (socket as any).dbUserId = payload.userId;
      (socket as any).registeredSession = dbSession;
      (socket as any).registeredAccount = account;
      next();
    } catch (error) {
      return next(new Error('Invalid token'));
    }
  } else if (sessionId && sessions.has(sessionId)) {
    // Temp user with in-memory session
    const tempSession = sessions.get(sessionId);
    if (tempSession && tempSession.dbUserId) {
      const account = userRepository.findById(tempSession.dbUserId);
      if (account && account.is_active === 0) {
        return next(new Error('Account banned'));
      }
    }
    (socket as any).sessionId = sessionId;
    (socket as any).userId = tempSession?.userId;
    (socket as any).isRegistered = false;
    next();
  } else {
    // Allow new connection (will be assigned temp session on join)
    next();
  }
});

io.on("connection", (socket) => {
  const disconnectOtherRegisteredSockets = (dbUserId: number): void => {
    disconnectOtherRegisteredSocketsForSocket({
      io: io as any,
      socket: socket as any,
      dbUserId,
      dbUserIdToSocketId
    });
  };
  console.log(`🔌 WebSocket connection established: ${socket.id}`);
  applySocketRateLimiting(socket as any);

  const {
    getSocketStableId,
    getSocketHighestRole,
    socketMeetsRoleRequirement,
    canManageVoiceBreakouts,
    canMoveVoiceMember,
    canAccessChannel,
    getAccessibleChannel
  } = createSocketChannelGuards({
    socket,
    users,
    channels,
    getStableUserId: (targetSocket) => getStableUserId(targetSocket),
    getRolePriority: (roleName) => getRolePriority(roleName),
    findUserByStableId
  });

  const emitToCallTarget = (rawTargetId: string | null | undefined, event: string, data: unknown): boolean => {
    const normalizedTargetId = rawTargetId?.trim();
    if (!normalizedTargetId) return false;
    const stableTargetId = resolveStableUserIdFromAny(normalizedTargetId);
    if (stableTargetId) {
      return emitToStableUser(stableTargetId, event, data);
    }
    if (users.has(normalizedTargetId)) {
      io.to(normalizedTargetId).emit(event, data);
      return true;
    }
    return false;
  };

  const {
    initiateDirectCall,
    answerDirectCall,
    rejectDirectCall,
    cancelDirectCall,
    endDirectCall,
    teardownDirectCallsForDisconnect
  } = createDirectCallLifecycle({
    emitToCallTarget,
    emitMeshBroadcast,
    emitSocketBroadcast: (event, payload) => {
      socket.broadcast.emit(event, payload);
    },
    resolveStableUserIdFromAny,
    resolveSocketId,
    hasLocalSocket: (socketId) => users.has(socketId),
    isStableUserConnected,
    addCallPeer,
    removeAllCallPeers,
    addVoicePeerLink,
    removeVoicePeerLink,
    removeAllVoicePeerLinks,
    emitDirectCallRecordingPresenceForSocket,
    emitDirectCallRecordingPresenceForSocketSet,
    clearAllRecordingPresenceForStableUser
  });

  const {
    emitRoleDefinitions,
    syncDbUserRoleState,
    emitEmojiRoleRules,
    applyEmojiRoleRules
  } = createRoleRuntimeSupport({
    io,
    users,
    channelMessages,
    getRoleDefinitions: () => getRoleDefinitions('default-workspace'),
    getUserRoleInfo,
    emitGlobalEvent,
    listEmojiRoleRules: () =>
      db.prepare(`
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
      }>,
    listMatchingEmojiRoleAssignments: (channelId, messageId, emojiId) =>
      db.prepare(`
        SELECT role_name, remove_on_unreact
        FROM emoji_role_rules
        WHERE workspace_id = ? AND enabled = 1 AND channel_id = ? AND message_id = ? AND emoji_id = ?
      `).all('default-workspace', channelId, messageId, emojiId) as Array<{
        role_name: string;
        remove_on_unreact: number;
      }>,
    assignRole: (targetUserId, roleName) => {
      assignRole(targetUserId, roleName as any, 'default-workspace');
    },
    removeRole: (targetUserId, roleName) => {
      removeRole(targetUserId, roleName as any, 'default-workspace');
    }
  });

  registerJoinInitializationHandler({
    socket,
    users,
    sessions,
    isSocketRegistered: () => Boolean((socket as any).isRegistered),
    getSocketSessionId: () => (socket as any).sessionId,
    getSocketDbUserId: () => (socket as any).dbUserId,
    getRegisteredSession: () => (socket as any).registeredSession,
    getRegisteredAccount: () => (socket as any).registeredAccount,
    findRegisteredSessionById: (sessionId) => sessionRepository.findById(sessionId),
    disconnectOtherRegisteredSockets,
    ensureWorkspaceOwnerDuringJoin: (dbUserId, username) => {
      if (!workspaceHasOwner()) {
        assignRole(dbUserId, 'owner', 'default-workspace');
        console.log(`[Roles] Auto-assigned owner to ${username} (user_id=${dbUserId}) because workspace had no owner`);
      }
    },
    getAllDbUsers: () => userRepository.getAll(),
    buildRoleLookup: () => buildWorkspaceRoleLookup('default-workspace'),
    getUserRoleInfo: (dbUserId, roleLookup) => getUserRoleInfo(dbUserId, roleLookup),
    getSocketStableId,
    setRegisteredSocket: (dbUserId, socketId) => {
      dbUserIdToSocketId.set(dbUserId, socketId);
    },
    registerStateMeshSocketLease: (stableUserId, dbUserId) => registerStateMeshSocketLease(stableUserId, dbUserId),
    setSocketMeshLeaseConnectedAt: (value) => {
      (socket as any).meshLeaseConnectedAt = value;
    },
    upsertPresenceLeaseForUser,
    setSocketMeshPresenceConnectedAt: (value) => {
      (socket as any).meshPresenceConnectedAt = value;
    },
    loadUserChannelsFromDB,
    enrichDMChannels,
    buildDistributedUsersSnapshot: (allDbUsers, roleLookup) => buildDistributedUsersSnapshot(allDbUsers, roleLookup),
    buildServerMembersSnapshot: (allDbUsers, roleLookup) => buildServerMembersSnapshotView({
      allDbUsers,
      roleLookup,
      getAllDbUsers: () => userRepository.getAll(),
      getUserRoleInfo: (dbUserId, activeRoleLookup) => getUserRoleInfo(dbUserId, activeRoleLookup)
    }),
    getVoiceStatePayload,
    getEmotes: () => Array.from(emotes.values()),
    getRoleDefinitions: () => getRoleDefinitions('default-workspace'),
    getMessagePurgeVersion,
    getStatePlaneEffectiveMode: () => 'stdb_primary',
    deliverOfflineMessages: async (targetSocket, dbUserId) => {
      await deliverOfflineMessagesToSocket(targetSocket, dbUserId ?? null, offlineMessageRepository);
    },
    emitUserJoinedBroadcast: (joinedUser, source) => {
      const publicJoinedUser = toPublicUser(joinedUser);
      socket.broadcast.emit("user-joined", publicJoinedUser);
      emitMeshBroadcast("user-joined", publicJoinedUser);
      recordPresenceStateEvent(socket, 'user_joined', { source });
    },
    emitUserJoinedHooks: (joinedUser) => {
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
    },
    generateSessionId,
    logEnabled: ENABLE_LOGGING,
    log: (...args) => console.log(...args)
  });

  registerSessionProfileHandlers({
    socket,
    users,
    sessions,
    userCurrentChannel,
    getSocketStableId,
    isSocketRegistered: () => Boolean((socket as any).isRegistered),
    getSocketSessionId: () => (socket as any).sessionId,
    getSocketDbUserId: () => (socket as any).dbUserId,
    setRegisteredSocket: (dbUserId, socketId) => {
      dbUserIdToSocketId.set(dbUserId, socketId);
    },
    registerStateMeshSocketLease: (stableUserId, dbUserId) => registerStateMeshSocketLease(stableUserId, dbUserId),
    setSocketMeshLeaseConnectedAt: (value) => {
      (socket as any).meshLeaseConnectedAt = value;
    },
    getSocketMeshPresenceConnectedAt: () => (socket as any).meshPresenceConnectedAt ?? null,
    setSocketMeshPresenceConnectedAt: (value) => {
      (socket as any).meshPresenceConnectedAt = value;
    },
    loadRegisteredRejoinProfile: (socketSessionId) => {
      const dbSession = sessionRepository.findById(socketSessionId);
      if (!dbSession?.user_id) return null;
      const userRecord = userRepository.findById(dbSession.user_id);
      if (!userRecord) return null;
      return {
        usernameFont: {
          family: userRecord.username_font_family,
          size: userRecord.username_font_size,
          weight: userRecord.username_font_weight,
          style: userRecord.username_font_style
        },
        handle: userRecord.handle
      };
    },
    ensureWorkspaceOwnerForRegisteredUser,
    loadUserChannelsFromDB: (stableUserId) => loadUserChannelsFromDB(stableUserId),
    enrichDMChannels: (loadedChannels, stableUserId) => enrichDMChannels(loadedChannels, stableUserId),
    upsertPresenceLeaseForUser,
    buildDistributedUsersSnapshot: () => buildDistributedUsersSnapshot(),
    buildServerMembersSnapshot: () => buildServerMembersSnapshotView({
      getAllDbUsers: () => userRepository.getAll(),
      getUserRoleInfo: (dbUserId, roleLookup) => getUserRoleInfo(dbUserId, roleLookup),
      roleLookup: buildWorkspaceRoleLookup()
    }),
    getVoiceStatePayload,
    getEmotes: () => Array.from(emotes.values()),
    getAllEmojis,
    getRoleDefinitions: () => getRoleDefinitions('default-workspace'),
    getMessagePurgeVersion,
    deliverOfflineMessages: (targetSocket, dbUserId) => deliverOfflineMessagesToSocket(targetSocket, dbUserId, offlineMessageRepository),
    emitUserJoinedSideEffects: (joinedUser, source) => {
      const publicJoinedUser = toPublicUser(joinedUser);
      socket.broadcast.emit("user-joined", publicJoinedUser);
      emitMeshBroadcast("user-joined", publicJoinedUser);
      recordPresenceStateEvent(socket, 'user_joined', { source });
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
    },
    findRegisteredUserByUsername: (username) => userRepository.findByUsername(username),
    persistRegisteredProfileUpdate: (socketSessionId, user) => {
      const dbSession = sessionRepository.findById(socketSessionId);
      if (!dbSession) return;

      sessionRepository.update(socketSessionId, {
        username: user.username,
        profile_picture: user.profilePicture || null
      });

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

      if (ENABLE_LOGGING) {
        console.log(`[DB] Updated profile for ${user.username}`);
      }
    },
    recordProfileUpdated: (changedFields, profilePictureSet) => {
      recordPresenceStateEvent(socket, 'profile_updated', {
        changedFields,
        profilePictureSet
      });
    },
    emitProfileUpdated: (user) => {
      emitGlobalEvent("profile-updated", toPublicUser(user));
    },
    getAccessibleChannel,
    loadRecentChannelMessages: (channelId, persistMessages) => {
      if (persistMessages) {
        try {
          const dbMessages = stateMessageStore.getByChannel(channelId, { limit: 50 });
          return {
            messages: dbMessages.map((message) => stateMessageStore.toClientFormat(message)),
            hasMore: stateMessageStore.getChannelMessageCount(channelId) > 50
          };
        } catch (error) {
          console.error(`[join-channel] DB query failed for ${channelId}:`, error);
        }
      }

      const messages = channelMessages.get(channelId) || [];
      const recent = messages.slice(-50);
      return { messages: recent, hasMore: messages.length > 50 };
    },
    logAccessDenied: (channelId) => {
      console.error(`[join-channel] Access denied or missing channel ${channelId} for user ${socket.id}`);
    },
    logEnabled: ENABLE_LOGGING,
    log: (...args) => console.log(...args)
  });

  // Handle history loading with pagination
  // (M5) Deduplicate identical in-flight history requests while allowing newer navigation requests through.
  if (typeof _historyLoadInFlight === 'undefined') {
    // @ts-ignore - dynamic declaration (for patch-only file)
    var _historyLoadInFlight: Set<string> = new Set();
  }
  registerMessagePipelineHandlers({
    socket,
    users,
    channels,
    channelMessages,
    typingUsers,
    channelTypingUsers,
    historyLoadInFlight: _historyLoadInFlight,
    getAccessibleChannel,
    canAccessChannel,
    getSocketStableId,
    getSocketHighestRole,
    getRetryAttempts: (messageId) => messagePersistenceRetryAttempts.get(messageId) ?? 0,
    loadPersistedHistory: ({ channelId, limit, beforeMessageId, afterMessageId }) => {
      const dbMessages = stateMessageStore.getByChannel(channelId, {
        limit,
        beforeMessageId,
        afterMessageId
      });
      return dbMessages.map((message) => stateMessageStore.toClientFormat(message));
    },
    handleTestingRoleCheatcode: (normalizedText, user) => {
      const isRoleCheatcodeMessage =
        TEST_ROLE_CHEATCODE_ENABLED &&
        !testRoleCheatcodeConsumed &&
        normalizedText.length > 0 &&
        normalizedText === TEST_ROLE_CHEATCODE_PHRASE;

      if (!isRoleCheatcodeMessage) return false;

      if (workspaceHasOwner()) {
        testRoleCheatcodeConsumed = true;
        socket.emit("channel-error", "Testing role cheatcode is disabled because an owner already exists.");
        return true;
      }

      if (!user.dbUserId) {
        socket.emit("channel-error", "Testing role cheatcode only works for registered users.");
        return true;
      }

      try {
        assignRole(user.dbUserId, TEST_ROLE_CHEATCODE_ROLE as any, 'default-workspace');
        syncDbUserRoleState(user.dbUserId);
        testRoleCheatcodeConsumed = true;
        socket.emit("channel-error", `[TEST] Role granted: ${TEST_ROLE_CHEATCODE_ROLE}. Cheatcode is now disabled.`);
        console.log(`[RoleCheatcode] Granted ${TEST_ROLE_CHEATCODE_ROLE} to user_id ${user.dbUserId}; cheatcode disabled.`);
      } catch {
        socket.emit("channel-error", "Failed to apply testing role cheatcode.");
      }
      return true;
    },
    validateRoleGateMessage: (user, data) => {
      if (!user.dbUserId) {
        return "Only registered admins can create role-gate posts";
      }
      const myRoleInfo = getUserRoleInfo(user.dbUserId);
      if (!['owner', 'admin'].includes(myRoleInfo.highestRole)) {
        return "Only owner/admin can create role-gate posts";
      }
      if (!data.text || !data.text.trim()) {
        return "Role-gate post content cannot be empty";
      }
      return null;
    },
    createMessageId: (senderStableId) => createRealtimeMessageId(senderStableId),
    normalizeClientUploadUrl,
    normalizeClientFileAttachment,
    normalizeClientMessageEntities,
    sanitizeUploadFileName,
    buildDeletionConfig: (channel) => {
      const retentionMs = messageRetentionToMs(channel.autoDeleteAfter ?? null);
      return {
        scheduledDeletionTime: retentionMs ? Date.now() + retentionMs : undefined,
        deletionDuration: channel.autoDeleteAfter || null
      };
    },
    emitToStableUser,
    emitToChannel,
    scheduleMessageDeletion,
    persistMessageOnSend: (targetSocket, channel, data, message) => {
      const shouldPersistMessage =
        channel.persistMessages === true &&
        !(data.type === 'role_gate' && data.roleGatePersist === false);
      if (!shouldPersistMessage) return;

      void persistRealtimeMessageForSocket(targetSocket, data.channelId, message, { skipExistingCheck: true });
    },
    retryPersistMessage: async (targetSocket, channelId, message) => {
      await persistRealtimeMessageForSocket(targetSocket, channelId, message, { notifyOnSuccess: true });
    },
    markMessageEdited: (messageId, newText) => {
      stateMessageStore.markEdited(messageId, newText);
    },
    findPersistedMessageSenderId: (messageId) => {
      return stateMessageStore.findByMessageId(messageId)?.sender_id || null;
    },
    deleteRealtimeMessage,
    emitMessageCreatedSideEffects: ({ channelId, message, user, data, senderStableId }) => {
      const queuedRecipientDbUserIds = queueOfflineConversationMessages(
        channelId,
        message,
        user,
        senderStableId
      );

      if (queuedRecipientDbUserIds.length > 0) {
        socket.emit("message-queued", {
          channelId,
          messageId: message.id,
          recipientUserIds: queuedRecipientDbUserIds
        });
      }

      pluginLoader.triggerOnMessage(channelId, message).catch((error) => {
        console.error('[Plugins] Failed to trigger onMessage hook:', error);
      });
      dispatchWebhookEvent('message.created', {
        channelId,
        messageId: message.id,
        userId: senderStableId,
        username: user.username,
        type: data.type,
        text: data.text
      }).catch((error) => {
        console.error('[Webhooks] Failed to dispatch message.created:', error);
      });
    },
    logEnabled: ENABLE_LOGGING,
    log: (...args) => console.log(...args)
  });

  registerMessageInteractionHandlers({
    socket,
    users,
    channels,
    channelMessages,
    pinnedMessages,
    typingUsers,
    channelTypingUsers,
    getAccessibleChannel,
    getSocketStableId,
    applyEmojiRoleRules,
    persistMessagePinState: (messageId, isPinned) => {
      stateMessageStore.update(messageId, { is_pinned: isPinned ? 1 : 0 });
    },
    persistMessageReactions: (messageId, reactions) => {
      stateMessageStore.updateReactions(messageId, reactions);
    },
    emitToChannel,
    emitToAllSockets: (event, payload) => {
      io.emit(event, payload);
    }
  });

  registerSocketAssetHandlers({
    socket,
    users,
    emotes,
    getAllEmojis,
    addCustomEmoji: (emoji) => addCustomEmoji(emoji as Emoji),
    deleteCustomEmoji,
    saveEmoteFile: (fileName, buffer) => {
      writeFileSync(join(EMOTES_DIR, fileName), buffer);
    },
    addEmote: (emoteName, emote) => {
      emotes.set(emoteName, emote);
    },
    emitToAllSockets: (event, payload) => {
      io.emit(event, payload);
    },
    logEnabled: ENABLE_LOGGING,
    log: (...args) => console.log(...args)
  });

  registerPeerRelayHandlers({
    socket,
    users,
    channels,
    screenSharers,
    getSocketStableId,
    getPublicUserId,
    findUserByStableId,
    emitSocketBroadcast: (event, payload) => {
      socket.broadcast.emit(event, payload);
    },
    emitToSocketId: (socketId, event, payload) => {
      io.to(socketId).emit(event, payload);
    }
  });

  registerWhiteboardSocketHandlers({
    socket,
    channels,
    whiteboardRepository,
    getSocketStableId,
    canAccessChannel,
    roomPrefix: WHITEBOARD_ROOM_PREFIX,
    getWhiteboardRoomId,
    getSerializedPayloadBytes,
    emitWhiteboardPresence,
    maxDocumentBytes: WHITEBOARD_MAX_DOCUMENT_BYTES,
    maxLivePayloadBytes: WHITEBOARD_MAX_LIVE_PAYLOAD_BYTES
  });

  registerVoiceSocketHandlers({
    socket,
    users,
    channels,
    voiceChannelParticipants,
    getSocketStableId,
    canAccessChannel,
    canJoinVoiceChannel,
    canSubscribeToVoiceChannel,
    addVoiceSubscription,
    removeVoiceSubscription,
    getVoiceChannelMembers,
    emitVoiceChannelState,
    emitToVoiceAudience,
    syncVoiceRecordingPresenceForSocket,
    emitVoiceChannelRecordingPresence,
    addVoicePeerLink,
    removeVoicePeerLink,
    removeAllVoicePeerLinks,
    setRecordingActiveForSocket
  });

  registerCallSocketHandlers({
    socket,
    users,
    getSocketStableId,
    initiateGroupCall,
    initiateDirectCall,
    answerGroupCall,
    answerDirectCall,
    rejectGroupCall,
    rejectDirectCall,
    cancelGroupCall,
    cancelDirectCall,
    stopRingingForGroupCall,
    leaveGroupCall,
    endDirectCall
  });

  registerCallSignalRelayHandlers({
    socket,
    users,
    channels,
    groupCallSessions,
    getVoiceAudienceSocketIds,
    getSocketStableId,
    resolveStableUserIdFromAny,
    resolveSocketId,
    emitToCallTarget
  });

  // Channel management
  registerChannelMutationHandlers({
    socket,
    users,
    channels,
    channelMessages,
    pinnedMessages,
    voiceChannelParticipants,
    getSocketHighestRole,
    getSocketStableId,
    canAccessChannel,
    getUserRoleInfo,
    roleExists: (roleName) => stateRbacStore.roleExists(roleName, 'default-workspace'),
    normalizeVoiceSettings: parseVoiceSettings,
    getVoiceChannelUserLimit,
    emitGlobalEvent,
    emitChannelCreatedSideEffects: (channel) => {
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
    },
    createPersistedChannel: (payload) => {
      channelRepository.create(payload);
    },
    addPersistedChannelMember: (payload) => {
      channelMemberRepository.addMember(payload);
    },
    deletePersistedChannel: (channelId) => {
      channelRepository.delete(channelId);
    },
    updatePersistedChannelSettings: (channelId, payload) => {
      channelRepository.updateSettings(channelId, payload);
    },
    buildChannel: ({ id, name, description, watchQueueEnabled, createdAt, type, parentChannelId, isBreakout, breakoutIndex }) => ({
      id,
      name,
      description,
      watchQueueEnabled,
      minRole: 'guest',
      createdAt,
      type,
      parentChannelId,
      isBreakout,
      breakoutIndex,
      autoDeleteAfter: null,
      persistMessages: false
    }),
    buildThreadChannel: ({ id, name, minRole, createdAt, type, members, parentChannelId, parentMessageId, threadAutoArchiveMinutes, autoDeleteAfter, persistMessages }) => ({
      id,
      name,
      description: '',
      minRole,
      createdAt,
      type,
      members,
      parentChannelId,
      parentMessageId,
      threadArchived: false,
      threadLocked: false,
      threadAutoArchiveMinutes,
      threadLastActivityAt: createdAt,
      autoDeleteAfter,
      persistMessages
    }),
    logEnabled: ENABLE_LOGGING,
    log: (...args) => console.log(...args)
  });

  registerVoiceBreakoutHandlers({
    socket,
    channels,
    channelMessages,
    pinnedMessages,
    voiceChannelParticipants,
    getSocketStableId,
    canAccessChannel,
    canManageVoiceBreakouts,
    canMoveVoiceMember,
    getBreakoutChannelsForParent,
    resolveStableUserIdFromAny,
    canJoinVoiceChannel,
    moveVoiceParticipant,
    syncVoiceRecordingPresenceForSocket,
    emitVoiceChannelRecordingPresence,
    emitVoiceChannelState,
    emitGlobalEvent,
    emitVoiceBreakoutsUpdated: (payload) => {
      io.emit("voice-breakouts-updated", payload);
    },
    buildBreakoutChannel: ({ id, name, description, minRole, createdAt, parentChannelId, breakoutIndex }) => ({
      id,
      name,
      description,
      minRole,
      createdAt,
      type: 'voice',
      parentChannelId,
      isBreakout: true,
      breakoutIndex,
      persistMessages: false
    }),
    persistBreakoutChannel: (breakoutChannel, creatorStableId) => {
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
    },
    deletePersistedChannel: (channelId) => {
      channelRepository.delete(channelId);
    }
  });

  registerConversationChannelHandlers({
    socket,
    users,
    channels,
    channelMessages,
    pinnedMessages,
    getSocketStableId,
    resolveSocketId,
    emitToStableUser,
    emitGroupCreatedSideEffects: (groupPayload) => {
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
    },
    buildOnlineUserSummary: (user) => ({
      id: user.id,
      username: user.username,
      color: user.color,
      status: user.status,
      profilePicture: user.profilePicture,
      dbUserId: user.dbUserId
    }),
    buildOfflineRegisteredUserSummary: (stableUserId) => {
      if (!stableUserId.startsWith('user-')) return null;
      const dbId = parseInt(stableUserId.substring(5), 10);
      const dbUser = userRepository.findById(dbId);
      if (!dbUser) return null;
      return {
        id: stableUserId,
        username: dbUser.username,
        color: dbUser.color,
        status: 'offline' as const,
        profilePicture: dbUser.profile_picture,
        dbUserId: dbId
      };
    },
    loadPersistedDmChannel: (channelId) => {
      const dbChannel = channelRepository.findById(channelId);
      if (!dbChannel) return null;
      const memberIds = channelMemberRepository.getMemberIds(channelId);
      const channel: Channel = {
        id: channelId,
        name: dbChannel.name,
        createdAt: dbChannel.created_at,
        type: 'dm',
        members: memberIds,
        autoDeleteAfter: resolvePersistedChannelRetention(dbChannel.auto_delete_after, dbChannel.channel_type),
        persistMessages: true,
        recipientNotified: true
      };
      const dbMessages = stateMessageStore.getByChannel(channelId, { limit: 50 });
      const messages = dbMessages.map((msg) => stateMessageStore.toClientFormat(msg));
      return { channel, messages };
    },
    dmChannelExists: (channelId) => channelRepository.exists(channelId),
    createPersistedDm: ({ channelId, name, createdAt, createdBy, myMember, targetMember }) => {
      channelRepository.create({
        channel_id: channelId,
        channel_type: 'dm',
        name,
        created_at: createdAt,
        created_by: createdBy,
        persist_messages: 1,
        auto_delete_after: DEFAULT_DM_RETENTION
      });
      channelMemberRepository.addMembers([
        {
          channel_id: channelId,
          user_id: myMember.userId,
          username: myMember.username,
          registered_user_id: myMember.registeredUserId,
          joined_at: myMember.joinedAt,
          role: 'member'
        },
        {
          channel_id: channelId,
          user_id: targetMember.userId,
          username: targetMember.username,
          registered_user_id: targetMember.registeredUserId,
          joined_at: targetMember.joinedAt,
          role: 'member'
        }
      ]);
    },
    deletePersistedChannel: (channelId) => {
      channelRepository.delete(channelId);
    },
    createPersistedGroup: ({ channelId, name, createdAt, createdBy, members }) => {
      channelRepository.create({
        channel_id: channelId,
        channel_type: 'group',
        name,
        created_at: createdAt,
        created_by: createdBy,
        persist_messages: 1,
        auto_delete_after: DEFAULT_DM_RETENTION
      });
      channelMemberRepository.addMembers(members);
    },
    removePersistedGroupMember: (channelId, stableUserId) => {
      channelMemberRepository.removeMember(channelId, stableUserId);
    },
    archivePersistedChannel: (channelId) => {
      channelRepository.archive(channelId);
    },
    getPersistedGroupMember: (channelId, stableUserId) => {
      return channelMemberRepository.getMember(channelId, stableUserId);
    },
    addPersistedGroupMember: (payload) => {
      channelMemberRepository.addMember(payload);
    },
    getPersistedGroupAvatar: (channelId) => {
      return channelRepository.findById(channelId)?.avatar || null;
    },
    updatePersistedGroupAvatar: (channelId, avatarUrl) => {
      channelRepository.updateAvatar(channelId, avatarUrl);
    },
    logEnabled: ENABLE_LOGGING,
    log: (...args) => console.log(...args)
  });

  registerRoleModerationHandlers({
    socket,
    users,
    emitRoleDefinitions,
    getUserRoleInfo: (dbUserId) => getUserRoleInfo(dbUserId),
    getRolePriority,
    assignRole: (targetUserId, roleName) => {
      assignRole(targetUserId, roleName as any);
    },
    removeRole: (targetUserId, roleName) => {
      removeRole(targetUserId, roleName as any, 'default-workspace');
    },
    syncDbUserRoleState,
    countOwners: () => stateRbacStore.countRoleAssignments('owner', 'default-workspace'),
    findUserById: (dbUserId) => userRepository.findById(dbUserId),
    banTargetUser: (targetUserId, notification) => {
      userRepository.update(targetUserId, { is_active: 0 });
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetUserId);

      for (const [sid, onlineUser] of users.entries()) {
        if (onlineUser.dbUserId === targetUserId) {
          io.to(sid).emit("channel-error", notification);
          io.sockets.sockets.get(sid)?.disconnect(true);
        }
      }
    },
    setRoleDisplayName: (roleName, displayName) => {
      stateRbacStore.setRoleDisplayName(roleName, displayName, 'default-workspace');
    },
    emitEmojiRoleRules,
    roleExists: (roleName) => stateRbacStore.roleExists(roleName, 'default-workspace'),
    getChannelMessages: (channelId) => channelMessages.get(channelId) || [],
    createEmojiRoleRule: ({ channelId, messageId, emojiId, roleName, removeOnUnreact }) => {
      db.prepare(`
        INSERT INTO emoji_role_rules (channel_id, message_id, emoji_id, role_name, remove_on_unreact, workspace_id, enabled)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(
        channelId,
        messageId,
        emojiId,
        roleName,
        removeOnUnreact ? 1 : 0,
        'default-workspace'
      );
    },
    deleteEmojiRoleRule: (ruleId) => {
      db.prepare('DELETE FROM emoji_role_rules WHERE id = ? AND workspace_id = ?')
        .run(ruleId, 'default-workspace');
    },
    logEnabled: ENABLE_LOGGING,
    log: (...args) => console.log(...args)
  });

  registerDisconnectCleanupHandler({
    socket,
    users,
    dbUserIdToSocketId,
    typingUsers,
    userCurrentChannel,
    channelTypingUsers,
    screenSharers,
    groupCallSessions,
    voiceChannelParticipants,
    getSocketStableId,
    getSocketMeshLeaseConnectedAt: () => (socket as any).meshLeaseConnectedAt ?? null,
    getSocketMeshPresenceConnectedAt: () => (socket as any).meshPresenceConnectedAt ?? null,
    recordPresenceStateEvent: (reason) => {
      recordPresenceStateEvent(socket, 'user_left', { reason });
    },
    releaseStateMeshSocketLease,
    deletePresenceLeaseForUser,
    teardownDirectCallsForDisconnect,
    removeGroupCallParticipantFromSession,
    removeRecorderFromGroupChannels,
    emitVoiceChannelState,
    emitToVoiceAudience,
    removeAllVoicePeerLinks,
    removeAllVoiceSubscriptionsForSocket,
    getPublicUserId,
    emitMeshBroadcast,
    triggerOnUserLeave: (socketId) => pluginLoader.triggerOnUserLeave(socketId),
    dispatchUserLeftWebhook: (payload) => dispatchWebhookEvent('user.left', payload),
    logEnabled: ENABLE_LOGGING,
    log: (...args) => console.log(...args)
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

console.log(`[Plugins] System: ${PLUGINS_ENABLED ? 'enabled' : 'disabled'} | Install API: ${PLUGINS_ALLOW_INSTALL ? 'enabled' : 'disabled'}`);
