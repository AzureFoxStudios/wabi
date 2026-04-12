import { Server } from "socket.io";
import { createServer } from "http";
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync, createReadStream, openSync, closeSync, writeSync } from "fs";
import { readFile as readFileAsync, writeFile as writeFileAsync, stat as statAsync, unlink as unlinkAsync, open as openFileAsync } from "fs/promises";
import { join, basename, resolve, sep } from "path";
import { createHmac, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv, createHash } from "crypto";
import { brotliCompressSync, constants as zlibConstants, gzipSync, gunzipSync, gzip as gzipCb } from "zlib";
import { promisify } from "util";
const gzipAsync = promisify(gzipCb);
import { lookup as dnsLookup } from "dns/promises";
import { isIP } from "net";
import { PluginLoader } from "./plugins/loader";
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
  handleDeleteAlbumItem,
  type AlbumUploadLimitConfig
} from "./api/albumRoutes.js";
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

// Helper: get role info for a user (roles, highest role, display color)
interface ComputedRoleInfo {
  roles: string[];
  highestRole: string;
  roleColor: string | null;
}

interface RoleStyleMeta {
  priority: number;
  color: string | null;
}

interface WorkspaceRoleLookup {
  workspaceId: string;
  roleStylesByName: Map<string, RoleStyleMeta>;
  roleInfoByUserId: Map<number, ComputedRoleInfo>;
}

function loadRoleStyleMeta(workspaceId: string = 'default-workspace'): Map<string, RoleStyleMeta> {
  const byName = new Map<string, RoleStyleMeta>();
  for (const row of stateRbacStore.getRoleDefinitions(workspaceId)) {
    byName.set(row.roleName, {
      priority: row.priority,
      color: row.color || null
    });
  }
  return byName;
}

function computeRoleInfoFromRoles(
  roles: string[],
  roleStylesByName: Map<string, RoleStyleMeta>
): ComputedRoleInfo {
  const sortedRoles = roles.filter(Boolean).sort((a, b) => a.localeCompare(b));
  if (sortedRoles.length === 0) {
    return { roles: ['member'], highestRole: 'member', roleColor: null };
  }

  let highestRole = 'member';
  let highestPriority = Number.NEGATIVE_INFINITY;
  let roleColor: string | null = null;

  for (const role of sortedRoles) {
    const meta = roleStylesByName.get(role);
    const priority = meta?.priority ?? 0;
    if (priority > highestPriority) {
      highestPriority = priority;
      highestRole = role;
    }
    if (!roleColor && meta?.color) {
      roleColor = meta.color;
    }
  }

  return {
    roles: sortedRoles,
    highestRole,
    roleColor
  };
}

function buildWorkspaceRoleLookup(workspaceId: string = 'default-workspace'): WorkspaceRoleLookup {
  const roleStylesByName = loadRoleStyleMeta(workspaceId);
  const assignments = stateRbacStore.getWorkspaceRoleAssignments(workspaceId);
  const rolesByUserId = new Map<number, string[]>();

  for (const assignment of assignments) {
    const existing = rolesByUserId.get(assignment.userId) || [];
    existing.push(assignment.role);
    rolesByUserId.set(assignment.userId, existing);
  }

  const roleInfoByUserId = new Map<number, ComputedRoleInfo>();
  for (const [userId, roles] of rolesByUserId.entries()) {
    roleInfoByUserId.set(userId, computeRoleInfoFromRoles(roles, roleStylesByName));
  }

  return {
    workspaceId,
    roleStylesByName,
    roleInfoByUserId
  };
}

function getUserRoleInfo(
  dbUserId?: number,
  roleLookup?: WorkspaceRoleLookup
): ComputedRoleInfo {
  if (!dbUserId) return { roles: ['guest'], highestRole: 'guest', roleColor: '#888888' };

  if (roleLookup) {
    const cached = roleLookup.roleInfoByUserId.get(dbUserId);
    if (cached) {
      return cached;
    }

    // Users without an explicit assignment still resolve to the default member role.
    // Avoid per-user fallback reads in stdb_primary when building large join snapshots.
    return computeRoleInfoFromRoles(['member'], roleLookup.roleStylesByName);
  }

  const workspaceId = 'default-workspace';
  const roles = getUserRoles(dbUserId, workspaceId);
  const roleStylesByName = loadRoleStyleMeta(workspaceId);
  return computeRoleInfoFromRoles(roles, roleStylesByName);
}

function getRoleDefinitions(workspaceId: string = 'default-workspace'): Array<{
  roleName: string;
  displayName: string;
  priority: number;
  color: string | null;
  isHoisted: boolean;
}> {
  return stateRbacStore.getRoleDefinitions(workspaceId).map((row) => ({
    roleName: row.roleName,
    displayName: row.displayName,
    priority: row.priority,
    color: row.color,
    isHoisted: row.isHoisted
  }));
}

function getRolePriority(roleName: string, workspaceId: string = 'default-workspace'): number {
  return stateRbacStore.getRolePriority(roleName, workspaceId);
}

type RolePolicyTier = 'new' | 'trusted' | 'moderator' | 'admin' | 'owner';
type UploadLimitBytes = number | null;

interface UploadLimitConfig {
  perRoleBytes: Record<RolePolicyTier, UploadLimitBytes>;
  globalUploadCapBytes: UploadLimitBytes;
}

interface DownloadLimitConfig {
  perRoleBytes: Record<RolePolicyTier, UploadLimitBytes>;
  globalDownloadCapBytes: UploadLimitBytes;
}

interface RuntimeTuningConfig {
  applyOnRestart: true;
  threadPoolSize: number | null;
  heavyProfilingEnabled: boolean;
  heavyProfilingSampleRate: number;
}

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
type VideoCompressionTelemetryOutcome = 'success' | 'failure' | 'cancelled' | 'skipped';
type VideoCompressionTelemetryRuntime = 'desktop' | 'android' | 'ios' | 'web' | 'unknown';
type VideoCompressionPresetId = 'mobile_540p' | 'balanced_720p' | 'quality_1080p';
type VideoCompressionCodec = 'vp9' | 'vp8' | 'h264' | 'hevc' | 'av1' | 'unknown';
const VIDEO_COMPRESSION_TELEMETRY_WINDOW_MS = 60_000;
const VIDEO_COMPRESSION_TELEMETRY_MAX_EVENTS_PER_WINDOW = 180;
const videoCompressionTelemetryBudget = new Map<string, { windowStart: number; count: number }>();

interface UploadVideoCompressionMeta {
  scheme: 'wabi-video-compression-v1';
  runtime: VideoCompressionTelemetryRuntime;
  preset: VideoCompressionPresetId;
  originalSize: number;
  compressedSize: number;
  codec: VideoCompressionCodec;
  mimeType: string;
  durationMs: number;
  estimatedOutputBytes?: number;
}

interface UploadVideoCompressionVerificationMeta {
  scheme: 'wabi-video-compression-v1';
  runtime: VideoCompressionTelemetryRuntime;
  preset: VideoCompressionPresetId;
  verified: boolean;
  verifiedAt: number;
  originalSize: number;
  uploadedSize: number;
  compressedSizeClaimed: number;
  codecClaimed: VideoCompressionCodec;
  codecDetected: VideoCompressionCodec;
  mimeTypeClaimed: string;
  mimeTypeStored: string;
  ratio: number | null;
  notes?: string[];
}

function sanitizeVideoCompressionPreset(value: unknown): VideoCompressionPresetId | null {
  if (value === 'mobile_540p' || value === 'balanced_720p' || value === 'quality_1080p') {
    return value;
  }
  return null;
}

function sanitizeVideoCompressionCodec(value: unknown): VideoCompressionCodec | null {
  if (value === 'vp9' || value === 'vp8' || value === 'h264' || value === 'hevc' || value === 'av1' || value === 'unknown') {
    return value;
  }
  return null;
}

function sanitizeUploadVideoCompressionMeta(
  payload: unknown,
  expectedCompressedSize: number
): UploadVideoCompressionMeta | null {
  if (!payload || typeof payload !== 'object') return null;
  const candidate = payload as Record<string, unknown>;
  if (candidate.scheme !== 'wabi-video-compression-v1') return null;

  const runtime = sanitizeVideoCompressionTelemetryRuntime(candidate.runtime);
  const preset = sanitizeVideoCompressionPreset(candidate.preset);
  const originalSize = sanitizeTelemetryNumericValue(candidate.originalSize, expectedCompressedSize, 10 * GB);
  const compressedSize = sanitizeTelemetryNumericValue(candidate.compressedSize, expectedCompressedSize, expectedCompressedSize);
  const codec = sanitizeVideoCompressionCodec(candidate.codec) || 'unknown';
  const durationMs = sanitizeTelemetryNumericValue(candidate.durationMs, 1, 6 * 60 * 60 * 1000);
  const estimatedOutputBytes = sanitizeTelemetryNumericValue(candidate.estimatedOutputBytes, 1, 10 * GB);
  const mimeType = typeof candidate.mimeType === 'string'
    ? candidate.mimeType.trim().toLowerCase().slice(0, 120)
    : '';

  if (!runtime || !preset || !originalSize || !compressedSize || !durationMs || !mimeType) {
    return null;
  }

  return {
    scheme: 'wabi-video-compression-v1',
    runtime,
    preset,
    originalSize,
    compressedSize,
    codec,
    mimeType,
    durationMs,
    ...(estimatedOutputBytes ? { estimatedOutputBytes } : {})
  };
}

function detectVideoCodecFromStoredUpload(fileName: string, mimeType: string): VideoCompressionCodec {
  const lowerMime = (mimeType || '').toLowerCase();
  const lowerName = (fileName || '').toLowerCase();
  if (lowerMime.includes('vp9')) return 'vp9';
  if (lowerMime.includes('vp8')) return 'vp8';
  if (lowerMime.includes('av1')) return 'av1';
  if (lowerMime.includes('hevc') || lowerMime.includes('h265')) return 'hevc';
  if (lowerMime.includes('avc') || lowerMime.includes('h264')) return 'h264';
  if (lowerName.endsWith('.webm')) return 'vp9';
  if (lowerName.endsWith('.mov') || lowerName.endsWith('.m4v') || lowerName.endsWith('.mp4')) return 'h264';
  return 'unknown';
}

function verifyUploadVideoCompressionMeta(
  claimed: UploadVideoCompressionMeta,
  uploadedSize: number,
  storedMimeType: string,
  storedFileName: string
): UploadVideoCompressionVerificationMeta {
  const notes: string[] = [];
  let verified = true;

  if (claimed.compressedSize !== uploadedSize) {
    verified = false;
    notes.push('compressed_size_mismatch');
  }
  if (claimed.originalSize < uploadedSize) {
    verified = false;
    notes.push('original_size_below_uploaded_size');
  }
  const codecDetected = detectVideoCodecFromStoredUpload(storedFileName, storedMimeType);
  if (claimed.codec !== 'unknown' && codecDetected !== 'unknown' && claimed.codec !== codecDetected) {
    verified = false;
    notes.push('codec_mismatch');
  }
  if (claimed.mimeType !== storedMimeType) {
    notes.push('mime_type_changed_after_upload');
  }

  const ratioRaw = claimed.originalSize > 0 ? uploadedSize / claimed.originalSize : null;
  const ratio = ratioRaw === null ? null : Math.round(ratioRaw * 1_000_000) / 1_000_000;
  if (ratio !== null && ratio >= 1) {
    verified = false;
    notes.push('no_size_reduction');
  }

  return {
    scheme: 'wabi-video-compression-v1',
    runtime: claimed.runtime,
    preset: claimed.preset,
    verified,
    verifiedAt: Date.now(),
    originalSize: claimed.originalSize,
    uploadedSize,
    compressedSizeClaimed: claimed.compressedSize,
    codecClaimed: claimed.codec,
    codecDetected,
    mimeTypeClaimed: claimed.mimeType,
    mimeTypeStored: storedMimeType,
    ratio,
    ...(notes.length > 0 ? { notes } : {})
  };
}

function sanitizeVideoCompressionTelemetryOutcome(
  value: unknown
): VideoCompressionTelemetryOutcome | null {
  if (value === 'success' || value === 'failure' || value === 'cancelled' || value === 'skipped') {
    return value;
  }
  return null;
}

function sanitizeVideoCompressionTelemetryRuntime(
  value: unknown
): VideoCompressionTelemetryRuntime | null {
  if (value === 'desktop' || value === 'android' || value === 'ios' || value === 'web' || value === 'unknown') {
    return value;
  }
  return null;
}

function sanitizeTelemetryNumericValue(
  value: unknown,
  min: number,
  max: number
): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < min || rounded > max) return null;
  return rounded;
}

function sanitizeTelemetryString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '_')
    .slice(0, maxLength);
  return cleaned.length > 0 ? cleaned : null;
}

function consumeVideoCompressionTelemetryQuota(ownerKey: string): boolean {
  const now = Date.now();
  const current = videoCompressionTelemetryBudget.get(ownerKey);
  if (!current || now - current.windowStart >= VIDEO_COMPRESSION_TELEMETRY_WINDOW_MS) {
    videoCompressionTelemetryBudget.set(ownerKey, { windowStart: now, count: 1 });
    return true;
  }
  if (current.count >= VIDEO_COMPRESSION_TELEMETRY_MAX_EVENTS_PER_WINDOW) {
    return false;
  }
  current.count += 1;
  videoCompressionTelemetryBudget.set(ownerKey, current);
  return true;
}

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

const DEFAULT_ALBUM_UPLOAD_LIMIT_CONFIG: AlbumUploadLimitConfig = {
  perRoleItemsPerMinute: {
    new: 6,
    trusted: 24,
    moderator: 90,
    admin: 180,
    owner: 240
  },
  perRoleMaxBytesPerItem: {
    new: 25 * MB,
    trusted: 300 * MB,
    moderator: 1024 * MB,
    admin: null,
    owner: null
  },
  perScopeItemsPerMinute: 420
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

function cloneDefaultAlbumUploadLimits(): AlbumUploadLimitConfig {
  return {
    perRoleItemsPerMinute: { ...DEFAULT_ALBUM_UPLOAD_LIMIT_CONFIG.perRoleItemsPerMinute },
    perRoleMaxBytesPerItem: { ...DEFAULT_ALBUM_UPLOAD_LIMIT_CONFIG.perRoleMaxBytesPerItem },
    perScopeItemsPerMinute: DEFAULT_ALBUM_UPLOAD_LIMIT_CONFIG.perScopeItemsPerMinute
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
  const perRole = input.perRoleBytes as Partial<Record<RolePolicyTier, unknown>> | undefined;
  if (perRole && typeof perRole === 'object') {
    for (const tier of ['new', 'trusted', 'moderator', 'admin', 'owner'] as RolePolicyTier[]) {
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
  const perRole = input.perRoleBytes as Partial<Record<RolePolicyTier, unknown>> | undefined;
  if (perRole && typeof perRole === 'object') {
    for (const tier of ['new', 'trusted', 'moderator', 'admin', 'owner'] as RolePolicyTier[]) {
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

function sanitizeAlbumUploadLimitConfig(raw: unknown): AlbumUploadLimitConfig {
  const config = cloneDefaultAlbumUploadLimits();
  if (!raw || typeof raw !== 'object') return config;

  const input = raw as Partial<AlbumUploadLimitConfig>;
  const perRoleRates = input.perRoleItemsPerMinute as Partial<Record<RolePolicyTier, unknown>> | undefined;
  if (perRoleRates && typeof perRoleRates === 'object') {
    for (const tier of ['new', 'trusted', 'moderator', 'admin', 'owner'] as RolePolicyTier[]) {
      if (Object.prototype.hasOwnProperty.call(perRoleRates, tier)) {
        config.perRoleItemsPerMinute[tier] = normalizeCountValue(
          perRoleRates[tier],
          config.perRoleItemsPerMinute[tier],
          1,
          5000
        );
      }
    }
  }

  const perRoleBytes = input.perRoleMaxBytesPerItem as Partial<Record<RolePolicyTier, unknown>> | undefined;
  if (perRoleBytes && typeof perRoleBytes === 'object') {
    for (const tier of ['new', 'trusted', 'moderator', 'admin', 'owner'] as RolePolicyTier[]) {
      if (Object.prototype.hasOwnProperty.call(perRoleBytes, tier)) {
        config.perRoleMaxBytesPerItem[tier] = normalizeLimitValue(perRoleBytes[tier]);
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'perScopeItemsPerMinute')) {
    config.perScopeItemsPerMinute = normalizeCountValue(
      input.perScopeItemsPerMinute,
      config.perScopeItemsPerMinute,
      1,
      20000
    );
  }

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

function resolveUploadRoleTier(userId: number | null, guestSessionId: string | null): RolePolicyTier {
  if (!userId) return guestSessionId ? 'new' : 'new';
  const roles = getUserRoles(userId, 'default-workspace');
  if (roles.includes('owner')) return 'owner';
  if (roles.includes('admin')) return 'admin';
  if (roles.includes('mod')) return 'moderator';
  return 'trusted';
}

function getEffectiveUploadCapBytes(roleTier: RolePolicyTier, config: UploadLimitConfig): UploadLimitBytes {
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
  autoDeleteAfter?: '5s' | '1h' | '6h' | '12h' | '24h' | '3d' | '7d' | '14d' | '30d' | null;
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

const channels = new Map<string, Channel>();
channels.set('general', { id: 'general', name: 'general', createdAt: Date.now(), type: 'text' });
channels.set('voice', { id: 'voice', name: 'voice', createdAt: Date.now(), type: 'voice' });

type RealtimeChannelMessage = ClientMessage & {
  senderStableId?: string;
  scheduledDeletionTime?: number;
};

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
    created_at: message.timestamp
  };
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

type ActiveUserRecord = {
  id: string;
  username: string;
  handle?: string;
  color: string;
  status: 'active' | 'away' | 'busy';
  profilePicture?: string;
  joinedAt?: number;
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
};

const users = new Map<string, ActiveUserRecord>();

// Reverse mapping: stable dbUserId -> current socket.id (for registered users only)
const dbUserIdToSocketId = new Map<number, string>();
const MAX_SEEN_MESH_DELIVERIES = 50_000;
const seenMeshDeliveryIds = new Set<string>();
const seenMeshDeliveryQueue: string[] = [];

type MeshInboundDelivery = {
  deliveryId: string;
  scope: 'user' | 'broadcast';
  event: string;
  payload: unknown;
  targetStableUserId?: string | null;
  fromInstanceId?: string | null;
  createdAt?: number;
};

// Helper: get the stable identity key for a user (dbUserId string for registered, socket.id for guests)
function getStableUserId(socket: any): string {
  if ((socket as any).isRegistered && (socket as any).dbUserId) {
    return `user-${(socket as any).dbUserId}`;
  }
  return socket.id;
}

function getPublicUserId(user: Pick<ActiveUserRecord, 'id' | 'dbUserId'>): string {
  if (typeof user.dbUserId === 'number' && Number.isFinite(user.dbUserId)) {
    return `user-${user.dbUserId}`;
  }
  return user.id;
}

function normalizePresenceStatus(status: string | null | undefined): 'active' | 'away' | 'busy' {
  if (status === 'away' || status === 'busy') return status;
  return 'active';
}

function toPublicUser(user: ActiveUserRecord): ActiveUserRecord {
  return {
    ...user,
    id: getPublicUserId(user),
    status: normalizePresenceStatus(user.status),
    joinedAt: user.joinedAt
  };
}

function upsertPresenceLeaseForUser(user: ActiveUserRecord | undefined, connectedAt?: number | null): number | null {
  if (!user) return null;
  return upsertStateMeshPresenceLease({
    stableUserId: getPublicUserId(user),
    dbUserId: user.dbUserId,
    username: user.username,
    color: user.color,
    profilePicture: user.profilePicture,
    status: user.status
  }, connectedAt ?? user.joinedAt ?? null);
}

function deletePresenceLeaseForUser(user: Pick<ActiveUserRecord, 'id' | 'dbUserId'> | undefined, connectedAt?: number | null): void {
  if (!user) return;
  deleteStateMeshPresenceLease(getPublicUserId(user), connectedAt);
}

function getMeshConnectionCounts() {
  let currentRegisteredUsers = 0;
  for (const user of users.values()) {
    if (user.dbUserId) currentRegisteredUsers += 1;
  }
  const currentConnections = users.size;
  return {
    currentConnections,
    currentRegisteredUsers,
    currentGuestUsers: Math.max(0, currentConnections - currentRegisteredUsers)
  };
}

function recordPresenceStateEvent(
  socket: any,
  operation: string,
  payload: Record<string, unknown> = {}
): void {
  const user = users.get(socket.id);
  recordStatePlaneEvent('presence', operation, {
    socketId: socket.id,
    stableUserId: getStableUserId(socket),
    dbUserId: (socket as any).dbUserId ?? user?.dbUserId ?? null,
    username: user?.username ?? null,
    status: user?.status ?? null,
    ...payload
  });
}

// Helper: resolve a stable user ID to the current socket.id for delivery
function resolveSocketId(stableId: string): string | null {
  if (stableId.startsWith('user-')) {
    const dbId = parseInt(stableId.substring(5), 10);
    return dbUserIdToSocketId.get(dbId) || null;
  }
  return stableId; // Already a socket.id (guest user)
}

function getMeshSharedToken(): string | null {
  const candidates = [
    process.env.WABI_MESH_SHARED_TOKEN,
    process.env.STATE_SHADOW_TOKEN,
    process.env.WABI_STDB_AUTH_TOKEN
  ];
  for (const raw of candidates) {
    const value = raw?.trim();
    if (value) return value;
  }
  return null;
}

function constantTimeEqualString(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function buildMeshDeliveryId(): string {
  return `mesh_${Date.now().toString(36)}_${randomBytes(8).toString('hex')}`;
}

function hasSeenMeshDelivery(deliveryId: string): boolean {
  return seenMeshDeliveryIds.has(deliveryId);
}

function markSeenMeshDelivery(deliveryId: string): void {
  seenMeshDeliveryIds.add(deliveryId);
  seenMeshDeliveryQueue.push(deliveryId);
  if (seenMeshDeliveryQueue.length <= MAX_SEEN_MESH_DELIVERIES) return;
  const removed = seenMeshDeliveryQueue.shift();
  if (removed) {
    seenMeshDeliveryIds.delete(removed);
  }
}

function emitToStableUserLocal(stableUserId: string, event: string, data: unknown): boolean {
  const socketId = resolveSocketId(stableUserId);
  if (!socketId || !users.has(socketId)) return false;
  io.to(socketId).emit(event, data);
  return true;
}

function emitMeshBroadcast(event: string, data: unknown): void {
  const currentInstanceId = getCurrentStateMeshInstanceId();
  if (!currentInstanceId) return;

  for (const lease of listActiveStateMeshInstanceLeases()) {
    if (lease.instanceId === currentInstanceId) continue;
    void sendStateMeshRemoteDelivery({
      deliveryId: buildMeshDeliveryId(),
      targetInstanceId: lease.instanceId,
      scope: 'broadcast',
      event,
      payload: data,
      createdAt: Date.now()
    });
  }
}

function emitGlobalEvent(event: string, data: unknown): void {
  io.emit(event, data);
  emitMeshBroadcast(event, data);
}

function emitToStableUser(stableUserId: string, event: string, data: unknown): boolean {
  if (emitToStableUserLocal(stableUserId, event, data)) {
    return true;
  }

  if (!stableUserId.startsWith('user-')) {
    return false;
  }

  const lease = findStateMeshSocketLeaseByStableUserId(stableUserId);
  const currentInstanceId = getCurrentStateMeshInstanceId();
  if (!lease || !currentInstanceId || lease.instanceId === currentInstanceId) {
    return false;
  }

  void sendStateMeshRemoteDelivery({
    deliveryId: buildMeshDeliveryId(),
    targetInstanceId: lease.instanceId,
    scope: 'user',
    event,
    payload: data,
    targetStableUserId: stableUserId,
    createdAt: Date.now()
  });
  return true;
}

function emitToChannelLocal(channelId: string, event: string, data: any): void {
  const channel = channels.get(channelId);
  if (!channel) return;

  if (channel.members && channel.members.length > 0) {
    channel.members.forEach((stableId) => {
      emitToStableUserLocal(stableId, event, data);
    });
  } else {
    emitGlobalEvent(event, data);
  }
}

function normalizeMeshInboundDelivery(raw: unknown): MeshInboundDelivery {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Mesh delivery payload must be an object');
  }

  const input = raw as Record<string, unknown>;
  const deliveryId = typeof input.deliveryId === 'string' ? input.deliveryId.trim() : '';
  const scope = input.scope === 'broadcast' ? 'broadcast' : (input.scope === 'user' ? 'user' : '');
  const event = typeof input.event === 'string' ? input.event.trim() : '';
  if (!deliveryId) throw new Error('Mesh delivery requires deliveryId');
  if (!scope) throw new Error('Mesh delivery requires scope');
  if (!event) throw new Error('Mesh delivery requires event');

  const targetStableUserId =
    typeof input.targetStableUserId === 'string' && input.targetStableUserId.trim().length > 0
      ? input.targetStableUserId.trim()
      : null;

  if (scope === 'user' && !targetStableUserId) {
    throw new Error('User-scoped mesh delivery requires targetStableUserId');
  }

  return {
    deliveryId,
    scope,
    event,
    payload: input.payload,
    targetStableUserId,
    fromInstanceId: typeof input.fromInstanceId === 'string' ? input.fromInstanceId.trim() : null,
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : undefined
  };
}

function applyInboundMeshDelivery(delivery: MeshInboundDelivery): boolean {
  if (delivery.scope === 'broadcast') {
    io.emit(delivery.event, delivery.payload);
    return true;
  }
  if (delivery.scope === 'user' && delivery.targetStableUserId) {
    return emitToStableUserLocal(delivery.targetStableUserId, delivery.event, delivery.payload);
  }
  return false;
}

function emitToRegisteredUser(dbUserId: number | null | undefined, event: string, data: unknown): void {
  if (dbUserId == null || !Number.isFinite(dbUserId) || dbUserId <= 0) return;
  emitToStableUser(`user-${Math.floor(dbUserId)}`, event, data);
}

function emitToPaymentAdmins(event: string, data: unknown): void {
  const delivered = new Set<string>();
  for (const [socketId, user] of users.entries()) {
    if (delivered.has(socketId)) continue;
    if (!user?.dbUserId || !isPluginAdmin(user.dbUserId)) continue;
    delivered.add(socketId);
    io.to(socketId).emit(event, data);
  }
}

function buildDistributedUsersSnapshot(
  allDbUsers: Array<any> = userRepository.getAll(),
  roleLookup: WorkspaceRoleLookup = buildWorkspaceRoleLookup('default-workspace')
): ActiveUserRecord[] {
  const byStableId = new Map<string, ActiveUserRecord>();
  for (const user of users.values()) {
    byStableId.set(getPublicUserId(user), toPublicUser(user));
  }

  const registeredUsersByDbId = new Map(
    allDbUsers
      .filter((user) => typeof user.user_id === 'number')
      .map((user) => [user.user_id as number, user])
  );

  for (const lease of listStateMeshPresenceLeases()) {
    if (byStableId.has(lease.stableUserId)) continue;

    if (typeof lease.dbUserId === 'number' && Number.isFinite(lease.dbUserId)) {
      const dbUser = registeredUsersByDbId.get(lease.dbUserId);
      if (dbUser) {
        const roleInfo = getUserRoleInfo(lease.dbUserId, roleLookup);
        byStableId.set(lease.stableUserId, {
          id: lease.stableUserId,
          username: dbUser.username,
          handle: dbUser.handle,
          color: dbUser.color || lease.color || '#7a7a7a',
          status: normalizePresenceStatus(lease.status),
          profilePicture: dbUser.profile_picture || lease.profilePicture || undefined,
          joinedAt: lease.connectedAt,
          dbUserId: lease.dbUserId,
          roles: roleInfo.roles,
          highestRole: roleInfo.highestRole,
          roleColor: roleInfo.roleColor,
          usernameFont: {
            family: dbUser.username_font_family,
            size: dbUser.username_font_size,
            weight: dbUser.username_font_weight,
            style: dbUser.username_font_style
          }
        });
        continue;
      }
    }

    byStableId.set(lease.stableUserId, {
      id: lease.stableUserId,
      username: lease.username || lease.stableUserId,
      color: lease.color || '#7a7a7a',
      status: normalizePresenceStatus(lease.status),
      profilePicture: lease.profilePicture || undefined,
      joinedAt: lease.connectedAt,
      dbUserId: lease.dbUserId ?? undefined
    });
  }

  return Array.from(byStableId.values());
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

// Track active call peers: socketId -> Set of partner socketIds
const activeCallPeers = new Map<string, Set<string>>();

interface GroupCallSession {
  channelId: string;
  channelName: string;
  initiatorStableId: string;
  isVideoCall: boolean;
  hasEverEstablished: boolean;
  lastInviteSenderId: string;
  invitedParticipants: Set<string>;
  connectedParticipants: Set<string>;
}

const groupCallSessions = new Map<string, GroupCallSession>();

// Voice channel runtime state (transient, never persisted)
const voiceChannelParticipants = new Map<string, Set<string>>(); // channelId -> stable user IDs
const voiceChannelSubscribers = new Map<string, Set<string>>(); // channelId -> socket IDs listening to updates/media
const socketVoiceSubscriptions = new Map<string, Set<string>>(); // socket ID -> channel IDs
const voicePeerGraph = new Map<string, Set<string>>(); // stable user ID -> negotiated peer stable user IDs
const directCallRecorders = new Set<string>();
const groupCallRecordingParticipants = new Map<string, Set<string>>();
const voiceCallRecorders = new Set<string>();
const voiceChannelRecordingParticipants = new Map<string, Set<string>>();

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

function getDirectCallRecordingParticipantsForSocket(socketId: string): Array<{ userId: string; socketId: string; username?: string; profilePicture?: string }> {
	const scopeStableIds = new Set<string>();
	const socketUser = users.get(socketId);
	if (socketUser) {
		scopeStableIds.add(getPublicUserId(socketUser));
	}

	for (const peerSocketId of Array.from(activeCallPeers.get(socketId) || [])) {
		const peerUser = users.get(peerSocketId);
		if (!peerUser) continue;
		scopeStableIds.add(getPublicUserId(peerUser));
	}

	return Array.from(scopeStableIds)
		.filter((stableUserId) => directCallRecorders.has(stableUserId))
		.map(buildVoiceParticipant);
}

function emitDirectCallRecordingPresenceForSocket(socketId: string): void {
	if (!users.has(socketId)) return;
	io.to(socketId).emit('call-recording-presence', {
		scope: 'direct',
		participants: getDirectCallRecordingParticipantsForSocket(socketId)
	});
}

function emitDirectCallRecordingPresenceForSocketSet(socketIds: Iterable<string>): void {
	for (const socketId of socketIds) {
		emitDirectCallRecordingPresenceForSocket(socketId);
	}
}

function emitGroupCallRecordingPresence(channelId: string): void {
	const session = groupCallSessions.get(channelId);
	if (!session) return;

	const participants = Array.from(groupCallRecordingParticipants.get(channelId) || []).map(buildVoiceParticipant);
	for (const stableUserId of session.connectedParticipants) {
		emitToStableUser(stableUserId, 'call-recording-presence', {
			scope: 'group',
			channelId,
			participants
		});
	}
}

function emitVoiceChannelRecordingPresence(channelId: string): void {
	const participants = Array.from(voiceChannelRecordingParticipants.get(channelId) || []).map(buildVoiceParticipant);
	emitToVoiceAudience(channelId, 'call-recording-presence', {
		scope: 'channel',
		channelId,
		participants
	});
}

function removeRecorderFromGroupChannels(stableUserId: string, channelId?: string): void {
	const affectedChannelIds = new Set<string>();
	if (channelId) {
		const participants = groupCallRecordingParticipants.get(channelId);
		if (participants?.delete(stableUserId)) {
			affectedChannelIds.add(channelId);
			if (participants.size === 0) {
				groupCallRecordingParticipants.delete(channelId);
			}
		}
	} else {
		for (const [groupChannelId, participants] of groupCallRecordingParticipants.entries()) {
			if (!participants.delete(stableUserId)) continue;
			affectedChannelIds.add(groupChannelId);
			if (participants.size === 0) {
				groupCallRecordingParticipants.delete(groupChannelId);
			}
		}
	}

	for (const groupChannelId of affectedChannelIds) {
		emitGroupCallRecordingPresence(groupChannelId);
	}
}

function syncVoiceRecordingPresenceForSocket(stableUserId: string, socketId: string): void {
	const affectedChannelIds = new Set<string>();

	for (const [channelId, participants] of voiceChannelRecordingParticipants.entries()) {
		if (!participants.delete(stableUserId)) continue;
		affectedChannelIds.add(channelId);
		if (participants.size === 0) {
			voiceChannelRecordingParticipants.delete(channelId);
		}
	}

	if (voiceCallRecorders.has(stableUserId)) {
		for (const channelId of Array.from(socketVoiceSubscriptions.get(socketId) || [])) {
			let participants = voiceChannelRecordingParticipants.get(channelId);
			if (!participants) {
				participants = new Set<string>();
				voiceChannelRecordingParticipants.set(channelId, participants);
			}
			participants.add(stableUserId);
			affectedChannelIds.add(channelId);
		}
	}

	for (const channelId of affectedChannelIds) {
		emitVoiceChannelRecordingPresence(channelId);
	}
}

function clearAllRecordingPresenceForStableUser(stableUserId: string, socketId?: string): void {
	directCallRecorders.delete(stableUserId);
	removeRecorderFromGroupChannels(stableUserId);

	if (voiceCallRecorders.delete(stableUserId)) {
		syncVoiceRecordingPresenceForSocket(stableUserId, socketId || resolveSocketId(stableUserId) || stableUserId);
	} else if (socketId) {
		syncVoiceRecordingPresenceForSocket(stableUserId, socketId);
	}
}

function socketMeetsChannelRoleRequirement(socket: Socket, minRole?: string): boolean {
	const requiredRole = minRole || 'guest';
	if (requiredRole === 'guest') return true;
	const user = users.get(socket.id);
	const highestRole = user?.highestRole || 'guest';
	return getRolePriority(highestRole) >= getRolePriority(requiredRole);
}

function socketCanAccessChannel(socket: Socket, channel: Channel): boolean {
	if (!channel.members || channel.members.length === 0) {
		return socketMeetsChannelRoleRequirement(socket, channel.minRole);
	}
	return channel.members.includes(getStableUserId(socket));
}

function getVoiceChannelMembers(channelId: string): Array<{ userId: string; socketId: string; username?: string; profilePicture?: string }> {
	const participants = voiceChannelParticipants.get(channelId);
	if (!participants || participants.size === 0) return [];
	return Array.from(participants).map(buildVoiceParticipant);
}

function canJoinVoiceChannel(channel: Channel, stableUserId: string): { allowed: true } | { allowed: false; reason: string } {
	const participants = voiceChannelParticipants.get(channel.id);
	if (participants?.has(stableUserId)) {
		return { allowed: true };
	}

	const limit = getVoiceChannelUserLimit(channel);
	if (limit !== null && (participants?.size || 0) >= limit) {
		return {
			allowed: false,
			reason: channel.voiceSettings?.forceSolo
				? 'This voice channel is forced solo right now'
				: 'This voice channel is full'
		};
	}

	return { allowed: true };
}

function canSubscribeToVoiceChannel(socketId: string, channel: Channel): { allowed: true } | { allowed: false; reason: string } {
  const existingSubscriptions = Array.from(socketVoiceSubscriptions.get(socketId) || []);
  const otherSubscriptions = existingSubscriptions.filter((subscribedChannelId) => subscribedChannelId !== channel.id);
  const targetIsFocused = isVoiceChannelFocusedAudio(channel);
  const existingFocusedChannel = otherSubscriptions
    .map((subscribedChannelId) => channels.get(subscribedChannelId))
    .find((subscribedChannel) => isVoiceChannelFocusedAudio(subscribedChannel));

  if (targetIsFocused && otherSubscriptions.length > 0) {
    return {
      allowed: false,
      reason: 'This voice channel requires focused audio. Leave other listen-in channels first.'
    };
  }

  if (existingFocusedChannel) {
    return {
      allowed: false,
      reason: 'Your current voice channel requires focused audio. Leave it before listening elsewhere.'
    };
  }

  return { allowed: true };
}

function addVoiceSubscription(socketId: string, channelId: string): void {
	let channelSubscribers = voiceChannelSubscribers.get(channelId);
	if (!channelSubscribers) {
		channelSubscribers = new Set<string>();
		voiceChannelSubscribers.set(channelId, channelSubscribers);
	}
	channelSubscribers.add(socketId);

	let socketSubscriptions = socketVoiceSubscriptions.get(socketId);
	if (!socketSubscriptions) {
		socketSubscriptions = new Set<string>();
		socketVoiceSubscriptions.set(socketId, socketSubscriptions);
	}
	socketSubscriptions.add(channelId);
}

function removeVoiceSubscription(socketId: string, channelId: string): void {
	const channelSubscribers = voiceChannelSubscribers.get(channelId);
	if (channelSubscribers) {
		channelSubscribers.delete(socketId);
		if (channelSubscribers.size === 0) {
			voiceChannelSubscribers.delete(channelId);
		}
	}

	const socketSubscriptions = socketVoiceSubscriptions.get(socketId);
	if (socketSubscriptions) {
		socketSubscriptions.delete(channelId);
		if (socketSubscriptions.size === 0) {
			socketVoiceSubscriptions.delete(socketId);
		}
	}
}

function removeAllVoiceSubscriptionsForSocket(socketId: string): void {
	const channels = Array.from(socketVoiceSubscriptions.get(socketId) || []);
	for (const channelId of channels) {
		removeVoiceSubscription(socketId, channelId);
	}
}

function getVoiceAudienceSocketIds(channelId: string): Set<string> {
	const audience = new Set<string>();

	const participants = voiceChannelParticipants.get(channelId);
	if (participants) {
		for (const stableUserId of participants) {
			const participantSocketId = resolveSocketId(stableUserId);
			if (participantSocketId) {
				audience.add(participantSocketId);
			}
		}
	}

	const subscribers = voiceChannelSubscribers.get(channelId);
	if (subscribers) {
		for (const subscriberSocketId of subscribers) {
			audience.add(subscriberSocketId);
		}
	}

	return audience;
}

function emitToVoiceAudience(channelId: string, event: string, data: any): void {
	for (const socketId of getVoiceAudienceSocketIds(channelId)) {
		io.to(socketId).emit(event, data);
	}
}

function getVoiceStatePayload(): Record<string, Array<{ userId: string; socketId: string; username?: string; profilePicture?: string }>> {
	const payload: Record<string, Array<{ userId: string; socketId: string; username?: string; profilePicture?: string }>> = {};
	for (const channelId of voiceChannelParticipants.keys()) {
		payload[channelId] = getVoiceChannelMembers(channelId);
	}
	return payload;
}

function emitVoiceChannelState(channelId: string): void {
	const channel = channels.get(channelId);
	if (!channel || channel.type !== 'voice') return;

	const payload = {
		channelId,
		members: getVoiceChannelMembers(channelId)
	};

	for (const [, targetSocket] of io.sockets.sockets) {
		if (!socketCanAccessChannel(targetSocket, channel)) continue;
		targetSocket.emit("voice-channel-state", payload);
	}
}

function getBreakoutChannelsForParent(parentChannelId: string): Channel[] {
	return Array.from(channels.values())
		.filter(channel => channel.type === 'voice' && channel.parentChannelId === parentChannelId)
		.sort((a, b) => (a.breakoutIndex || 0) - (b.breakoutIndex || 0));
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

function isGroupCallEstablished(session: GroupCallSession): boolean {
  return session.connectedParticipants.size > 1;
}

function cancelPendingGroupCallInvites(session: GroupCallSession, cancelledByUserId?: string): void {
  const cancellingUserId = cancelledByUserId || session.lastInviteSenderId;
  if (!cancellingUserId) {
    session.invitedParticipants.clear();
    return;
  }

  for (const stableUserId of Array.from(session.invitedParticipants)) {
    emitToStableUser(stableUserId, "call-cancelled", {
      userId: cancellingUserId,
      channelId: session.channelId
    });
  }

  session.invitedParticipants.clear();
}

function cleanupIdleGroupCallSession(
  session: GroupCallSession,
  options: { cancelPending?: boolean; cancelledByUserId?: string } = {}
): boolean {
  if (session.connectedParticipants.size === 0) {
    if (session.invitedParticipants.size > 0 && options.cancelPending !== false) {
      cancelPendingGroupCallInvites(session, options.cancelledByUserId);
    }
    groupCallSessions.delete(session.channelId);
    return true;
  }

  if (
    session.connectedParticipants.size === 1 &&
    session.invitedParticipants.size === 0 &&
    !session.hasEverEstablished
  ) {
    groupCallSessions.delete(session.channelId);
    return true;
  }

  return false;
}

function emitGroupCallParticipantJoined(session: GroupCallSession, userId: string, username: string, excludeStableUserId: string): void {
  for (const stableUserId of session.connectedParticipants) {
    if (stableUserId === excludeStableUserId) continue;

    emitToStableUser(stableUserId, "group-call-participant-joined", {
      channelId: session.channelId,
      channelName: session.channelName,
      stableUserId: userId,
      userId,
      username
    });
  }
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

function emitGroupCallParticipantLeft(session: GroupCallSession, stableUserId: string, userId: string): void {
  for (const participantStableId of session.connectedParticipants) {
    emitToStableUser(participantStableId, "group-call-participant-left", {
      channelId: session.channelId,
      stableUserId,
      userId
    });
  }
}

function emitGroupCallInviteCleared(
  session: GroupCallSession,
  stableUserId: string,
  reason: "rejected" | "stopped" | "cancelled"
): void {
  const username = findUserByStableId(stableUserId)?.username || stableUserId;
  for (const participantStableId of session.connectedParticipants) {
    emitToStableUser(participantStableId, "group-call-invite-cleared", {
      channelId: session.channelId,
      stableUserId,
      username,
      reason
    });
  }
}

function joinGroupCallSession(session: GroupCallSession, stableUserId: string, socketId: string, username: string): void {
  const alreadyConnected = session.connectedParticipants.has(stableUserId);
  session.invitedParticipants.delete(stableUserId);
  if (alreadyConnected) return;

  session.connectedParticipants.add(stableUserId);
  if (session.connectedParticipants.size > 1) {
    session.hasEverEstablished = true;
  }
  emitGroupCallParticipantJoined(session, stableUserId, username, stableUserId);
  emitGroupCallRecordingPresence(session.channelId);
}

function removeGroupCallParticipantFromSession(
  session: GroupCallSession,
  stableUserId: string,
  options: { userId?: string; cancelPendingIfEmpty?: boolean; cancelledByUserId?: string } = {}
): void {
  const wasInvited = session.invitedParticipants.delete(stableUserId);
  const wasConnected = session.connectedParticipants.delete(stableUserId);

  if (!wasInvited && !wasConnected) return;

  if (wasInvited) {
    emitGroupCallInviteCleared(session, stableUserId, "cancelled");
  }

  if (wasConnected && options.userId) {
    emitGroupCallParticipantLeft(session, stableUserId, options.userId);
  }

  if (wasConnected) {
    removeRecorderFromGroupChannels(stableUserId, session.channelId);
  }

  cleanupIdleGroupCallSession(session, {
    cancelPending: options.cancelPendingIfEmpty,
    cancelledByUserId: options.cancelledByUserId
  });
}

function moveVoiceParticipant(stableUserId: string, fromChannelId: string, toChannelId: string): void {
	if (fromChannelId === toChannelId) return;
	const fromParticipants = voiceChannelParticipants.get(fromChannelId);
	if (!fromParticipants || !fromParticipants.has(stableUserId)) return;

	let toParticipants = voiceChannelParticipants.get(toChannelId);
	if (!toParticipants) {
		toParticipants = new Set<string>();
		voiceChannelParticipants.set(toChannelId, toParticipants);
	}
	if (toParticipants.has(stableUserId)) return;

	const memberUser = findUserByStableId(stableUserId);
	const memberSocketId = resolveSocketId(stableUserId) || stableUserId;

	fromParticipants.delete(stableUserId);
	if (fromParticipants.size === 0) {
		voiceChannelParticipants.delete(fromChannelId);
	}

	toParticipants.add(stableUserId);

	emitVoiceChannelState(fromChannelId);
	emitVoiceChannelState(toChannelId);
	syncVoiceRecordingPresenceForSocket(stableUserId, resolveSocketId(stableUserId) || stableUserId);
	emitVoiceChannelRecordingPresence(fromChannelId);
	emitVoiceChannelRecordingPresence(toChannelId);

	emitToVoiceAudience(fromChannelId, "voice-channel-user-left", {
		channelId: fromChannelId,
		userId: stableUserId,
		socketId: memberSocketId
	});
	emitToVoiceAudience(toChannelId, "voice-channel-user-joined", {
		channelId: toChannelId,
		userId: stableUserId,
		socketId: memberSocketId,
		username: memberUser?.username
	});
}

function addVoicePeerLink(stableA: string, stableB: string) {
  if (stableA === stableB) return;
  if (!voicePeerGraph.has(stableA)) voicePeerGraph.set(stableA, new Set());
  if (!voicePeerGraph.has(stableB)) voicePeerGraph.set(stableB, new Set());
  voicePeerGraph.get(stableA)!.add(stableB);
  voicePeerGraph.get(stableB)!.add(stableA);
}

function removeVoicePeerLink(stableA: string, stableB: string) {
  voicePeerGraph.get(stableA)?.delete(stableB);
  if ((voicePeerGraph.get(stableA)?.size || 0) === 0) voicePeerGraph.delete(stableA);
  voicePeerGraph.get(stableB)?.delete(stableA);
  if ((voicePeerGraph.get(stableB)?.size || 0) === 0) voicePeerGraph.delete(stableB);
}

function removeAllVoicePeerLinks(stableId: string): Set<string> {
  const peers = new Set(voicePeerGraph.get(stableId) || []);
  for (const peerStableId of peers) {
    voicePeerGraph.get(peerStableId)?.delete(stableId);
    if ((voicePeerGraph.get(peerStableId)?.size || 0) === 0) {
      voicePeerGraph.delete(peerStableId);
    }
  }
  voicePeerGraph.delete(stableId);
  return peers;
}

function addCallPeer(socketId: string, peerId: string) {
  if (!activeCallPeers.has(socketId)) activeCallPeers.set(socketId, new Set());
  if (!activeCallPeers.has(peerId)) activeCallPeers.set(peerId, new Set());
  activeCallPeers.get(socketId)!.add(peerId);
  activeCallPeers.get(peerId)!.add(socketId);
  emitDirectCallRecordingPresenceForSocketSet([socketId, peerId]);
}

function removeAllCallPeers(socketId: string): Set<string> {
  const peers = activeCallPeers.get(socketId) || new Set();
  for (const peerId of peers) {
    activeCallPeers.get(peerId)?.delete(socketId);
    if (activeCallPeers.get(peerId)?.size === 0) activeCallPeers.delete(peerId);
    emitDirectCallRecordingPresenceForSocket(peerId);
  }
  activeCallPeers.delete(socketId);
  return peers;
}

const WHITEBOARD_ROOM_PREFIX = "whiteboard:";
const WHITEBOARD_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const WHITEBOARD_MAX_LIVE_PAYLOAD_BYTES = 128 * 1024;
const WHITEBOARD_UPLOAD_PREFIX = 'wbi-';
const WHITEBOARD_ORPHAN_UPLOAD_GRACE_MS = 24 * 60 * 60 * 1000;
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

// Auto-delete message timers
const messageDeletionTimers = new Map<string, NodeJS.Timeout>(); // messageId -> timer

// Helper function to convert auto-delete duration to milliseconds
function getAutoDeleteMs(duration: string): number {
  const durations: Record<string, number> = {
    '5s': 5 * 1000,
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
    deleteUploadFileByUrl(message.fileUrl, 'auto-delete');
    if (message.files && message.files.length > 0) {
      for (const file of message.files) {
        deleteUploadFileByUrl(file.fileUrl, 'auto-delete');
      }
    }

    // Remove message
    messages.splice(messageIndex, 1);
    channelMessages.set(channelId, messages);

    // Soft-delete from database
    try { stateMessageStore.softDelete(messageId); } catch {}

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
const MESSAGES_FILE = join(DATA_DIR, 'messages.json');
const BUSINESS_DATA_DIR = join(DATA_DIR, BUSINESS_DATA_DIR_NAME);

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

if (ENABLE_LOGGING || statePlaneConfig.mode !== 'legacy') {
  console.log(
    `[StatePlane] mode=${statePlaneConfig.mode} read=${statePlaneConfig.stdbReadEnabled} write=${statePlaneConfig.stdbWriteEnabled} subs=${statePlaneConfig.stdbSubscriptionsEnabled} rbac=${statePlaneConfig.enforceRbac} schemaVersion=${statePlaneConfig.planeSchemaVersion} schemaAutoApply=${statePlaneConfig.planeSchemaAutoApply} warmup=${statePlaneConfig.shadowWarmupEnabled} warmupLimit=${statePlaneConfig.shadowWarmupLimit} outboxRedactSensitive=${statePlaneConfig.outboxRedactSensitive} outboxMaxBytes=${statePlaneConfig.outboxMaxBytes} outboxTruncateMinBytes=${statePlaneConfig.outboxTruncateMinBytes} shadowSink=${statePlaneConfig.shadowSink} shadowCommand=${Boolean(statePlaneConfig.shadowCommand)} shadowCommandTimeoutMs=${statePlaneConfig.shadowCommandTimeoutMs} shadowSigning=${Boolean(statePlaneConfig.shadowSigningSecret)} shadowSigningKeyId=${statePlaneConfig.shadowSigningKeyId || ''} reducerIngress=${statePlaneConfig.reducerIngressEnabled} reducerIngressRequireSignature=${statePlaneConfig.reducerIngressRequireSignature}`
  );
}

// Ensure emotes directory exists
if (!existsSync(EMOTES_DIR)) {
  mkdirSync(EMOTES_DIR, { recursive: true });
}

// Ensure uploads directory exists (imported from constants.ts)
if (!existsSync(UPLOADS_DIR)) {
  mkdirSync(UPLOADS_DIR, { recursive: true });
}
const RESUMABLE_UPLOADS_DIR = join(UPLOADS_DIR, '.resumable');
if (!existsSync(RESUMABLE_UPLOADS_DIR)) {
  mkdirSync(RESUMABLE_UPLOADS_DIR, { recursive: true });
}

interface ResumableUploadMeta {
  uploadId: string;
  ownerKey: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  channelId: string;
  createdAt: number;
  updatedAt: number;
  status: 'uploading' | 'completed';
  fileUrl?: string;
  attachmentStorage?: AttachmentStorageMeta;
  videoCompression?: UploadVideoCompressionMeta;
  videoCompressionVerification?: UploadVideoCompressionVerificationMeta;
}

interface AttachmentEncryptionMeta {
  scheme: 'dm-e2ee-v1';
  iv: string;
  mimeType?: string;
  originalSize?: number;
}

interface AttachmentStorageMeta {
  scheme: 'wabi-storage-v1';
  compressed: boolean;
  codec: 'identity' | 'gzip';
  originalSize: number;
  storedSize: number;
  atRestEncrypted: boolean;
}

function createUploadId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const AT_REST_MAGIC = Buffer.from('WABIENC1');
const FILE_ENCRYPTION_SECRET = process.env.FILE_ENCRYPTION_KEY || '';
const FILE_ENCRYPTION_KEY = FILE_ENCRYPTION_SECRET
  ? createHash('sha256').update(FILE_ENCRYPTION_SECRET).digest()
  : null;
const UPLOAD_TOKEN_SECRET = (process.env.UPLOAD_TOKEN_SECRET || process.env.JWT_SECRET || process.env.SESSION_SECRET || '').trim();
if (!UPLOAD_TOKEN_SECRET) {
  throw new Error('UPLOAD_TOKEN_SECRET (or JWT_SECRET/SESSION_SECRET) must be configured');
}
const UPLOAD_TOKEN_TTL_MS = 15 * 60 * 1000;

function base64UrlEncodeBuffer(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecodeToBuffer(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4);
  return Buffer.from(padded, 'base64');
}

function signUploadToken(uploadId: string, ownerKey: string): string {
  const payload = {
    uploadId,
    ownerKey,
    exp: Date.now() + UPLOAD_TOKEN_TTL_MS,
    nonce: randomBytes(6).toString('hex')
  };
  const payloadB64 = base64UrlEncodeBuffer(Buffer.from(JSON.stringify(payload)));
  const sig = createHmac('sha256', UPLOAD_TOKEN_SECRET).update(payloadB64).digest();
  return `${payloadB64}.${base64UrlEncodeBuffer(sig)}`;
}

function verifyUploadToken(token: string, uploadId: string, ownerKey: string): boolean {
  if (!token || token.indexOf('.') === -1) return false;
  const [payloadB64, sigB64] = token.split('.', 2);
  if (!payloadB64 || !sigB64) return false;
  try {
    const expectedSig = createHmac('sha256', UPLOAD_TOKEN_SECRET).update(payloadB64).digest();
    const providedSig = base64UrlDecodeToBuffer(sigB64);
    if (providedSig.length !== expectedSig.length || !timingSafeEqual(providedSig, expectedSig)) {
      return false;
    }
    const payload = JSON.parse(base64UrlDecodeToBuffer(payloadB64).toString('utf8')) as {
      uploadId: string;
      ownerKey: string;
      exp: number;
    };
    if (payload.uploadId !== uploadId) return false;
    if (payload.ownerKey !== ownerKey) return false;
    if (!payload.exp || payload.exp < Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

function maybeEncryptForAtRest(plain: Buffer): Buffer {
  if (!FILE_ENCRYPTION_KEY) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', FILE_ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([AT_REST_MAGIC, iv, tag, encrypted]);
}

function maybeDecryptFromAtRest(buffer: Buffer): Buffer {
  if (!buffer.slice(0, AT_REST_MAGIC.length).equals(AT_REST_MAGIC)) {
    return buffer;
  }
  if (!FILE_ENCRYPTION_KEY) {
    throw new Error('Encrypted upload payload found but FILE_ENCRYPTION_KEY is not configured');
  }
  const headerEnd = AT_REST_MAGIC.length + 12 + 16;
  if (buffer.length < headerEnd) {
    throw new Error('Invalid encrypted upload payload');
  }
  const iv = buffer.slice(AT_REST_MAGIC.length, AT_REST_MAGIC.length + 12);
  const tag = buffer.slice(AT_REST_MAGIC.length + 12, headerEnd);
  const ciphertext = buffer.slice(headerEnd);
  const decipher = createDecipheriv('aes-256-gcm', FILE_ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function writeUploadFile(filePath: string, payload: Buffer): void {
  writeFileSync(filePath, maybeEncryptForAtRest(payload));
}

async function writeUploadFileNonBlocking(filePath: string, payload: Buffer): Promise<void> {
  await writeFileAsync(filePath, maybeEncryptForAtRest(payload));
}

const UPLOAD_COMPRESSION_ENABLED = (process.env.UPLOAD_COMPRESSION_ENABLED || 'false') === 'true';
const UPLOAD_COMPRESSION_MIN_BYTES = Math.max(1024, Number(process.env.UPLOAD_COMPRESSION_MIN_BYTES || 4096));
const UPLOAD_COMPRESSION_GZIP_LEVEL = Math.min(9, Math.max(1, Number(process.env.UPLOAD_COMPRESSION_GZIP_LEVEL || 6)));
const UPLOAD_COMPRESSION_ROLLOUT_PERCENT = Math.max(0, Math.min(100, Number(process.env.UPLOAD_COMPRESSION_ROLLOUT_PERCENT || 100)));
const UPLOAD_COMPRESSION_ROLLOUT_SALT = process.env.UPLOAD_COMPRESSION_ROLLOUT_SALT || 'wabi-upload-rollout';
const UPLOAD_COMP_MAGIC = Buffer.from('WBZ1');
const UPLOAD_COMP_CODEC_GZIP = 1;
const UPLOAD_COMP_HEADER_SIZE = UPLOAD_COMP_MAGIC.length + 1 + 4;
const ALREADY_COMPRESSED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'webm', 'zip', 'pdf', 'gz', 'br', '7z', 'rar']);

const HTTP_TEXT_COMPRESSION_ENABLED = (process.env.HTTP_TEXT_COMPRESSION_ENABLED || 'true') === 'true';
const HTTP_TEXT_COMPRESSION_MIN_BYTES = Math.max(0, Number(process.env.HTTP_TEXT_COMPRESSION_MIN_BYTES || 1024));
const HTTP_TEXT_COMPRESSION_BROTLI_QUALITY = Math.min(11, Math.max(1, Number(process.env.HTTP_TEXT_COMPRESSION_BROTLI_QUALITY || 5)));
const HTTP_TEXT_COMPRESSION_GZIP_LEVEL = Math.min(9, Math.max(1, Number(process.env.HTTP_TEXT_COMPRESSION_GZIP_LEVEL || 6)));

function isCompressibleContentType(contentType: string): boolean {
  const normalized = (contentType || '').toLowerCase();
  return (
    normalized.startsWith('text/') ||
    normalized.includes('application/json') ||
    normalized.includes('application/javascript') ||
    normalized.includes('application/xml') ||
    normalized.includes('image/svg+xml')
  );
}

function chooseEncoding(acceptEncodingHeader: string | string[] | undefined): 'br' | 'gzip' | null {
  const rawValue = Array.isArray(acceptEncodingHeader)
    ? acceptEncodingHeader.join(',')
    : (acceptEncodingHeader || '');
  const raw = rawValue.toLowerCase();
  if (!raw) return null;
  if (raw.includes('br')) return 'br';
  if (raw.includes('gzip')) return 'gzip';
  return null;
}

function maybeCompressTextResponse(
  req: any,
  contentType: string,
  payload: Buffer
): { payload: Buffer; contentEncoding: 'br' | 'gzip' | null } {
  if (!HTTP_TEXT_COMPRESSION_ENABLED) return { payload, contentEncoding: null };
  if (req.method === 'HEAD') return { payload, contentEncoding: null };
  if (payload.length < HTTP_TEXT_COMPRESSION_MIN_BYTES) return { payload, contentEncoding: null };
  if (!isCompressibleContentType(contentType)) return { payload, contentEncoding: null };

  const encoding = chooseEncoding(req.headers['accept-encoding']);
  if (!encoding) return { payload, contentEncoding: null };

  try {
    const compressed = encoding === 'br'
      ? brotliCompressSync(payload, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: HTTP_TEXT_COMPRESSION_BROTLI_QUALITY
        }
      })
      : gzipSync(payload, { level: HTTP_TEXT_COMPRESSION_GZIP_LEVEL });
    if (compressed.length >= payload.length) {
      return { payload, contentEncoding: null };
    }
    return { payload: compressed, contentEncoding: encoding };
  } catch (error) {
    console.warn('[Compression] Failed to compress response, falling back to identity:', error);
    return { payload, contentEncoding: null };
  }
}

function getFileExtension(fileName: string): string {
  const clean = sanitizeUploadFileName(fileName || '');
  const idx = clean.lastIndexOf('.');
  if (idx < 0 || idx === clean.length - 1) return 'unknown';
  return clean.substring(idx + 1).toLowerCase();
}

function getMimeTypeFromDataUrl(input: string): string {
  if (!input || !input.startsWith('data:')) return 'application/octet-stream';
  const match = input.match(/^data:([^;,]+)[;,]/);
  return match?.[1] || 'application/octet-stream';
}

function shouldCompressUploadPayload(fileName: string, mimeType: string, payloadSize: number): boolean {
  if (!UPLOAD_COMPRESSION_ENABLED) return false;
  if (!Number.isFinite(payloadSize) || payloadSize < UPLOAD_COMPRESSION_MIN_BYTES) return false;
  const ext = getFileExtension(fileName);
  if (ALREADY_COMPRESSED_EXTENSIONS.has(ext)) return false;
  const mime = (mimeType || '').toLowerCase();
  if (!mime || mime === 'application/octet-stream') return false;
  if (
    mime.startsWith('text/') ||
    mime.includes('application/json') ||
    mime.includes('application/javascript') ||
    mime.includes('application/xml') ||
    mime.includes('image/svg+xml')
  ) {
    return true;
  }
  return false;
}

function isUploadCompressionInRollout(rolloutKey: string): boolean {
  if (UPLOAD_COMPRESSION_ROLLOUT_PERCENT <= 0) return false;
  if (UPLOAD_COMPRESSION_ROLLOUT_PERCENT >= 100) return true;
  const digest = createHash('sha1').update(`${UPLOAD_COMPRESSION_ROLLOUT_SALT}:${rolloutKey}`).digest();
  const bucket = digest.readUInt32BE(0) % 100;
  return bucket < UPLOAD_COMPRESSION_ROLLOUT_PERCENT;
}

function maybeCompressUploadPayload(fileName: string, mimeType: string, payload: Buffer, rolloutKey: string): { payload: Buffer; meta: AttachmentStorageMeta } {
  const identityMeta = (): AttachmentStorageMeta => ({
    scheme: 'wabi-storage-v1',
    compressed: false,
    codec: 'identity',
    originalSize: payload.length,
    storedSize: payload.length,
    atRestEncrypted: Boolean(FILE_ENCRYPTION_KEY)
  });

  if (!shouldCompressUploadPayload(fileName, mimeType, payload.length)) {
    return { payload, meta: identityMeta() };
  }
  if (!isUploadCompressionInRollout(rolloutKey)) {
    return { payload, meta: identityMeta() };
  }

  if (payload.length > 0xffffffff) {
    return { payload, meta: identityMeta() };
  }

  try {
    const compressed = gzipSync(payload, { level: UPLOAD_COMPRESSION_GZIP_LEVEL });
    if (compressed.length >= payload.length) {
      return { payload, meta: identityMeta() };
    }

    const header = Buffer.alloc(UPLOAD_COMP_HEADER_SIZE);
    UPLOAD_COMP_MAGIC.copy(header, 0);
    header.writeUInt8(UPLOAD_COMP_CODEC_GZIP, UPLOAD_COMP_MAGIC.length);
    header.writeUInt32BE(payload.length, UPLOAD_COMP_MAGIC.length + 1);
    const encoded = Buffer.concat([header, compressed]);
    return {
      payload: encoded,
      meta: {
        scheme: 'wabi-storage-v1',
        compressed: true,
        codec: 'gzip',
        originalSize: payload.length,
        storedSize: encoded.length,
        atRestEncrypted: Boolean(FILE_ENCRYPTION_KEY)
      }
    };
  } catch (error) {
    console.warn('[UploadCompression] Failed to compress upload payload; storing uncompressed', error);
    return { payload, meta: identityMeta() };
  }
}

async function maybeCompressUploadPayloadNonBlocking(fileName: string, mimeType: string, payload: Buffer, rolloutKey: string): Promise<{ payload: Buffer; meta: AttachmentStorageMeta }> {
  const identityMeta = (): AttachmentStorageMeta => ({
    scheme: 'wabi-storage-v1',
    compressed: false,
    codec: 'identity',
    originalSize: payload.length,
    storedSize: payload.length,
    atRestEncrypted: Boolean(FILE_ENCRYPTION_KEY)
  });

  if (!shouldCompressUploadPayload(fileName, mimeType, payload.length)) {
    return { payload, meta: identityMeta() };
  }
  if (!isUploadCompressionInRollout(rolloutKey)) {
    return { payload, meta: identityMeta() };
  }
  if (payload.length > 0xffffffff) {
    return { payload, meta: identityMeta() };
  }

  try {
    const compressed = await gzipAsync(payload, { level: UPLOAD_COMPRESSION_GZIP_LEVEL });
    if (compressed.length >= payload.length) {
      return { payload, meta: identityMeta() };
    }

    const header = Buffer.alloc(UPLOAD_COMP_HEADER_SIZE);
    UPLOAD_COMP_MAGIC.copy(header, 0);
    header.writeUInt8(UPLOAD_COMP_CODEC_GZIP, UPLOAD_COMP_MAGIC.length);
    header.writeUInt32BE(payload.length, UPLOAD_COMP_MAGIC.length + 1);
    const encoded = Buffer.concat([header, compressed]);
    return {
      payload: encoded,
      meta: {
        scheme: 'wabi-storage-v1',
        compressed: true,
        codec: 'gzip',
        originalSize: payload.length,
        storedSize: encoded.length,
        atRestEncrypted: Boolean(FILE_ENCRYPTION_KEY)
      }
    };
  } catch (error) {
    console.warn('[UploadCompression] Failed to compress upload payload; storing uncompressed', error);
    return { payload, meta: identityMeta() };
  }
}

function maybeDecompressUploadPayload(buffer: Buffer): { payload: Buffer; compressed: boolean } {
  if (buffer.length < UPLOAD_COMP_HEADER_SIZE) return { payload: buffer, compressed: false };
  if (!buffer.slice(0, UPLOAD_COMP_MAGIC.length).equals(UPLOAD_COMP_MAGIC)) {
    return { payload: buffer, compressed: false };
  }

  const codec = buffer.readUInt8(UPLOAD_COMP_MAGIC.length);
  const originalSize = buffer.readUInt32BE(UPLOAD_COMP_MAGIC.length + 1);
  const payload = buffer.slice(UPLOAD_COMP_HEADER_SIZE);

  try {
    if (codec === UPLOAD_COMP_CODEC_GZIP) {
      const decompressed = gunzipSync(payload);
      if (decompressed.length !== originalSize) {
        throw new Error(`Size mismatch after gzip decode: expected=${originalSize}, actual=${decompressed.length}`);
      }
      return { payload: decompressed, compressed: true };
    }
  } catch (error) {
    console.warn('[UploadCompression] Failed to decompress upload payload; returning stored bytes', error);
    return { payload: buffer, compressed: false };
  }

  return { payload: buffer, compressed: false };
}

function sanitizeUploadFileName(fileName: string): string {
  const base = basename(fileName || 'upload.bin');
  return base.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

function createUploadFileId(prefix: string, fileName: string): string {
  const safeName = sanitizeUploadFileName(fileName || 'upload.bin');
  const nonce = randomBytes(6).toString('hex');
  return `${prefix}${Date.now()}-${nonce}-${safeName}`;
}

function getWhiteboardUploadScopeTag(boardId: string): string {
  return createHash('sha256').update(boardId).digest('hex').slice(0, 16);
}

function createWhiteboardUploadFileId(boardId: string, fileName: string): string {
  const safeName = sanitizeUploadFileName(fileName || 'whiteboard-image.bin');
  const nonce = randomBytes(6).toString('hex');
  return `${WHITEBOARD_UPLOAD_PREFIX}${getWhiteboardUploadScopeTag(boardId)}-${Date.now()}-${nonce}-${safeName}`;
}

function isWhiteboardUploadFileId(fileId: string): boolean {
  return typeof fileId === 'string' && fileId.startsWith(WHITEBOARD_UPLOAD_PREFIX);
}

function isWhiteboardUploadFileIdForBoard(boardId: string, fileId: string): boolean {
  return fileId.startsWith(`${WHITEBOARD_UPLOAD_PREFIX}${getWhiteboardUploadScopeTag(boardId)}-`);
}

function createWhiteboardUploadUrl(boardId: string, fileId: string): string {
  return `/api/whiteboard/boards/${encodeURIComponent(boardId)}/files/${encodeURIComponent(fileId)}`;
}

function decodePathSegment(rawSegment: string | undefined | null): string | null {
  if (typeof rawSegment !== 'string' || rawSegment.length === 0) return null;
  try {
    return decodeURIComponent(rawSegment);
  } catch {
    return null;
  }
}

function normalizeUploadFileIdSegment(rawSegment: string | undefined | null): string | null {
  const decoded = decodePathSegment(rawSegment);
  if (!decoded) return null;
  const normalized = decoded.replace(/\\/g, '/');
  if (normalized.includes('/')) return null;
  const safeId = basename(normalized);
  if (!safeId || safeId === '.' || safeId === '..') return null;
  return safeId;
}

function normalizeUploadFileIdFromUrl(fileUrl: string | undefined | null): string | null {
  if (typeof fileUrl !== 'string' || !fileUrl.startsWith('/uploads/')) return null;
  return normalizeUploadFileIdSegment(fileUrl.slice('/uploads/'.length));
}

function normalizeWhiteboardUploadFileIdFromUrl(boardId: string, fileUrl: string | undefined | null): string | null {
  if (typeof fileUrl !== 'string' || fileUrl.trim().length === 0) return null;

  try {
    const parsed = new URL(fileUrl, 'http://wabi.local');
    const match = parsed.pathname.match(/^\/api\/whiteboard\/boards\/([^/]+)\/files\/([^/]+)$/);
    if (!match) return null;

    const scopedBoardId = decodePathSegment(match[1])?.trim() || '';
    if (!scopedBoardId || scopedBoardId !== boardId) return null;

    const fileId = normalizeUploadFileIdSegment(match[2]);
    if (!fileId || !isWhiteboardUploadFileIdForBoard(boardId, fileId)) return null;
    return fileId;
  } catch {
    return null;
  }
}

function collectWhiteboardUploadFileIdsFromDocument(boardId: string, document: unknown): Set<string> {
  const referencedFileIds = new Set<string>();
  const rawElements =
    isObjectRecord(document) && Array.isArray(document.elements)
      ? document.elements
      : [];

  for (const rawElement of rawElements) {
    if (!isObjectRecord(rawElement)) continue;

    const rawAssetId = typeof rawElement.assetId === 'string' ? rawElement.assetId.trim() : '';
    if (rawAssetId) {
      const assetId = normalizeUploadFileIdSegment(rawAssetId);
      if (assetId && isWhiteboardUploadFileIdForBoard(boardId, assetId)) {
        referencedFileIds.add(assetId);
      }
    }

    const rawSrc = typeof rawElement.src === 'string' ? rawElement.src.trim() : '';
    if (!rawSrc) continue;

    const fileId = normalizeWhiteboardUploadFileIdFromUrl(boardId, rawSrc);
    if (fileId) {
      referencedFileIds.add(fileId);
    }
  }

  return referencedFileIds;
}

function listWhiteboardScopedUploadFiles(): Array<{ fileId: string; filePath: string; mtimeMs: number }> {
  if (!existsSync(UPLOADS_DIR)) return [];

  const scopedUploads: Array<{ fileId: string; filePath: string; mtimeMs: number }> = [];
  for (const fileId of readdirSync(UPLOADS_DIR)) {
    if (!isWhiteboardUploadFileId(fileId)) continue;

    const filePath = resolveUploadPath(fileId);
    if (!filePath || !existsSync(filePath)) continue;

    try {
      const fileStat = statSync(filePath);
      if (!fileStat.isFile()) continue;
      scopedUploads.push({
        fileId,
        filePath,
        mtimeMs: fileStat.mtimeMs
      });
    } catch (error) {
      console.error(`[WhiteboardCleanup] Failed to inspect whiteboard upload ${fileId}:`, error);
    }
  }

  return scopedUploads;
}

function cleanupWhiteboardOrphanUploads(logLabel: string): {
  boardCount: number;
  referencedCount: number;
  scannedFiles: number;
  deletedFiles: number;
  retainedByGrace: number;
} {
  const boards = whiteboardRepository.listAll();
  const referencedFileIds = new Set<string>();
  for (const board of boards) {
    for (const fileId of collectWhiteboardUploadFileIdsFromDocument(board.boardId, board.document)) {
      referencedFileIds.add(fileId);
    }
  }

  const cutoffMs = Date.now() - WHITEBOARD_ORPHAN_UPLOAD_GRACE_MS;
  let scannedFiles = 0;
  let deletedFiles = 0;
  let retainedByGrace = 0;

  for (const candidate of listWhiteboardScopedUploadFiles()) {
    scannedFiles++;
    if (referencedFileIds.has(candidate.fileId)) continue;
    if (candidate.mtimeMs > cutoffMs) {
      retainedByGrace++;
      continue;
    }

    try {
      unlinkSync(candidate.filePath);
      deletedFiles++;
      if (ENABLE_LOGGING) {
        console.log(`[${logLabel}] Deleted orphan whiteboard upload: ${candidate.fileId}`);
      }
    } catch (error) {
      console.error(`[${logLabel}] Failed to delete orphan whiteboard upload ${candidate.fileId}:`, error);
    }
  }

  return {
    boardCount: boards.length,
    referencedCount: referencedFileIds.size,
    scannedFiles,
    deletedFiles,
    retainedByGrace
  };
}

function resolveUploadPath(fileId: string): string | null {
  const safeId = basename(fileId || '');
  if (!safeId) return null;
  const uploadsRoot = resolve(UPLOADS_DIR);
  const candidate = resolve(uploadsRoot, safeId);
  if (candidate !== uploadsRoot && !candidate.startsWith(`${uploadsRoot}${sep}`)) {
    return null;
  }
  return candidate;
}

function normalizeClientUploadUrl(fileUrl: string | undefined | null): string | null {
  const fileId = normalizeUploadFileIdFromUrl(fileUrl);
  if (!fileId) return null;
  return `/uploads/${fileId}`;
}

function deleteUploadFileByUrl(fileUrl: string | undefined | null, logLabel: string): void {
  const fileId = normalizeUploadFileIdFromUrl(fileUrl);
  if (!fileId) return;
  const filePath = resolveUploadPath(fileId);
  if (!filePath) return;

  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      if (ENABLE_LOGGING) {
        console.log(`[${logLabel}] Deleted upload file: ${fileId}`);
      }
    }
  } catch (error) {
    console.error(`[${logLabel}] Failed to delete upload file ${fileId}:`, error);
  }
}

function normalizeClientFileAttachment(
  file: { fileUrl: string; fileName: string; fileSize: number; attachmentEncryption?: AttachmentEncryptionMeta; attachmentStorage?: AttachmentStorageMeta }
): { fileUrl: string; fileName: string; fileSize: number; attachmentEncryption?: AttachmentEncryptionMeta; attachmentStorage?: AttachmentStorageMeta } | null {
  const normalizedUrl = normalizeClientUploadUrl(file.fileUrl);
  if (!normalizedUrl) return null;
  return {
    fileUrl: normalizedUrl,
    fileName: sanitizeUploadFileName(file.fileName || basename(normalizedUrl)),
    fileSize: Number.isFinite(file.fileSize) ? Math.max(0, Math.floor(file.fileSize)) : 0,
    attachmentEncryption: file.attachmentEncryption,
    attachmentStorage: file.attachmentStorage
  };
}

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

function getUploadOwnerKey(userId: number | null, guestSessionId: string | null): string | null {
  if (userId) return `user:${userId}`;
  if (guestSessionId && sessions.has(guestSessionId)) return `guest:${guestSessionId}`;
  return null;
}

function getResumableMetaPath(uploadId: string): string {
  return join(RESUMABLE_UPLOADS_DIR, `${uploadId}.json`);
}

function getResumablePartPath(uploadId: string): string {
  return join(RESUMABLE_UPLOADS_DIR, `${uploadId}.part`);
}

const MAX_REQUEST_BODY_BYTES = Math.max(
  64 * 1024,
  Math.min(256 * 1024 * 1024, Number(process.env.MAX_REQUEST_BODY_BYTES || 16 * 1024 * 1024))
);

function loadResumableMeta(uploadId: string): ResumableUploadMeta | null {
  const metaPath = getResumableMetaPath(uploadId);
  if (!existsSync(metaPath)) return null;
  try {
    const raw = readFileSync(metaPath, 'utf8');
    return JSON.parse(raw) as ResumableUploadMeta;
  } catch {
    return null;
  }
}

function saveResumableMeta(meta: ResumableUploadMeta): void {
  const metaPath = getResumableMetaPath(meta.uploadId);
  writeFileSync(metaPath, JSON.stringify(meta));
}

function getUploadedBytes(uploadId: string): number {
  const partPath = getResumablePartPath(uploadId);
  if (!existsSync(partPath)) return 0;
  try {
    return statSync(partPath).size;
  } catch {
    return 0;
  }
}

function readRequestBuffer(req: any, maxBytes: number = MAX_REQUEST_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;

    req.on('data', (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        done = true;
        const err = new Error(`request_body_too_large:${maxBytes}`);
        (err as any).code = 'REQUEST_BODY_TOO_LARGE';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err: Error) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

function readMultipartSingleFile(
  contentTypeHeader: string | undefined,
  body: Buffer,
  expectedFieldName: string
): { fileName: string; data: Buffer; contentType: string | null } | null {
  const boundary = contentTypeHeader?.split('boundary=')[1];
  if (!boundary) return null;

  const parts = body.toString('binary').split(`--${boundary}`);
  for (const part of parts) {
    if (!part.includes('Content-Disposition')) continue;
    const fieldMatch = part.match(/name="([^"]+)"/);
    const fieldName = fieldMatch?.[1] || '';
    if (fieldName !== expectedFieldName) continue;

    const filenameMatch = part.match(/filename="([^"]+)"/);
    const fileName = filenameMatch?.[1] || '';
    if (!fileName) continue;

    const dataStart = part.indexOf('\r\n\r\n') + 4;
    const dataEnd = part.lastIndexOf('\r\n');
    if (dataStart < 4 || dataEnd <= dataStart) continue;

    const contentTypeMatch = part.match(/Content-Type:\s*([^\r\n]+)/i);
    return {
      fileName,
      data: Buffer.from(part.substring(dataStart, dataEnd), 'binary'),
      contentType: contentTypeMatch?.[1]?.trim() || null
    };
  }

  return null;
}

function getUploadTokenFromRequest(req: any, url: URL): string {
  const headerToken = req.headers['x-upload-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }
  const queryToken = url.searchParams.get('uploadToken');
  return queryToken?.trim() || '';
}

function isPrivateOrReservedIpv4(ip: string): boolean {
  const octets = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return true;
  }
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateOrReservedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
    return true;
  }
  return false;
}

function isBlockedHostName(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === 'localhost' || normalized.endsWith('.localhost');
}

function isPrivateOrReservedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateOrReservedIpv4(ip);
  if (version === 6) return isPrivateOrReservedIpv6(ip);
  return true;
}

async function assertSafeExternalUrl(rawUrl: string): Promise<URL> {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP(S) URLs are allowed');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Credentialed URLs are not allowed');
  }
  if (isBlockedHostName(parsed.hostname)) {
    throw new Error('Hostname is not allowed');
  }

  if (isIP(parsed.hostname) > 0) {
    if (isPrivateOrReservedIp(parsed.hostname)) {
      throw new Error('Private or reserved IPs are not allowed');
    }
    return parsed;
  }

  let records: Awaited<ReturnType<typeof dnsLookup>>;
  try {
    records = await dnsLookup(parsed.hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('Failed to resolve target host');
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('Failed to resolve target host');
  }
  for (const record of records) {
    if (isPrivateOrReservedIp(record.address)) {
      throw new Error('Resolved host maps to a blocked IP range');
    }
  }
  return parsed;
}

function isRedirectStatusCode(statusCode: number): boolean {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308;
}

async function fetchExternalUrlWithGuards(
  rawUrl: string,
  init: RequestInit,
  maxRedirects = 3
): Promise<Response> {
  let nextUrl = await assertSafeExternalUrl(rawUrl);
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await fetch(nextUrl.toString(), {
      ...init,
      redirect: 'manual'
    });
    if (!isRedirectStatusCode(response.status)) {
      return response;
    }
    const location = response.headers.get('location');
    if (!location) {
      return response;
    }
    if (hop === maxRedirects) {
      throw new Error('Too many redirects');
    }
    const redirected = new URL(location, nextUrl);
    nextUrl = await assertSafeExternalUrl(redirected.toString());
  }
  throw new Error('Too many redirects');
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

function getRequestStableActorId(userId: number | null, guestSessionId: string | null): string | null {
  if (typeof userId === 'number' && Number.isFinite(userId) && userId > 0) {
    return `user-${Math.floor(userId)}`;
  }
  if (guestSessionId && sessions.has(guestSessionId)) {
    return `guest-session:${guestSessionId}`;
  }
  return null;
}

function canRequestAccessChannel(
  userId: number | null,
  guestSessionId: string | null,
  channelId: string
): { allowed: true; channel: DbChannel } | { allowed: false; status: number; error: string } {
  const channel = channelRepository.findById(channelId);
  if (!channel) {
    return { allowed: false, status: 404, error: 'Channel not found' };
  }

  const isDmLike = channel.channel_type === 'dm' || channel.channel_type === 'group';
  if (isDmLike) {
    if (!userId) {
      return { allowed: false, status: 403, error: 'Registered membership is required for this whiteboard' };
    }
    if (!channelMemberRepository.isMember(channelId, `user-${userId}`)) {
      return { allowed: false, status: 403, error: 'Not a member of this whiteboard scope' };
    }
    return { allowed: true, channel };
  }

  if (!userId && (!guestSessionId || !sessions.has(guestSessionId))) {
    return { allowed: false, status: 401, error: 'Authentication required' };
  }

  const requiredRole = channel.min_role || 'guest';
  const highestRole = userId ? getUserRoleInfo(userId).highestRole : 'guest';
  if (getRolePriority(highestRole, DEFAULT_WORKSPACE_ID) < getRolePriority(requiredRole, DEFAULT_WORKSPACE_ID)) {
    return { allowed: false, status: 403, error: 'Insufficient role for this whiteboard scope' };
  }

  return { allowed: true, channel };
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
  if (!actorStableId) {
    return { allowed: false, status: 401, error: 'Authentication required' };
  }

  let board = whiteboardRepository.getByBoardId(boardId);
  if (!board) {
    if (!options.createIfMissing) {
      return { allowed: false, status: 404, error: 'Whiteboard not found' };
    }
    if (!boardId.startsWith('channel:')) {
      return { allowed: false, status: 404, error: 'Whiteboard not found' };
    }
    const channelId = boardId.slice('channel:'.length);
    const access = canRequestAccessChannel(userId, guestSessionId, channelId);
    if (!access.allowed) {
      return access;
    }
    board = whiteboardRepository.getOrCreateForChannel(channelId, actorStableId);
    return { allowed: true, board, channel: access.channel, actorStableId };
  }

  if (board.scopeType !== 'channel') {
    return { allowed: false, status: 400, error: 'Unsupported whiteboard scope' };
  }

  const access = canRequestAccessChannel(userId, guestSessionId, board.scopeId);
  if (!access.allowed) {
    return access;
  }

  return { allowed: true, board, channel: access.channel, actorStableId };
}

function serveUploadByFileId(
  req: any,
  res: any,
  fileId: string,
  options: {
    cacheControl: string;
    allowRange?: boolean;
  }
): void {
  const downloadStartedAt = Date.now();
  const filePath = resolveUploadPath(fileId);
  if (!filePath) {
    res.writeHead(403);
    res.end("Access denied");
    return;
  }

  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end("Upload not found");
    return;
  }

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
  let encryptedAtRest = false;
  let decryptedBuffer: Buffer | null = null;
  let responseBuffer: Buffer | null = null;
  let compressedAtRest = false;
  let responseSize = stat.size;
  try {
    const storedBuffer = readFileSync(filePath);
    let plainBuffer = storedBuffer;
    if (storedBuffer.slice(0, AT_REST_MAGIC.length).equals(AT_REST_MAGIC)) {
      encryptedAtRest = true;
      decryptedBuffer = maybeDecryptFromAtRest(storedBuffer);
      plainBuffer = decryptedBuffer;
    }

    const maybeDecompressed = maybeDecompressUploadPayload(plainBuffer);
    if (maybeDecompressed.compressed) {
      compressedAtRest = true;
    }
    responseBuffer = maybeDecompressed.payload;
    responseSize = responseBuffer.length;
    if (encryptedAtRest) {
      decryptedBuffer = responseBuffer;
    }
  } catch (error) {
    console.error('Upload read/decrypt error:', error);
    res.writeHead(500);
    res.end("Failed to read upload");
    return;
  }

  const etag = `"${responseSize}-${Math.floor(stat.mtimeMs)}"`;
  const headers: Record<string, string | number> = {
    'Content-Type': contentType,
    'Cache-Control': options.cacheControl,
    'ETag': etag,
    'Last-Modified': stat.mtime.toUTCString(),
    'Accept-Ranges': (encryptedAtRest || compressedAtRest || options.allowRange === false) ? 'none' : 'bytes',
    'X-Content-Type-Options': 'nosniff',
  };

  const originHeader = req.headers.origin;
  if (originHeader) {
    headers['Access-Control-Allow-Origin'] = originHeader;
    headers['Access-Control-Allow-Methods'] = 'GET, HEAD, OPTIONS';
  }

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    res.end();
    return;
  }

  const rangeHeader = req.headers.range;
  if (rangeHeader && options.allowRange !== false && !encryptedAtRest && !compressedAtRest) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : responseSize - 1;
      if (start >= responseSize || end >= responseSize || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${responseSize}` });
        res.end();
        return;
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${responseSize}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      recordCompressionDownloadSample({
        timestamp: Date.now(),
        fileExt: getFileExtension(fileId),
        mimeType: contentType,
        storedBytes: stat.size,
        responseBytes: end - start + 1,
        durationMs: Date.now() - downloadStartedAt,
        decryptedAtRest: false,
        rangeRequest: true,
        streamed: true,
        statusCode: 206
      });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        createReadStream(filePath, { start, end }).pipe(res);
      }
      return;
    }
  }

  headers['Content-Length'] = responseSize;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  if ((encryptedAtRest || compressedAtRest) && responseBuffer) {
    recordCompressionDownloadSample({
      timestamp: Date.now(),
      fileExt: getFileExtension(fileId),
      mimeType: contentType,
      storedBytes: stat.size,
      responseBytes: responseBuffer.length,
      durationMs: Date.now() - downloadStartedAt,
      decryptedAtRest: encryptedAtRest || compressedAtRest,
      rangeRequest: false,
      streamed: false,
      statusCode: 200
    });
    res.end(responseBuffer);
    return;
  }

  recordCompressionDownloadSample({
    timestamp: Date.now(),
    fileExt: getFileExtension(fileId),
    mimeType: contentType,
    storedBytes: stat.size,
    responseBytes: responseSize,
    durationMs: Date.now() - downloadStartedAt,
    decryptedAtRest: false,
    rangeRequest: false,
    streamed: true,
    statusCode: 200
  });
  createReadStream(filePath).pipe(res);
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

  // Plugin admin APIs
  if (url.pathname === "/api/plugins" && req.method === "GET") {
    const userId = getAuthenticatedUserId(req);
    const isAdmin = isPluginAdmin(userId);

    if (!pluginLoader.isSystemEnabled()) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          plugins: [],
          scope: isAdmin ? "admin" : "public",
          enabled: false,
          installEnabled: false
        })
      );
      return;
    }

    try {
      const plugins = pluginLoader.getLoadedPlugins();
      const responsePlugins = isAdmin
        ? plugins
        : plugins.map((plugin) => ({
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            description: plugin.description,
            hasFrontend: plugin.hasFrontend,
            hasBackend: plugin.hasBackend
          }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, plugins: responsePlugins, scope: isAdmin ? "admin" : "public" }));
    } catch (error) {
      console.error("[Plugins] Failed to fetch plugin list:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Failed to list plugins" }));
    }
    return;
  }

  if (url.pathname === "/api/plugins/audit" && req.method === "GET") {
    if (!pluginLoader.isSystemEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Plugin system is disabled by operator" }));
      return;
    }

    const userId = getAuthenticatedUserId(req);
    if (!isPluginAdmin(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin permissions required" }));
      return;
    }

    try {
      const rawLimit = Number(url.searchParams.get("limit") || "200");
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(1000, Math.floor(rawLimit))) : 200;
      const events = pluginLoader.getAuditEvents(limit);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, events }));
    } catch (error) {
      console.error("[Plugins] Failed to fetch audit log:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Failed to fetch plugin audit log" }));
    }
    return;
  }

  if (url.pathname === "/api/plugins/signers" && req.method === "GET") {
    if (!pluginLoader.isSystemEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Plugin system is disabled by operator" }));
      return;
    }

    const userId = getAuthenticatedUserId(req);
    if (!isPluginAdmin(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin permissions required" }));
      return;
    }

    try {
      const signers = pluginLoader.getTrustedSigners();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, signers }));
    } catch (error) {
      console.error("[Plugins] Failed to fetch trusted signers:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Failed to fetch trusted signers" }));
    }
    return;
  }

  if (url.pathname === "/api/plugins/signers" && req.method === "POST") {
    if (!pluginLoader.isSystemEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Plugin system is disabled by operator" }));
      return;
    }

    const userId = getAuthenticatedUserId(req);
    if (!isPluginAdmin(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin permissions required" }));
      return;
    }

    try {
      const bodyBuffer = await readRequestBuffer(req);
      const body = JSON.parse(bodyBuffer.toString("utf-8"));
      const keyId = typeof body?.keyId === "string" ? body.keyId.trim() : "";
      const publicKey = typeof body?.publicKey === "string" ? body.publicKey.trim() : "";
      const note = typeof body?.note === "string" ? body.note.trim() : undefined;

      if (!keyId || !publicKey) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "keyId and publicKey are required" }));
        return;
      }

      pluginLoader.trustSigner({
        keyId,
        publicKey,
        trustedBy: `user:${userId}`,
        note
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, signers: pluginLoader.getTrustedSigners() }));
    } catch (error) {
      console.error("[Plugins] Failed to trust signer:", error);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Invalid request payload" }));
    }
    return;
  }

  if (url.pathname === "/api/plugins/install" && req.method === "POST") {
    if (!pluginLoader.isSystemEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Plugin system is disabled by operator" }));
      return;
    }

    if (!pluginLoader.isInstallEnabled()) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Plugin install is disabled by operator" }));
      return;
    }

    const userId = getAuthenticatedUserId(req);
    if (!isPluginAdmin(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin permissions required" }));
      return;
    }

    try {
      const bodyBuffer = await readRequestBuffer(req, 110 * 1024 * 1024);
      const uploaded = readMultipartSingleFile(req.headers['content-type'], bodyBuffer, 'pluginPackage');
      if (!uploaded) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "pluginPackage file is required (multipart/form-data)" }));
        return;
      }

      if (uploaded.data.length > 100 * 1024 * 1024) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Plugin package is too large (max 100MB)" }));
        return;
      }

      const lowerName = uploaded.fileName.toLowerCase();
      if (!lowerName.endsWith('.zip') && !lowerName.endsWith('.wabi-plugin') && !lowerName.endsWith('.wabip')) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Plugin package must be a .zip, .wabi-plugin, or .wabip file" }));
        return;
      }

      const result = await pluginLoader.installPluginFromArchive(uploaded.data, {
        uploadedBy: `user:${userId}`,
        fileName: uploaded.fileName
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, plugin: result }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to install plugin package";
      if (message.startsWith('request_body_too_large')) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Plugin package payload exceeds server request limit" }));
        return;
      }
      const isClientError =
        message.includes('already installed') ||
        message.includes('No plugin.json') ||
        message.includes('Plugin manifest') ||
        message.includes('Unsafe archive') ||
        message.includes('Plugin id');
      res.writeHead(isClientError ? 400 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: message }));
    }
    return;
  }

  const policyPathMatch = url.pathname.match(/^\/api\/admin\/policies\/([^/]+)$/);
  if (policyPathMatch && req.method === "GET") {
    const userId = getAuthenticatedUserId(req);
    if (!isPluginAdmin(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin permissions required" }));
      return;
    }

    const requestedKey = decodeURIComponent(policyPathMatch[1]);
    if (!isKnownPolicyKey(requestedKey)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Unknown policy key" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        success: true,
        key: requestedKey,
        config: getPolicyValue(requestedKey),
        defaults: getPolicyDefaults(requestedKey)
      })
    );
    return;
  }

  if (policyPathMatch && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    if (!isPluginAdmin(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin permissions required" }));
      return;
    }

    const requestedKey = decodeURIComponent(policyPathMatch[1]);
    if (!isKnownPolicyKey(requestedKey)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Unknown policy key" }));
      return;
    }

    try {
      const rawBody = JSON.parse((await readRequestBuffer(req)).toString() || '{}');
      const config = savePolicyValue(requestedKey, rawBody);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        key: requestedKey,
        config,
        restartRequired: requestedKey === RUNTIME_TUNING_POLICY_KEY
      }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Invalid policy payload" }));
    }
    return;
  }

  // Compatibility alias for older clients
  if (url.pathname === "/api/admin/upload-limits" && req.method === "GET") {
    const userId = getAuthenticatedUserId(req);
    if (!isPluginAdmin(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin permissions required" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        success: true,
        config: getPolicyValue<UploadLimitConfig>(UPLOAD_LIMITS_POLICY_KEY),
        defaults: getPolicyDefaults<UploadLimitConfig>(UPLOAD_LIMITS_POLICY_KEY)
      })
    );
    return;
  }

  if (url.pathname === "/api/admin/upload-limits" && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    if (!isPluginAdmin(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin permissions required" }));
      return;
    }

    try {
      const rawBody = JSON.parse((await readRequestBuffer(req)).toString() || '{}');
      const config = savePolicyValue<UploadLimitConfig>(UPLOAD_LIMITS_POLICY_KEY, rawBody);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, config }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Invalid upload limit payload" }));
    }
    return;
  }

  if (url.pathname === "/api/admin/compression-metrics" && req.method === "GET") {
    const userId = getAuthenticatedUserId(req);
    if (!isPluginAdmin(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin permissions required" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      metrics: getCompressionMetricsSnapshot()
    }));
    return;
  }

  if (url.pathname === "/api/admin/compression-config" && req.method === "GET") {
    const userId = getAuthenticatedUserId(req);
    if (!isPluginAdmin(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin permissions required" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      config: {
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
      }
    }));
    return;
  }

  if (url.pathname === "/api/admin/runtime-guardrails" && req.method === "GET") {
    const userId = getAuthenticatedUserId(req);
    if (!isPluginAdmin(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin permissions required" }));
      return;
    }

    const configured = getPolicyValue<RuntimeTuningConfig>(RUNTIME_TUNING_POLICY_KEY);
    const runtimeSnapshot = getRuntimeGuardrailsSnapshot();
    const currentUvThreadpoolSize = process.env.UV_THREADPOOL_SIZE
      ? Number(process.env.UV_THREADPOOL_SIZE)
      : null;
    const restartRequired = JSON.stringify(configured) !== JSON.stringify(startupRuntimeTuning);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      runtimeTuning: {
        configured,
        startupApplied: startupRuntimeTuning,
        restartRequired,
        effective: {
          uvThreadpoolSize: Number.isFinite(currentUvThreadpoolSize as number)
            ? currentUvThreadpoolSize
            : null,
          heavyProfilingEnabled: runtimeSnapshot.heavyProfiling.enabled
        }
      },
      guardrails: runtimeSnapshot
    }));
    return;
  }

  if (url.pathname === stateReducerIngress.getPath() && req.method === "POST") {
    if (!stateReducerIngress.isEnabled()) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Reducer ingress is disabled" }));
      return;
    }

    const maxBodyBytes = stateReducerIngress.getMaxBodyBytes();
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let responded = false;

    req.on('data', (chunk) => {
      if (responded) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBodyBytes) {
        responded = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: false,
          error: `Payload exceeds reducer ingress limit (${maxBodyBytes} bytes)`
        }));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });

    req.on('end', () => {
      if (responded) return;
      const body = Buffer.concat(chunks).toString('utf8');
      const result = stateReducerIngress.handle({
        headers: req.headers as Record<string, string | string[] | undefined>,
        body,
        remoteAddress: req.socket.remoteAddress || null
      });
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: result.success,
        duplicate: result.duplicate,
        reason: result.reason,
        message: result.message
      }));
    });

    req.on('error', (error) => {
      if (responded) return;
      responded = true;
      console.error('[StatePlane] Reducer ingress request failed:', error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Reducer ingress request failed" }));
    });
    return;
  }

  if (url.pathname === "/api/internal/mesh/deliver" && req.method === "POST") {
    const meshToken = getMeshSharedToken();
    if (!meshToken) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Mesh delivery is not configured" }));
      return;
    }

    const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : '';
    const expected = `Bearer ${meshToken}`;
    if (!authHeader || !constantTimeEqualString(authHeader, expected)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Unauthorized mesh delivery" }));
      return;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let responded = false;
    const maxBodyBytes = 256 * 1024;

    req.on('data', (chunk) => {
      if (responded) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBodyBytes) {
        responded = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Mesh delivery payload too large" }));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });

    req.on('end', () => {
      if (responded) return;
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const delivery = normalizeMeshInboundDelivery(JSON.parse(body));
        if (hasSeenMeshDelivery(delivery.deliveryId)) {
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, duplicate: true }));
          return;
        }

        const delivered = applyInboundMeshDelivery(delivery);
        if (delivered) {
          markSeenMeshDelivery(delivery.deliveryId);
        }
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, delivered }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }));
      }
    });

    req.on('error', (error) => {
      if (responded) return;
      responded = true;
      console.error('[StateMesh] Mesh delivery request failed:', error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Mesh delivery request failed" }));
    });
    return;
  }

  if (url.pathname === "/api/admin/state-plane" && req.method === "GET") {
    const userId = getAuthenticatedUserId(req);
    if (!isPluginAdmin(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin permissions required" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      runtime: getStatePlaneRuntimeStats()
    }));
    return;
  }

  if (url.pathname === "/api/admin/legacy-message-status" && req.method === "GET") {
    const userId = getAuthenticatedUserId(req);
    if (!isPluginAdmin(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin permissions required" }));
      return;
    }

    const messageId = (url.searchParams.get("messageId") || "").trim();
    if (!messageId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "messageId is required" }));
      return;
    }

    const message = messageRepository.findByMessageId(messageId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      exists: Boolean(message),
      mode: "legacy_sqlite"
    }));
    return;
  }

  if (url.pathname === "/api/admin/compression-metrics/reset" && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    if (!isPluginAdmin(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin permissions required" }));
      return;
    }

    resetCompressionMetrics();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  if (url.pathname.startsWith("/api/plugins/signers/") && req.method === "DELETE") {
    if (!pluginLoader.isSystemEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Plugin system is disabled by operator" }));
      return;
    }

    const userId = getAuthenticatedUserId(req);
    if (!isPluginAdmin(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin permissions required" }));
      return;
    }

    try {
      const keyId = decodeURIComponent(url.pathname.replace("/api/plugins/signers/", "")).trim();
      if (!keyId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "keyId is required" }));
        return;
      }

      pluginLoader.untrustSigner(keyId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, signers: pluginLoader.getTrustedSigners() }));
    } catch (error) {
      console.error("[Plugins] Failed to remove trusted signer:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Failed to remove trusted signer" }));
    }
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

          const fileId = createUploadFileId('pfp-', profilePictureFileName);
          const filePath = resolveUploadPath(fileId);
          if (!filePath) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: 'Failed to resolve upload path' }));
            return;
          }

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

          const fileId = createUploadFileId('group-avatar-', avatarFileName);
          const filePath = resolveUploadPath(fileId);
          if (!filePath) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: 'Failed to resolve upload path' }));
            return;
          }

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

          const fileId = createUploadFileId('bg-', backgroundImageFileName);
          const filePath = resolveUploadPath(fileId);
          if (!filePath) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: 'Failed to resolve upload path' }));
            return;
          }

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

  if (url.pathname === "/api/telemetry/video-compression" && req.method === "POST") {
    if (!VIDEO_COMPRESSION_CLIENT_METRICS_ENABLED) {
      res.writeHead(204);
      res.end();
      return;
    }

    const userId = getAuthenticatedUserId(req);
    const guestSessionId = getGuestSessionId(req);
    const ownerKey = getUploadOwnerKey(userId, guestSessionId);
    if (!ownerKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized - authentication required' }));
      return;
    }

    if (!consumeVideoCompressionTelemetryQuota(ownerKey)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Telemetry rate limit exceeded' }));
      return;
    }

    try {
      const payload = JSON.parse((await readRequestBuffer(req)).toString() || '{}') as {
        outcome?: unknown;
        runtime?: unknown;
        preset?: unknown;
        inputBytes?: unknown;
        outputBytes?: unknown;
        durationMs?: unknown;
        failureCode?: unknown;
      };

      const outcome = sanitizeVideoCompressionTelemetryOutcome(payload.outcome);
      const runtime = sanitizeVideoCompressionTelemetryRuntime(payload.runtime);
      const preset = sanitizeTelemetryString(payload.preset, 48);
      const inputBytes = sanitizeTelemetryNumericValue(payload.inputBytes, 1, 5 * GB);
      const outputBytes = sanitizeTelemetryNumericValue(payload.outputBytes, 0, 5 * GB);
      const durationMs = sanitizeTelemetryNumericValue(payload.durationMs, 0, 30 * 60 * 1000);
      const failureCode = sanitizeTelemetryString(payload.failureCode, 64);

      if (!outcome || !runtime || !preset || inputBytes === null) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Invalid telemetry payload' }));
        return;
      }
      if (outcome === 'success' && outputBytes === null) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Successful telemetry must include outputBytes' }));
        return;
      }

      recordClientVideoCompressionSample({
        timestamp: Date.now(),
        runtime,
        preset,
        outcome,
        inputBytes,
        outputBytes,
        durationMs,
        failureCode
      });

      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Invalid telemetry payload' }));
    }
    return;
  }

  // File upload endpoint
  if (url.pathname === "/api/upload/resumable/init" && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    const guestSessionId = getGuestSessionId(req);
    const ownerKey = getUploadOwnerKey(userId, guestSessionId);
    if (!ownerKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized - authentication required' }));
      return;
    }

    try {
      const payload = JSON.parse((await readRequestBuffer(req)).toString() || '{}') as {
        uploadId?: string;
        fileName?: string;
        fileSize?: number;
        mimeType?: string;
        channelId?: string;
        videoCompression?: unknown;
      };

      const fileName = sanitizeUploadFileName(payload.fileName || '');
      const fileSize = Number(payload.fileSize || 0);
      const mimeType = (payload.mimeType || 'application/octet-stream').slice(0, 100);
      const channelId = (payload.channelId || '').slice(0, 100);
      const videoCompression = sanitizeUploadVideoCompressionMeta(payload.videoCompression, fileSize);

      if (!fileName || !fileSize || fileSize <= 0 || !Number.isFinite(fileSize)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Invalid file metadata' }));
        return;
      }
      if (!enforceUploadLimit(res, userId, guestSessionId, fileSize, fileName, 'resumable-init')) {
        return;
      }

      let uploadId = (payload.uploadId || '').trim();
      let meta: ResumableUploadMeta | null = null;

      if (uploadId) {
        meta = loadResumableMeta(uploadId);
        if (!meta || meta.ownerKey !== ownerKey || meta.fileSize !== fileSize || meta.fileName !== fileName) {
          uploadId = '';
          meta = null;
        }
      }

      if (!uploadId) {
        uploadId = createUploadId();
        meta = {
          uploadId,
          ownerKey,
          fileName,
          fileSize,
          mimeType,
          channelId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          status: 'uploading',
          ...(videoCompression ? { videoCompression } : {})
        };
        saveResumableMeta(meta);
      }

      const uploadedBytes = getUploadedBytes(uploadId);
      if (meta && videoCompression && uploadedBytes === 0) {
        const existing = meta.videoCompression;
        const changed =
          !existing ||
          existing.originalSize !== videoCompression.originalSize ||
          existing.compressedSize !== videoCompression.compressedSize ||
          existing.preset !== videoCompression.preset ||
          existing.runtime !== videoCompression.runtime ||
          existing.codec !== videoCompression.codec ||
          existing.mimeType !== videoCompression.mimeType;
        if (changed) {
          meta.videoCompression = videoCompression;
          meta.videoCompressionVerification = undefined;
          meta.updatedAt = Date.now();
          saveResumableMeta(meta);
        }
      }
      const completed = !!meta?.fileUrl || (meta?.status === 'completed' && typeof meta.fileUrl === 'string');

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        uploadId,
        uploadedBytes,
        completed,
        fileUrl: meta?.fileUrl || null,
        videoCompression: meta?.videoCompressionVerification || null,
        uploadToken: signUploadToken(uploadId, ownerKey)
      }));
    } catch (error) {
      console.error('Resumable upload init error:', error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Failed to initialize resumable upload' }));
    }
    return;
  }

  if (url.pathname === "/api/upload/resumable/status" && req.method === "GET") {
    const userId = getAuthenticatedUserId(req);
    const guestSessionId = getGuestSessionId(req);
    const ownerKey = getUploadOwnerKey(userId, guestSessionId);
    if (!ownerKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized - authentication required' }));
      return;
    }

    const uploadId = (url.searchParams.get('uploadId') || '').trim();
    if (!uploadId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'uploadId is required' }));
      return;
    }

    const meta = loadResumableMeta(uploadId);
    if (!meta || meta.ownerKey !== ownerKey) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Upload session not found' }));
      return;
    }
    const uploadToken = getUploadTokenFromRequest(req, url);
    if (!verifyUploadToken(uploadToken, uploadId, ownerKey)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Invalid or expired upload token' }));
      return;
    }

    const uploadedBytes = getUploadedBytes(uploadId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      uploadId,
      uploadedBytes,
      fileSize: meta.fileSize,
      completed: meta.status === 'completed',
      fileUrl: meta.fileUrl || null,
      videoCompression: meta.videoCompressionVerification || null,
      uploadToken: signUploadToken(uploadId, ownerKey)
    }));
    return;
  }

  if (url.pathname === "/api/upload/resumable/chunk" && req.method === "PUT") {
    const userId = getAuthenticatedUserId(req);
    const guestSessionId = getGuestSessionId(req);
    const ownerKey = getUploadOwnerKey(userId, guestSessionId);
    if (!ownerKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized - authentication required' }));
      return;
    }

    const uploadId = (url.searchParams.get('uploadId') || '').trim();
    const offset = Number(url.searchParams.get('offset') || '0');
    if (!uploadId || !Number.isFinite(offset) || offset < 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Invalid uploadId or offset' }));
      return;
    }

    const meta = loadResumableMeta(uploadId);
    if (!meta || meta.ownerKey !== ownerKey) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Upload session not found' }));
      return;
    }
    const uploadToken = getUploadTokenFromRequest(req, url);
    if (!verifyUploadToken(uploadToken, uploadId, ownerKey)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Invalid or expired upload token' }));
      return;
    }
    if (meta.status === 'completed') {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Upload already completed', fileUrl: meta.fileUrl || null }));
      return;
    }
    if (!enforceUploadLimit(res, userId, guestSessionId, meta.fileSize, meta.fileName, 'resumable-chunk')) {
      return;
    }

    try {
      const chunk = await readRequestBuffer(req, 64 * 1024 * 1024);
      if (!chunk.length) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Empty chunk' }));
        return;
      }

      const currentSize = getUploadedBytes(uploadId);
      if (offset > currentSize) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: false,
          error: 'Offset mismatch',
          expectedOffset: currentSize,
          uploadToken: signUploadToken(uploadId, ownerKey)
        }));
        return;
      }

      if (offset < currentSize) {
        const alreadyCovered = (offset + chunk.length) <= currentSize;
        if (alreadyCovered) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, uploadedBytes: currentSize, uploadToken: signUploadToken(uploadId, ownerKey) }));
          return;
        }
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: false,
          error: 'Overlapping chunk',
          expectedOffset: currentSize,
          uploadToken: signUploadToken(uploadId, ownerKey)
        }));
        return;
      }

      if ((currentSize + chunk.length) > meta.fileSize) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Chunk exceeds declared file size' }));
        return;
      }

      const partPath = getResumablePartPath(uploadId);
      const fh = await openFileAsync(partPath, 'a+');
      try {
        await fh.write(chunk, 0, chunk.length, offset);
      } finally {
        await fh.close();
      }

      meta.updatedAt = Date.now();
      saveResumableMeta(meta);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        uploadedBytes: currentSize + chunk.length,
        uploadToken: signUploadToken(uploadId, ownerKey)
      }));
    } catch (error) {
      console.error('Resumable upload chunk error:', error);
      const message = error instanceof Error ? error.message : '';
      if (message.startsWith('request_body_too_large')) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Chunk exceeds server request limit' }));
        return;
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Failed to upload chunk' }));
    }
    return;
  }

  if (url.pathname === "/api/upload/resumable/complete" && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    const guestSessionId = getGuestSessionId(req);
    const ownerKey = getUploadOwnerKey(userId, guestSessionId);
    const uploadStartedAt = Date.now();
    if (!ownerKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized - authentication required' }));
      return;
    }

    try {
      const payload = JSON.parse((await readRequestBuffer(req)).toString() || '{}') as { uploadId?: string; uploadToken?: string };
      const uploadId = (payload.uploadId || '').trim();
      if (!uploadId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'uploadId is required' }));
        return;
      }

      const meta = loadResumableMeta(uploadId);
      if (!meta || meta.ownerKey !== ownerKey) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Upload session not found' }));
        return;
      }
      if (!verifyUploadToken((payload.uploadToken || '').trim(), uploadId, ownerKey)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Invalid or expired upload token' }));
        return;
      }

      if (meta.status === 'completed' && meta.fileUrl) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          fileUrl: meta.fileUrl,
          fileName: meta.fileName,
          fileSize: meta.fileSize,
          attachmentStorage: meta.attachmentStorage,
          videoCompression: meta.videoCompressionVerification || null
        }));
        return;
      }

      const uploadedBytes = getUploadedBytes(uploadId);
      if (uploadedBytes !== meta.fileSize) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: false,
          error: 'Upload incomplete',
          uploadedBytes,
          expectedBytes: meta.fileSize
        }));
        return;
      }

      const fileId = createUploadFileId('upload-', meta.fileName);
      const filePath = resolveUploadPath(fileId);
      if (!filePath) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Failed to resolve upload path' }));
        return;
      }
      const partPath = getResumablePartPath(uploadId);
      const finalPlain = await readFileAsync(partPath);
      const storageResult = await maybeCompressUploadPayloadNonBlocking(meta.fileName, meta.mimeType || 'application/octet-stream', finalPlain, `${ownerKey}:${meta.fileName}:${meta.fileSize}`);
      await writeUploadFileNonBlocking(filePath, storageResult.payload);
      const storedStat = await statAsync(filePath);
      const storedBytes = storedStat.size;
      recordCompressionUploadSample({
        timestamp: Date.now(),
        source: 'resumable-complete',
        fileExt: getFileExtension(meta.fileName),
        mimeType: meta.mimeType || 'application/octet-stream',
        originalBytes: storageResult.meta.originalSize,
        storedBytes,
        durationMs: Date.now() - uploadStartedAt,
        atRestEncrypted: Boolean(FILE_ENCRYPTION_KEY)
      });
      await unlinkAsync(partPath);

      meta.status = 'completed';
      meta.fileUrl = `/uploads/${fileId}`;
      meta.attachmentStorage = { ...storageResult.meta, storedSize: storedBytes };
      if (meta.videoCompression) {
        meta.videoCompressionVerification = verifyUploadVideoCompressionMeta(
          meta.videoCompression,
          meta.fileSize,
          meta.mimeType || 'application/octet-stream',
          meta.fileName
        );
      } else {
        meta.videoCompressionVerification = undefined;
      }
      meta.updatedAt = Date.now();
      saveResumableMeta(meta);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        fileUrl: meta.fileUrl,
        fileName: meta.fileName,
        fileSize: meta.fileSize,
        attachmentStorage: meta.attachmentStorage,
        videoCompression: meta.videoCompressionVerification || null
      }));
    } catch (error) {
      console.error('Resumable upload complete error:', error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Failed to finalize upload' }));
    }
    return;
  }

  // File upload endpoint
  if (url.pathname === "/api/upload" && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    const guestSessionId = getGuestSessionId(req);
    const isGuestSessionValid = !!guestSessionId && sessions.has(guestSessionId);
    const ownerKey = getUploadOwnerKey(userId, guestSessionId) || `anon:${Date.now()}`;
    const uploadStartedAt = Date.now();

    if (!userId && !isGuestSessionValid) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized - authentication required' }));
      return;
    }

    let body = '';
    let chunks: Buffer[] = [];
    let uploadTotalBytes = 0;

    req.on('data', (chunk) => {
      uploadTotalBytes += chunk.length;
      if (uploadTotalBytes > MULTIPART_UPLOAD_MAX_BYTES) {
        req.destroy();
        chunks = [];
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', async () => {
      if (uploadTotalBytes > MULTIPART_UPLOAD_MAX_BYTES) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Upload too large' }));
        return;
      }
      try {
        const buffer = Buffer.concat(chunks);
        const boundary = req.headers['content-type']?.split('boundary=')[1];

        if (!boundary) {
          // Handle JSON upload (base64)
          const data = JSON.parse(buffer.toString());
          const { fileName, fileData } = data;
          const safeFileName = sanitizeUploadFileName(fileName || 'upload.bin');

          // Save file
          const fileId = createUploadFileId('upload-', safeFileName);
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
          // Convert base64 to buffer and save
          const fileBuffer = Buffer.from(fileData.split(',')[1], 'base64');
          if (!enforceUploadLimit(res, userId, guestSessionId, fileBuffer.length, safeFileName, 'direct-upload')) {
            return;
          }
          const mimeType = getMimeTypeFromDataUrl(fileData || '');
          const storageResult = await maybeCompressUploadPayloadNonBlocking(safeFileName, mimeType, fileBuffer, `${ownerKey}:${safeFileName}:${fileBuffer.length}`);
          await writeUploadFileNonBlocking(filePath, storageResult.payload);
          const storedBytes = (await statAsync(filePath)).size;
          recordCompressionUploadSample({
            timestamp: Date.now(),
            source: 'direct-upload-json',
            fileExt: getFileExtension(safeFileName),
            mimeType,
            originalBytes: storageResult.meta.originalSize,
            storedBytes,
            durationMs: Date.now() - uploadStartedAt,
            atRestEncrypted: Boolean(FILE_ENCRYPTION_KEY)
          });

          const fileUrl = `/uploads/${fileId}`;

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            success: true,
            fileUrl,
            fileName: safeFileName,
            fileSize: fileBuffer.length,
            attachmentStorage: { ...storageResult.meta, storedSize: storedBytes }
          }));
        } else {
          // Handle multipart/form-data upload
          const parts = buffer.toString('binary').split(`--${boundary}`);
          let fileName = '';
          let fileData: Buffer | null = null;

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
                // Ignore non-file form fields for now.
              }
            }
          }

          if (fileData && fileName) {
            const safeFileName = sanitizeUploadFileName(fileName || 'upload.bin');
            if (!enforceUploadLimit(res, userId, guestSessionId, fileData.length, safeFileName, 'direct-upload')) {
              return;
            }
            const fileId = createUploadFileId('upload-', safeFileName);
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
            const storageResult = await maybeCompressUploadPayloadNonBlocking(safeFileName, 'application/octet-stream', fileData, `${ownerKey}:${safeFileName}:${fileData.length}`);
            await writeUploadFileNonBlocking(filePath, storageResult.payload);
            const storedBytes = (await statAsync(filePath)).size;
            recordCompressionUploadSample({
              timestamp: Date.now(),
              source: 'direct-upload-multipart',
              fileExt: getFileExtension(safeFileName),
              mimeType: 'application/octet-stream',
              originalBytes: storageResult.meta.originalSize,
              storedBytes,
              durationMs: Date.now() - uploadStartedAt,
              atRestEncrypted: Boolean(FILE_ENCRYPTION_KEY)
            });

            const fileUrl = `/uploads/${fileId}`;

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              success: true,
              fileUrl,
              fileName: safeFileName,
              fileSize: fileData.length,
              attachmentStorage: { ...storageResult.meta, storedSize: storedBytes }
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
      const ownerKey = getUploadOwnerKey(userId, guestSessionId) || access.actorStableId;
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

  // Setup network hint endpoint — saves operator's network config notes to app_settings

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
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Missing or invalid authorization' }));
      return;
    }

    await handleGetTurnCredentials(req, res, userId);
    return;
  }

  if (url.pathname === "/api/media/livekit/token" && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Missing or invalid authorization' }));
      return;
    }

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
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Missing or invalid authorization' }));
      return;
    }
    await handleCreateMediaGatewaySession(req, res, userId);
    return;
  }

  if (url.pathname === "/api/media/gateway/sessions" && req.method === "GET") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Missing or invalid authorization' }));
      return;
    }
    await handleListMediaGatewaySessions(req, res, userId);
    return;
  }

  const mediaGatewaySessionMatch = url.pathname.match(/^\/api\/media\/gateway\/session\/([a-f0-9]{16,64})$/);
  if (mediaGatewaySessionMatch && req.method === "GET") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Missing or invalid authorization' }));
      return;
    }
    await handleGetMediaGatewaySession(req, res, userId, mediaGatewaySessionMatch[1]);
    return;
  }

  const mediaGatewaySessionCloseMatch = url.pathname.match(/^\/api\/media\/gateway\/session\/([a-f0-9]{16,64})\/close$/);
  if (mediaGatewaySessionCloseMatch && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Missing or invalid authorization' }));
      return;
    }
    await handleCloseMediaGatewaySession(req, res, userId, mediaGatewaySessionCloseMatch[1]);
    return;
  }

  const mediaGatewaySessionRenewMatch = url.pathname.match(/^\/api\/media\/gateway\/session\/([a-f0-9]{16,64})\/renew$/);
  if (mediaGatewaySessionRenewMatch && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Missing or invalid authorization' }));
      return;
    }
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
    const userId = getAuthenticatedUserIdFromRequest(req);
    if (!isPluginAdmin(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin permissions required" }));
      return;
    }
    await handleUpsertPlace(req, res);
    return;
  }

  const placeDeleteMatch = url.pathname.match(/^\/api\/places\/([^/]+)$/);
  if (placeDeleteMatch && req.method === "DELETE") {
    const userId = getAuthenticatedUserIdFromRequest(req);
    if (!isPluginAdmin(userId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin permissions required" }));
      return;
    }
    await handleDeletePlace(req, res, decodeURIComponent(placeDeleteMatch[1]));
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
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

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
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    await handleListAlbums(req, res, url, userId);
    return;
  }

  if (url.pathname === "/api/albums" && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    await handleCreateAlbum(req, res, userId);
    return;
  }

  const albumDeleteMatch = url.pathname.match(/^\/api\/albums\/(\d+)$/);
  if (albumDeleteMatch && req.method === "DELETE") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    await handleDeleteAlbum(req, res, userId, albumDeleteMatch[1]);
    return;
  }

  const albumFeaturedMatch = url.pathname.match(/^\/api\/albums\/(\d+)\/featured$/);
  if (albumFeaturedMatch && req.method === "PATCH") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    await handleSetAlbumFeatured(req, res, userId, albumFeaturedMatch[1]);
    return;
  }

  const albumItemsMatch = url.pathname.match(/^\/api\/albums\/(\d+)\/items$/);
  if (albumItemsMatch && req.method === "GET") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    await handleListAlbumItems(req, res, url, userId, albumItemsMatch[1]);
    return;
  }

  if (albumItemsMatch && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
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
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    await handleReorderAlbumItems(req, res, userId, albumItemsReorderMatch[1]);
    return;
  }

  const albumItemDeleteMatch = url.pathname.match(/^\/api\/albums\/(\d+)\/items\/(\d+)$/);
  if (albumItemDeleteMatch && req.method === "DELETE") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    await handleDeleteAlbumItem(req, res, userId, albumItemDeleteMatch[1], albumItemDeleteMatch[2]);
    return;
  }

  if (url.pathname === "/api/dictionary" && req.method === "POST") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    await handleDictionaryUpsert(req, res, userId);
    return;
  }

  if (url.pathname === "/api/dictionary" && req.method === "DELETE") {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const roles = getUserRoles(userId, 'default-workspace');
    const canModerate = roles.includes('owner') || roles.includes('admin') || roles.includes('mod');
    await handleDictionaryDelete(req, res, userId, canModerate);
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
        _businessSyncInFlight = false;
      } catch (error) {
        console.error('Sync business data error:', error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Failed to sync business data' }));
        _businessSyncInFlight = false;
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
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json", ...getCORSHeaders(req.headers.origin as string) });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized - authentication required' }));
      return;
    }

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
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json", ...getCORSHeaders(req.headers.origin as string) });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized - authentication required' }));
      return;
    }

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
      messageDeletionTimers.forEach((timer) => clearTimeout(timer));
      messageDeletionTimers.clear();

      // Clear persisted messages from database
      const deletedDbMessages = stateMessageStore.clearAll();
      const deletedOfflineMessages = offlineMessageRepository.clearAll();

      // Remove legacy disk message cache if present.
      if (existsSync(MESSAGES_FILE)) {
        try {
          unlinkSync(MESSAGES_FILE);
        } catch (err) {
          console.error('Failed to delete legacy messages.json:', err);
        }
      }

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
    const downloadStartedAt = Date.now();
    const fileId = normalizeUploadFileIdFromUrl(url.pathname);
    if (!fileId) {
      res.writeHead(403);
      res.end("Access denied");
      return;
    }

    const filePath = resolveUploadPath(fileId);
    if (!filePath) {
      res.writeHead(403);
      res.end("Access denied");
      return;
    }

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
      let encryptedAtRest = false;
      let decryptedBuffer: Buffer | null = null;
      let responseBuffer: Buffer | null = null;
      let compressedAtRest = false;
      let responseSize = stat.size;
      try {
        const storedBuffer = readFileSync(filePath);
        let plainBuffer = storedBuffer;
        if (storedBuffer.slice(0, AT_REST_MAGIC.length).equals(AT_REST_MAGIC)) {
          encryptedAtRest = true;
          decryptedBuffer = maybeDecryptFromAtRest(storedBuffer);
          plainBuffer = decryptedBuffer;
        }

        const maybeDecompressed = maybeDecompressUploadPayload(plainBuffer);
        if (maybeDecompressed.compressed) {
          compressedAtRest = true;
        }
        responseBuffer = maybeDecompressed.payload;
        responseSize = responseBuffer.length;
        if (encryptedAtRest) {
          decryptedBuffer = responseBuffer;
        }
      } catch (error) {
        console.error('Upload read/decrypt error:', error);
        res.writeHead(500);
        res.end("Failed to read upload");
        return;
      }

      const etag = `"${responseSize}-${Math.floor(stat.mtimeMs)}"`;

      const headers: Record<string, string | number> = {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'ETag': etag,
        'Last-Modified': stat.mtime.toUTCString(),
        'Accept-Ranges': (encryptedAtRest || compressedAtRest) ? 'none' : 'bytes',
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
      if (rangeHeader && !encryptedAtRest && !compressedAtRest) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (match) {
          const start = parseInt(match[1], 10);
          const end = match[2] ? parseInt(match[2], 10) : responseSize - 1;
          if (start >= responseSize || end >= responseSize || start > end) {
            res.writeHead(416, { 'Content-Range': `bytes */${responseSize}` });
            res.end();
            return;
          }
          headers['Content-Range'] = `bytes ${start}-${end}/${responseSize}`;
          headers['Content-Length'] = end - start + 1;
          res.writeHead(206, headers);
          recordCompressionDownloadSample({
            timestamp: Date.now(),
            fileExt: getFileExtension(fileId),
            mimeType: contentType,
            storedBytes: stat.size,
            responseBytes: end - start + 1,
            durationMs: Date.now() - downloadStartedAt,
            decryptedAtRest: false,
            rangeRequest: true,
            streamed: true,
            statusCode: 206
          });
          createReadStream(filePath, { start, end }).pipe(res);
          return;
        }
      }

      // Full response
      headers['Content-Length'] = responseSize;
      res.writeHead(200, headers);
      if ((encryptedAtRest || compressedAtRest) && responseBuffer) {
        recordCompressionDownloadSample({
          timestamp: Date.now(),
          fileExt: getFileExtension(fileId),
          mimeType: contentType,
          storedBytes: stat.size,
          responseBytes: responseBuffer.length,
          durationMs: Date.now() - downloadStartedAt,
          decryptedAtRest: encryptedAtRest || compressedAtRest,
          rangeRequest: false,
          streamed: false,
          statusCode: 200
        });
        res.end(responseBuffer);
      } else {
        recordCompressionDownloadSample({
          timestamp: Date.now(),
          fileExt: getFileExtension(fileId),
          mimeType: contentType,
          storedBytes: stat.size,
          responseBytes: responseSize,
          durationMs: Date.now() - downloadStartedAt,
          decryptedAtRest: false,
          rangeRequest: false,
          streamed: true,
          statusCode: 200
        });
        createReadStream(filePath).pipe(res);
      }
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
    const stats = cleanupWhiteboardOrphanUploads(logLabel);
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

// Define the deleteMessageById function now that emitToChannel is available
deleteMessageById = (channelId: string, messageId: string) => {
  const messages = channelMessages.get(channelId) || [];
  const messageIndex = messages.findIndex(m => m.id === messageId);

  if (messageIndex === -1) return;

  const message = messages[messageIndex];

  // Delete associated files from filesystem
  deleteUploadFileByUrl(message.fileUrl, 'deleteMessageById');
  if (message.files && message.files.length > 0) {
    for (const file of message.files) {
      deleteUploadFileByUrl(file.fileUrl, 'deleteMessageById');
    }
  }

  // Remove message
  messages.splice(messageIndex, 1);
  channelMessages.set(channelId, messages);

  // Soft-delete from database
  try { stateMessageStore.softDelete(messageId); } catch {}

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
function loadUserChannelsFromDB(stableUserId: string, currentHighestRole?: string): Channel[] {
  try {
    // Get channels where user is a member from DB (using stable user_id)
    const userChannels = channelRepository.findByUserId(stableUserId);

    for (const dbChannel of userChannels) {
      if (!channels.has(dbChannel.channel_id)) {
        // Get members for this channel (these are stable IDs)
        const memberIds = channelMemberRepository.getMemberIds(dbChannel.channel_id);

        // Add to in-memory channels
        channels.set(dbChannel.channel_id, {
          id: dbChannel.channel_id,
          name: dbChannel.name,
          description: dbChannel.description || '',
          watchQueueEnabled: (dbChannel as any).watch_queue_enabled === 1,
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
          persistMessages: dbChannel.persist_messages === 1,
          voiceSettings: parseVoiceSettings(dbChannel.voice_settings_json),
          recipientNotified: true // Already persisted, so both sides know
        });

        // Keep login path fast: seed channel with an empty window and defer history fetch
        // to explicit join-channel / load-history requests unless preload is enabled.
        if (!channelMessages.has(dbChannel.channel_id)) {
          channelMessages.set(dbChannel.channel_id, []);
        }

        if (
          PRELOAD_CHANNEL_HISTORY_ON_LOGIN &&
          (channelMessages.get(dbChannel.channel_id)?.length || 0) === 0
        ) {
          try {
            const dbMessages = stateMessageStore.getByChannel(dbChannel.channel_id, { limit: 50 });
            const clientMessages = dbMessages.map(msg => stateMessageStore.toClientFormat(msg));
            channelMessages.set(dbChannel.channel_id, clientMessages);

            if (ENABLE_LOGGING && dbMessages.length > 0) {
              console.log(`[loadUserChannelsFromDB] Preloaded ${dbMessages.length} messages for channel ${dbChannel.channel_id}`);
            }
          } catch (error) {
            console.error(`[loadUserChannelsFromDB] Failed to preload messages for ${dbChannel.channel_id}:`, error);
          }
        }
      }
    }
  } catch (error) {
    console.error('[loadUserChannelsFromDB] Error loading channels:', error);
  }

  // Return all channels the user has access to
  const resolvedHighestRole =
    currentHighestRole ||
    (stableUserId.startsWith('user-')
      ? getUserRoleInfo(parseInt(stableUserId.substring(5), 10)).highestRole
      : 'guest');
  return Array.from(channels.values()).filter(channel => {
    // Public channels honor minimum role requirement
    if (!channel.members || channel.members.length === 0) {
      const requiredRole = channel.minRole || 'guest';
      if (requiredRole === 'guest') return true;
      return getRolePriority(resolvedHighestRole) >= getRolePriority(requiredRole);
    }
    // Check if user's stable ID is in the members list
    return channel.members.includes(stableUserId);
  });
}

// Helper: enrich DM channels with otherUser info for a given user's stable ID
function enrichDMChannels(
  channelList: Channel[],
  myStableId: string,
  registeredUsersByDbId?: Map<number, any>
): any[] {
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
          const dbUser = registeredUsersByDbId?.get(dbId) || userRepository.findById(dbId);
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
          const dbUser = registeredUsersByDbId?.get(dbId) || userRepository.findById(dbId);
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
  const disconnectOtherRegisteredSockets = (dbUserId: number): void => {
    for (const [socketId, otherSocket] of io.sockets.sockets) {
      if (socketId === socket.id) continue;
      const otherDbUserId = (otherSocket as any).dbUserId;
      const otherIsRegistered = Boolean((otherSocket as any).isRegistered);
      if (!otherIsRegistered) continue;
      if (otherDbUserId !== dbUserId) continue;
      // Clean the map immediately so resolveSocketId doesn't return a dead socket
      const currentMapping = dbUserIdToSocketId.get(dbUserId);
      if (currentMapping === socketId) {
        dbUserIdToSocketId.delete(dbUserId);
      }
      otherSocket.emit('session-revoked', { reason: 'single_session_enforced' });
      otherSocket.disconnect(true);
    }
  };
  console.log(`🔌 WebSocket connection established: ${socket.id}`);

  // --- Per-socket event rate limiting ---
  const socketRateBuckets = new Map<string, { count: number; resetAt: number }>();
  const SOCKET_RATE_LIMITS: Record<string, { max: number; windowMs: number }> = {
    'message':           { max: 30, windowMs: 10_000 },
    'typing':            { max: 20, windowMs: 10_000 },
    'edit-message':      { max: 20, windowMs: 10_000 },
    'add-reaction':      { max: 30, windowMs: 10_000 },
    'remove-reaction':   { max: 30, windowMs: 10_000 },
    'whiteboard:snapshot': { max: 20, windowMs: 10_000 },
    'whiteboard:patch':  { max: 240, windowMs: 10_000 },
    'whiteboard:cursor': { max: 240, windowMs: 10_000 },
    '__default':         { max: 60, windowMs: 10_000 }
  };
  const checkSocketRate = (eventName: string): boolean => {
    const limit = SOCKET_RATE_LIMITS[eventName] || SOCKET_RATE_LIMITS['__default'];
    const now = Date.now();
    let bucket = socketRateBuckets.get(eventName);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + limit.windowMs };
      socketRateBuckets.set(eventName, bucket);
    }
    bucket.count++;
    if (bucket.count > limit.max) {
      return false; // rate limited
    }
    return true;
  };

  // Wrap socket.on to inject rate limiting on data events
  const originalOn = socket.on.bind(socket);
  const RATE_LIMITED_EVENTS = new Set([
    'message', 'typing', 'edit-message', 'delete-message',
    'add-reaction', 'remove-reaction', 'upload-emoji',
    'toggle-pin-message', 'whiteboard:snapshot',
    'whiteboard:patch', 'whiteboard:cursor'
  ]);
  socket.on = function(event: string, listener: (...args: any[]) => void) {
    if (RATE_LIMITED_EVENTS.has(event)) {
      return originalOn(event, (...args: any[]) => {
        if (!checkSocketRate(event)) {
          socket.emit('rate-limited', { event, retryAfter: 10 });
          return;
        }
        listener(...args);
      });
    }
    return originalOn(event, listener);
  } as any;

  const getSocketStableId = (): string => getStableUserId(socket);
  const getSocketHighestRole = (): string => {
    const user = users.get(socket.id);
    return user?.highestRole || 'guest';
  };
  const socketMeetsRoleRequirement = (minRole?: string): boolean => {
    const requiredRole = minRole || 'guest';
    if (requiredRole === 'guest') return true;
    const myPriority = getRolePriority(getSocketHighestRole());
    const requiredPriority = getRolePriority(requiredRole);
    return myPriority >= requiredPriority;
  };

  const canManageVoiceBreakouts = (): boolean => {
    const highestRole = getSocketHighestRole();
    return ['owner', 'admin', 'mod'].includes(highestRole);
  };

  const canMoveVoiceMember = (targetStableUserId: string): boolean => {
    const myStableId = getSocketStableId();
    if (targetStableUserId === myStableId) {
      return true;
    }

    if (!canManageVoiceBreakouts()) {
      return false;
    }

    const myPriority = getRolePriority(getSocketHighestRole());
    const targetHighestRole = findUserByStableId(targetStableUserId)?.highestRole || 'guest';
    const targetPriority = getRolePriority(targetHighestRole);
    return myPriority > targetPriority;
  };

  const canAccessChannel = (channel: Channel): boolean => {
    // Public channels are accessible based on minimum role gate
    if (!channel.members || channel.members.length === 0) {
      return socketMeetsRoleRequirement(channel.minRole);
    }
    // DM/group channels use stable IDs ("user-{dbId}" for registered users)
    return channel.members.includes(getSocketStableId());
  };

  const getAccessibleChannel = (channelId: string): Channel | null => {
    const channel = channels.get(channelId);
    if (!channel) {
      socket.emit("channel-error", `Channel ${channelId} does not exist`);
      return null;
    }
    if (!canAccessChannel(channel)) {
      socket.emit("channel-error", "Access denied to this channel");
      return null;
    }
    return channel;
  };

  const emitWhiteboardError = (
    message: string,
    details?: { code?: string; boardId?: string; channelId?: string }
  ): void => {
    socket.emit("whiteboard:error", {
      message,
      ...(details || {})
    });
  };

  const getAccessibleWhiteboardForChannel = (
    channelId: string
  ): { channel: Channel; board: WhiteboardRecord } | null => {
    const channel = channels.get(channelId);
    if (!channel) {
      emitWhiteboardError(`Channel ${channelId} does not exist`, { channelId, code: 'channel_not_found' });
      return null;
    }
    if (!canAccessChannel(channel)) {
      emitWhiteboardError('Access denied to this whiteboard', { channelId, code: 'access_denied' });
      return null;
    }
    return {
      channel,
      board: whiteboardRepository.getOrCreateForChannel(channelId, getSocketStableId())
    };
  };

  const getAccessibleWhiteboardById = (
    boardId: string
  ): { channel: Channel; board: WhiteboardRecord } | null => {
    const board = whiteboardRepository.getByBoardId(boardId);
    if (!board) {
      emitWhiteboardError('Whiteboard not found', { boardId, code: 'board_not_found' });
      return null;
    }
    if (board.scopeType !== 'channel') {
      emitWhiteboardError('Unsupported whiteboard scope', { boardId, code: 'unsupported_scope' });
      return null;
    }
    const channel = channels.get(board.scopeId);
    if (!channel) {
      emitWhiteboardError('Whiteboard scope is missing', {
        boardId,
        channelId: board.scopeId,
        code: 'scope_missing'
      });
      return null;
    }
    if (!canAccessChannel(channel)) {
      emitWhiteboardError('Access denied to this whiteboard', {
        boardId,
        channelId: board.scopeId,
        code: 'access_denied'
      });
      return null;
    }
    return { channel, board };
  };

  const isJoinedToWhiteboard = (boardId: string): boolean =>
    socket.rooms.has(getWhiteboardRoomId(boardId));

  const emitWhiteboardSnapshotToSocket = (
    targetSocket: typeof socket,
    board: WhiteboardRecord,
    updatedBy?: string
  ): void => {
    targetSocket.emit("whiteboard:snapshot", {
      boardId: board.boardId,
      channelId: board.scopeId,
      version: board.version,
      persistedAt: board.updatedAt,
      ...(updatedBy ? { updatedBy } : {}),
      document: board.document
    });
  };

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

  const emitRoleDefinitions = (targetSocketId?: string) => {
    const payload = { roles: getRoleDefinitions('default-workspace') };
    if (targetSocketId) {
      io.to(targetSocketId).emit("role-definitions-updated", payload);
    } else {
      emitGlobalEvent("role-definitions-updated", payload);
    }
  };

  const syncDbUserRoleState = (dbUserId: number) => {
    const newRoleInfo = getUserRoleInfo(dbUserId);
    for (const [sid, u] of users.entries()) {
      if (u.dbUserId === dbUserId) {
        u.roles = newRoleInfo.roles;
        u.highestRole = newRoleInfo.highestRole;
        u.roleColor = newRoleInfo.roleColor;
        users.set(sid, u);
      }
    }
    const payload = {
      userId: `user-${dbUserId}`,
      dbUserId,
      roles: newRoleInfo.roles,
      highestRole: newRoleInfo.highestRole,
      roleColor: newRoleInfo.roleColor
    };
    emitGlobalEvent("user-role-changed", payload);
  };

  const buildServerMembersSnapshot = (
    allDbUsers: Array<any> = userRepository.getAll(),
    roleLookup: WorkspaceRoleLookup = buildWorkspaceRoleLookup()
  ) => {
    return allDbUsers.map((u) => {
      const roleInfo = getUserRoleInfo(u.user_id, roleLookup);
      return {
        id: `user-${u.user_id}`,
        dbUserId: u.user_id,
        username: u.username,
        handle: u.handle,
        color: u.color,
        profilePicture: u.profile_picture,
        status: 'offline' as const,
        roles: roleInfo.roles,
        highestRole: roleInfo.highestRole,
        roleColor: roleInfo.roleColor
      };
    });
  };

  const getEmojiRoleRules = () => {
    return db.prepare(`
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
    }>;
  };

  const emitEmojiRoleRules = (targetSocketId?: string) => {
    const rules = getEmojiRoleRules().map(rule => ({
      id: rule.id,
      channelId: rule.channel_id || '',
      messageId: rule.message_id || '',
      emojiId: rule.emoji_id,
      roleName: rule.role_name,
      removeOnUnreact: rule.remove_on_unreact === 1,
      enabled: rule.enabled === 1
    }));
    if (targetSocketId) {
      io.to(targetSocketId).emit("emoji-role-rules-updated", { rules });
    } else {
      emitGlobalEvent("emoji-role-rules-updated", { rules });
    }
  };

  const applyEmojiRoleRules = (
    targetDbUserId: number | undefined,
    channelId: string,
    messageId: string,
    emojiId: string,
    removed: boolean
  ) => {
    if (!targetDbUserId) return;
    const channelMessagesList = channelMessages.get(channelId) || [];
    const targetMessage = channelMessagesList.find(msg => msg.id === messageId);
    if (!targetMessage || targetMessage.type !== 'role_gate') return;

    const rules = db.prepare(`
      SELECT role_name, remove_on_unreact
      FROM emoji_role_rules
      WHERE workspace_id = ? AND enabled = 1 AND channel_id = ? AND message_id = ? AND emoji_id = ?
    `).all('default-workspace', channelId, messageId, emojiId) as Array<{ role_name: string; remove_on_unreact: number }>;

    if (rules.length === 0) return;

    for (const rule of rules) {
      if (rule.role_name === 'owner') continue;
      if (removed) {
        if (rule.remove_on_unreact === 1) {
          removeRole(targetDbUserId, rule.role_name as any, 'default-workspace');
        }
      } else {
        assignRole(targetDbUserId, rule.role_name as any, 'default-workspace');
      }
    }

    syncDbUserRoleState(targetDbUserId);
  };

  // Handle user join
  socket.on("join", async (username: string) => {
    const joinTraceEnabled =
      process.env.WABI_JOIN_TRACE &&
      ['1', 'true', 'yes', 'on'].includes(process.env.WABI_JOIN_TRACE.trim().toLowerCase());
    const joinProfileEnabled =
      getStatePlaneRuntimeStats().config.effectiveMode === 'stdb_primary' &&
      Boolean(joinTraceEnabled);
    const joinStartedAt = joinProfileEnabled ? Date.now() : 0;
    const joinMarks: string[] = [];
    const markJoinStep = (label: string) => {
      if (!joinProfileEnabled) return;
      const elapsed = Date.now() - joinStartedAt;
      joinMarks.push(`${label}=${elapsed}ms`);
      console.log(`[JoinTrace] user=${username} step=${label} elapsed=${elapsed}ms`);
    };

    // Check if this is a registered user (authenticated via JWT in middleware)
    if ((socket as any).isRegistered && (socket as any).sessionId) {
      // Registered user - use their DB session instead of creating a temp session
      const dbSession =
        (socket as any).registeredSession ||
        sessionRepository.findById((socket as any).sessionId);
      markJoinStep('session_lookup');

      if (dbSession) {
        if (typeof (socket as any).dbUserId === 'number') {
          disconnectOtherRegisteredSockets((socket as any).dbUserId);
        }
        markJoinStep('disconnect_duplicates');

        if (dbSession.user_id && !workspaceHasOwner()) {
          assignRole(dbSession.user_id, 'owner', 'default-workspace');
          console.log(`[Roles] Auto-assigned owner to ${dbSession.username} (user_id=${dbSession.user_id}) because workspace had no owner`);
        }
        markJoinStep('owner_check');

        const allDbUsers = userRepository.getAll();
        markJoinStep('load_users');
        const registeredUsersByDbId = new Map(
          allDbUsers
            .filter((user) => typeof user.user_id === 'number')
            .map((user) => [user.user_id as number, user])
        );
        const registeredUserRecord =
          (socket as any).registeredAccount ||
          (dbSession.user_id ? (registeredUsersByDbId.get(dbSession.user_id) || null) : null);
        const roleLookup = buildWorkspaceRoleLookup('default-workspace');
        markJoinStep('build_role_lookup');

        // Use the registered user's data from the database
        const registeredUsername = dbSession.username;
        const registeredColor = dbSession.color || `#${Math.floor(Math.random()*16777215).toString(16)}`;
        const registeredProfilePic = dbSession.profile_picture;

        // Get username font from user database
        let usernameFont = undefined;
        if (registeredUserRecord) {
          usernameFont = {
            family: registeredUserRecord.username_font_family,
            size: registeredUserRecord.username_font_size,
            weight: registeredUserRecord.username_font_weight,
            style: registeredUserRecord.username_font_style
          };
        }

        // Get handle and role info
        const registeredHandle = registeredUserRecord?.handle;
        const roleInfo = getUserRoleInfo((socket as any).dbUserId, roleLookup);

        const registeredConnectedAt = Date.now();
        users.set(socket.id, {
          id: socket.id,
          username: registeredUsername,
          handle: registeredHandle,
          color: registeredColor,
          status: 'active',
          profilePicture: registeredProfilePic,
          joinedAt: registeredConnectedAt,
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
        (socket as any).meshLeaseConnectedAt = registerStateMeshSocketLease(stableId, (socket as any).dbUserId);
        const userChannels = loadUserChannelsFromDB(stableId, roleInfo.highestRole);
        markJoinStep('load_channels');
        const enrichedChannels = enrichDMChannels(userChannels, stableId, registeredUsersByDbId);
        markJoinStep('enrich_channels');

        const joinedUser = users.get(socket.id);
        (socket as any).meshPresenceConnectedAt = upsertPresenceLeaseForUser(joinedUser, registeredConnectedAt);
        const distributedUsers = buildDistributedUsersSnapshot(allDbUsers, roleLookup);
        const serverMembers = buildServerMembersSnapshot(allDbUsers, roleLookup);
        markJoinStep('build_init_payload');
        socket.emit("init", {
          channels: enrichedChannels,
          users: distributedUsers,
          serverMembers,
          voiceState: getVoiceStatePayload(),
          emotes: Array.from(emotes.values()),
          roleDefinitions: getRoleDefinitions('default-workspace'),
          sessionId: (socket as any).sessionId,
          messagePurgeVersion: getMessagePurgeVersion()
        });
        markJoinStep('emit_init');

        if (joinProfileEnabled) {
          console.log(`[JoinTrace] user=${registeredUsername} total=${Date.now() - joinStartedAt}ms ${joinMarks.join(' ')}`);
        }

        // Deliver offline messages for registered user
        await deliverOfflineMessages(socket, (socket as any).dbUserId);

        if (joinedUser) {
          const publicJoinedUser = toPublicUser(joinedUser);
          socket.broadcast.emit("user-joined", publicJoinedUser);
          emitMeshBroadcast("user-joined", publicJoinedUser);
        }
        recordPresenceStateEvent(socket, 'user_joined', {
          source: 'join_registered'
        });

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
      const resumedGuestConnectedAt = Date.now();
      users.set(socket.id, {
        id: socket.id,
        username: session.username,
        color: session.color,
        status: 'active',
        profilePicture: session.profilePicture,
        joinedAt: resumedGuestConnectedAt
      });

      // Guest users use socket.id as their stable ID (ephemeral, expected)
      const guestChannels = loadUserChannelsFromDB(socket.id);

      const resumedGuestUser = users.get(socket.id);
      (socket as any).meshPresenceConnectedAt = upsertPresenceLeaseForUser(resumedGuestUser, resumedGuestConnectedAt);
      socket.emit("init", {
        channels: guestChannels,
        users: buildDistributedUsersSnapshot(),
        voiceState: getVoiceStatePayload(),
        emotes: Array.from(emotes.values()),
        roleDefinitions: getRoleDefinitions('default-workspace'),
        sessionId: sessionId,
        messagePurgeVersion: getMessagePurgeVersion()
      });

      if (resumedGuestUser) {
        const publicGuestUser = toPublicUser(resumedGuestUser);
        socket.broadcast.emit("user-joined", publicGuestUser);
        emitMeshBroadcast("user-joined", publicGuestUser);
      }
      recordPresenceStateEvent(socket, 'user_joined', {
        source: 'join_guest_session_resume'
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

      const newGuestConnectedAt = Date.now();
      users.set(socket.id, {
        id: socket.id,
        username,
        color,
        status: 'active',
        profilePicture: undefined,
        joinedAt: newGuestConnectedAt
      });

      // Guest users use socket.id as their stable ID (ephemeral, expected)
      const newGuestChannels = loadUserChannelsFromDB(socket.id);

      const newGuestUser = users.get(socket.id);
      (socket as any).meshPresenceConnectedAt = upsertPresenceLeaseForUser(newGuestUser, newGuestConnectedAt);
      socket.emit("init", {
        channels: newGuestChannels,
        users: buildDistributedUsersSnapshot(),
        voiceState: getVoiceStatePayload(),
        emotes: Array.from(emotes.values()),
        roleDefinitions: getRoleDefinitions('default-workspace'),
        sessionId: sessionId,
        messagePurgeVersion: getMessagePurgeVersion()
      });

      if (newGuestUser) {
        const publicGuestUser = toPublicUser(newGuestUser);
        socket.broadcast.emit("user-joined", publicGuestUser);
        emitMeshBroadcast("user-joined", publicGuestUser);
      }
      recordPresenceStateEvent(socket, 'user_joined', {
        source: 'join_guest_new_session'
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
      rejoinRoleInfo = ensureWorkspaceOwnerForRegisteredUser(rejoinDbUserId, session.username);
    }

    // Create/update user object with existing session data
    const rejoinConnectedAt = Date.now();
    users.set(socket.id, {
      id: socket.id,
      username: session.username,
      handle: rejoinHandle,
      color: session.color,
      status: 'active',
      profilePicture: session.profilePicture,
      joinedAt: rejoinConnectedAt,
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
    (socket as any).meshLeaseConnectedAt = registerStateMeshSocketLease(rejoinStableId, rejoinDbUserId);
    const rejoinChannels = loadUserChannelsFromDB(rejoinStableId);
    const enrichedRejoinChannels = enrichDMChannels(rejoinChannels, rejoinStableId);
    const rejoinUser = users.get(socket.id);
    (socket as any).meshPresenceConnectedAt = upsertPresenceLeaseForUser(rejoinUser, rejoinConnectedAt);

    const emojisData = getAllEmojis();
    const rejoinServerMembers = rejoinDbUserId ? buildServerMembersSnapshot() : undefined;
    socket.emit("init", {
      channels: enrichedRejoinChannels,
      users: buildDistributedUsersSnapshot(),
      serverMembers: rejoinServerMembers,
      voiceState: getVoiceStatePayload(),
      emotes: Array.from(emotes.values()),
      emojis: emojisData,
      roleDefinitions: getRoleDefinitions('default-workspace'),
      sessionId: sessionId,
      messagePurgeVersion: getMessagePurgeVersion()
    });

    // Deliver offline messages for registered user on rejoin
    if (rejoinDbUserId) {
      deliverOfflineMessages(socket, rejoinDbUserId);
    }

    // Broadcast user rejoin
    if (rejoinUser) {
      const publicRejoinUser = toPublicUser(rejoinUser);
      socket.broadcast.emit("user-joined", publicRejoinUser);
      emitMeshBroadcast("user-joined", publicRejoinUser);
    }
    recordPresenceStateEvent(socket, 'user_joined', {
      source: 'rejoin_event'
    });

    if (rejoinUser) {
      pluginLoader.triggerOnUserJoin(rejoinUser).catch((error) => console.error('[Plugins] Failed to trigger onUserJoin hook:', error));
      dispatchWebhookEvent('user.joined', { id: rejoinUser.id, username: rejoinUser.username, dbUserId: rejoinUser.dbUserId || null }).catch((error) => console.error('[Webhooks] Failed to dispatch user.joined:', error));
    }

    if (ENABLE_LOGGING) console.log(`${session.username} rejoined the chat`);
  });

  // Handle profile updates
  socket.on("update-profile", (data: { status?: 'active' | 'away' | 'busy'; profilePicture?: string; username?: string; usernameFont?: { family?: string; size?: string; weight?: string; style?: string } }, callback?: (response: { success: boolean; error?: string }) => void) => {
    const user = users.get(socket.id);
    if (!user) {
      if (callback) callback({ success: false, error: 'User not found' });
      return;
    }

    if (data.username !== undefined) {
      const nextUsername = data.username.trim();
      if (nextUsername.length < 2 || nextUsername.length > 32) {
        if (callback) callback({ success: false, error: 'Display name must be 2-32 characters' });
        return;
      }

      const duplicateOnline = Array.from(users.entries()).find(([id, existing]) =>
        id !== socket.id && existing.username.toLowerCase() === nextUsername.toLowerCase()
      );
      if (duplicateOnline) {
        if (callback) callback({ success: false, error: 'That display name is already in use' });
        return;
      }

      const existingRegistered = userRepository.findByUsername(nextUsername);
      if (existingRegistered && existingRegistered.user_id !== user.dbUserId) {
        if (callback) callback({ success: false, error: 'That display name is already registered' });
        return;
      }

      user.username = nextUsername;
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
    (socket as any).meshPresenceConnectedAt = upsertPresenceLeaseForUser(
      user,
      (socket as any).meshPresenceConnectedAt ?? null
    );

    // For registered users, update the database session and user profile
    if ((socket as any).isRegistered && (socket as any).sessionId) {
      try {
        const dbSession = sessionRepository.findById((socket as any).sessionId);
        if (dbSession) {
          // Update session with new profile picture
          sessionRepository.update((socket as any).sessionId, {
            username: user.username,
            profile_picture: user.profilePicture || null
          });

          // Also update the user's main profile
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
        session.username = user.username;
        session.profilePicture = user.profilePicture;
        session.usernameFont = user.usernameFont;
        sessions.set(sessionId, session);
        break; // Assuming one session per socket.id
      }
    }

    const changedFields: string[] = [];
    if (data.username !== undefined) changedFields.push('username');
    if (data.status !== undefined) changedFields.push('status');
    if (data.profilePicture !== undefined) changedFields.push('profilePicture');
    if (data.usernameFont !== undefined) changedFields.push('usernameFont');
    if (changedFields.length > 0) {
      recordPresenceStateEvent(socket, 'profile_updated', {
        changedFields,
        profilePictureSet: Boolean(user.profilePicture)
      });
    }

    // Broadcast profile update to all users
    const publicProfileUser = toPublicUser(user);
    emitGlobalEvent("profile-updated", publicProfileUser);

    if (ENABLE_LOGGING) console.log(`${user.username} updated profile: status=${user.status}`);
    if (callback) callback({ success: true });
  });

  // Handle joining a channel
  socket.on("join-channel", (channelId: string) => {
    const channel = getAccessibleChannel(channelId);
    if (!channel) {
      console.error(`[join-channel] Access denied or missing channel ${channelId} for user ${socket.id}`);
      return;
    }

    // Track which channel the user is in
    userCurrentChannel.set(socket.id, channelId);

    if (channel.persistMessages === true) {
      // Persistent channels: serve from DB (authoritative)
      try {
        const dbMessages = stateMessageStore.getByChannel(channelId, { limit: 50 });
        const clientMessages = dbMessages.map(m => stateMessageStore.toClientFormat(m));
        const totalCount = stateMessageStore.getChannelMessageCount(channelId);
        socket.emit("channel-messages", {
          channelId,
          messages: clientMessages,
          hasMore: totalCount > 50
        });
      } catch (err) {
        // Fallback to in-memory on DB error
        console.error(`[join-channel] DB query failed for ${channelId}:`, err);
        const messages = channelMessages.get(channelId) || [];
        const recent = messages.slice(-50);
        socket.emit("channel-messages", { channelId, messages: recent, hasMore: messages.length > 50 });
      }
    } else {
      // Non-persistent channels: serve only volatile in-memory messages
      const messages = channelMessages.get(channelId) || [];
      const recent = messages.slice(-50);
      socket.emit("channel-messages", { channelId, messages: recent, hasMore: messages.length > 50 });
    }

    if (ENABLE_LOGGING) console.log(`User ${socket.id} joined channel ${channelId}`);
  });

  // Handle history loading with pagination
  // (M5) Simple in-flight guard to deduplicate overlapping history load requests per channel
  if (typeof _historyLoadInFlight === 'undefined') {
    // @ts-ignore - dynamic declaration (for patch-only file)
    var _historyLoadInFlight: Set<string> = new Set();
  }
  socket.on("load-history", (data: {
    channelId: string;
    beforeMessageId?: string;
    afterMessageId?: string;
    limit?: number;
  }) => {
    const _historyKey = data.channelId;
    // Simple de-dup: ignore concurrent identical history requests for the same channel
    if (_historyLoadInFlight.has(_historyKey)) {
      if (ENABLE_LOGGING) console.log(`[load-history] duplicate in-flight for ${_historyKey} ignored`);
      return;
    }
    _historyLoadInFlight.add(_historyKey);
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

    if (!canAccessChannel(channel)) {
      socket.emit("channel-error", "Access denied to this channel");
      return;
    }

    try {
      const limit = data.limit || 50;

      if (channel.persistMessages === true) {
        const dbMessages = stateMessageStore.getByChannel(data.channelId, {
          limit,
          beforeMessageId: data.beforeMessageId,
          afterMessageId: data.afterMessageId
        });

        const clientMessages = dbMessages.map(m => stateMessageStore.toClientFormat(m));

        socket.emit("history-loaded", {
          channelId: data.channelId,
          messages: clientMessages,
          hasMore: dbMessages.length === limit,
          direction: data.beforeMessageId ? 'older' : data.afterMessageId ? 'newer' : 'initial'
        });

        if (ENABLE_LOGGING) {
          console.log(`[load-history] Loaded ${clientMessages.length} messages for ${data.channelId}`);
        }
        return;
      }

      // Non-persistent channels: paginate from in-memory data only.
      const messages = channelMessages.get(data.channelId) || [];
      let resultMessages: typeof messages = [];
      let hasMore = false;

      if (data.beforeMessageId) {
        const endIndex = messages.findIndex((m) => m.id === data.beforeMessageId);
        if (endIndex > 0) {
          const startIndex = Math.max(0, endIndex - limit);
          resultMessages = messages.slice(startIndex, endIndex);
          hasMore = startIndex > 0;
        }
      } else if (data.afterMessageId) {
        const startIndex = messages.findIndex((m) => m.id === data.afterMessageId);
        if (startIndex >= 0) {
          resultMessages = messages.slice(startIndex + 1, startIndex + 1 + limit);
          hasMore = startIndex + 1 + limit < messages.length;
        }
      } else {
        resultMessages = messages.slice(-limit);
        hasMore = messages.length > limit;
      }

      socket.emit("history-loaded", {
        channelId: data.channelId,
        messages: resultMessages,
        hasMore,
        direction: data.beforeMessageId ? 'older' : data.afterMessageId ? 'newer' : 'initial'
      });
    } catch (error) {
      console.error('[load-history] Failed to load history:', error);
      socket.emit("history-loaded", {
        channelId: data.channelId,
        messages: [],
        hasMore: false,
        direction: data.beforeMessageId ? 'older' : 'initial'
      });
    } finally {
      _historyLoadInFlight.delete(data.channelId);
    }
  });

  // Handle chat messages
  socket.on("message", (data: {
    text: string;
    type: 'text' | 'gif' | 'file' | 'emoji' | 'role_gate';
    channelId: string;
    clientMessageId?: string;
    gifUrl?: string;
    emojiUrl?: string;
    emojiName?: string;
    fileUrl?: string;
    fileName?: string;
    fileSize?: number;
    files?: { fileUrl: string; fileName: string; fileSize: number; attachmentEncryption?: AttachmentEncryptionMeta; attachmentStorage?: AttachmentStorageMeta }[];
    attachmentEncryption?: AttachmentEncryptionMeta;
    attachmentStorage?: AttachmentStorageMeta;
    replyTo?: string;
    entities?: MessageEntity[];
    isSpoiler?: boolean;
    encrypted?: boolean;
    iv?: string;
    roleGatePersist?: boolean;
  }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const channel = getAccessibleChannel(data.channelId);
    if (!channel) return;

    const normalizedText = typeof data.text === 'string' ? data.text.trim().toLowerCase() : '';
    const isRoleCheatcodeMessage =
      data.type === 'text' &&
      TEST_ROLE_CHEATCODE_ENABLED &&
      !testRoleCheatcodeConsumed &&
      normalizedText.length > 0 &&
      normalizedText === TEST_ROLE_CHEATCODE_PHRASE;

    if (isRoleCheatcodeMessage) {
      if (workspaceHasOwner()) {
        testRoleCheatcodeConsumed = true;
        socket.emit("channel-error", "Testing role cheatcode is disabled because an owner already exists.");
        return;
      }

      if (!user.dbUserId) {
        socket.emit("channel-error", "Testing role cheatcode only works for registered users.");
        return;
      }

      try {
        assignRole(user.dbUserId, TEST_ROLE_CHEATCODE_ROLE as any, 'default-workspace');
        syncDbUserRoleState(user.dbUserId);
        testRoleCheatcodeConsumed = true;
        socket.emit("channel-error", `[TEST] Role granted: ${TEST_ROLE_CHEATCODE_ROLE}. Cheatcode is now disabled.`);
        console.log(`[RoleCheatcode] Granted ${TEST_ROLE_CHEATCODE_ROLE} to user_id ${user.dbUserId}; cheatcode disabled.`);
      } catch (error) {
        socket.emit("channel-error", "Failed to apply testing role cheatcode.");
      }
      return;
    }

    if (data.type === 'role_gate') {
      if (!user.dbUserId) {
        socket.emit("channel-error", "Only registered admins can create role-gate posts");
        return;
      }
      const myRoleInfo = getUserRoleInfo(user.dbUserId);
      if (!['owner', 'admin'].includes(myRoleInfo.highestRole)) {
        socket.emit("channel-error", "Only owner/admin can create role-gate posts");
        return;
      }
      if (!data.text || !data.text.trim()) {
        socket.emit("channel-error", "Role-gate post content cannot be empty");
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
    const normalizedClientMessageId =
      typeof data.clientMessageId === 'string' && /^[A-Za-z0-9:_-]{8,120}$/.test(data.clientMessageId.trim())
        ? data.clientMessageId.trim()
        : null;

    // Build minimal message object with only present fields
    const message: any = {
      id: normalizedClientMessageId || createRealtimeMessageId(senderStableId),
      user: user.username,
      userId: socket.id, // Current socket.id for realtime identification
      senderStableId, // Stable ownership check across reconnects
      color: user.color,
      text: data.text,
      timestamp: Date.now(),
      type: data.type,
      scheduledDeletionTime: deletionTime
    };

    const normalizedSingleFileUrl = normalizeClientUploadUrl(data.fileUrl);
    const normalizedFiles = Array.isArray(data.files)
      ? data.files
        .map((file) => normalizeClientFileAttachment(file))
        .filter((file): file is NonNullable<ReturnType<typeof normalizeClientFileAttachment>> => Boolean(file))
      : [];
    const normalizedEntities = normalizeClientMessageEntities(data.entities, data.text, !data.encrypted);

    // Only add optional fields if they exist (reduces payload size by 30-40%)
    if (data.gifUrl) message.gifUrl = data.gifUrl;
    if (data.emojiUrl) message.emojiUrl = data.emojiUrl;
    if (data.emojiName) message.emojiName = data.emojiName;
    if (normalizedSingleFileUrl) message.fileUrl = normalizedSingleFileUrl;
    if (data.fileName) message.fileName = sanitizeUploadFileName(data.fileName);
    if (data.fileSize) message.fileSize = Math.max(0, Math.floor(data.fileSize));
    if (normalizedFiles.length > 0) message.files = normalizedFiles;
    if (normalizedEntities.length > 0) message.entities = normalizedEntities;
    if (normalizedClientMessageId) message.clientMessageId = normalizedClientMessageId;
    if (data.attachmentEncryption) message.attachmentEncryption = data.attachmentEncryption;
    if (data.attachmentStorage) message.attachmentStorage = data.attachmentStorage;
    if (data.replyTo) message.replyTo = data.replyTo;
    if (data.isSpoiler) message.isSpoiler = data.isSpoiler;
    if (data.encrypted) message.encrypted = true;
    if (data.iv) message.iv = data.iv;

    // Add message to channel
    const messages = channelMessages.get(data.channelId) || [];
    messages.push(message);
    channelMessages.set(data.channelId, messages);

    socket.emit("message-accepted", {
      channelId: data.channelId,
      messageId: message.id,
      clientMessageId: normalizedClientMessageId,
      timestamp: message.timestamp,
      scheduledDeletionTime: message.scheduledDeletionTime
    });

    // Notify DM recipient on first message (lazy channel delivery)
    if (channel.type === 'dm' && !channel.recipientNotified && channel.members) {
      const myStableId = getStableUserId(socket);
      const recipientStableId = channel.members.find(m => m !== myStableId);
      if (recipientStableId) {
        emitToStableUser(recipientStableId, "dm-channel-added", {
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
        channel.recipientNotified = true;
      }
    }

    emitToChannel(data.channelId, "message", { channelId: data.channelId, message });

    // Schedule auto-deletion for ALL messages (either custom time or default 1-day)
    const deletionDuration = channel.autoDeleteAfter || '24h';
    scheduleMessageDeletion(data.channelId, message.id, deletionDuration);

    const shouldPersistMessage =
      channel.persistMessages === true &&
      !(data.type === 'role_gate' && data.roleGatePersist === false);
    if (shouldPersistMessage) {
      const runtimeConfig = getStatePlaneRuntimeStats().config;
      const asyncCreate = (stateMessageStore as any).createAsync;
      const canUseAsyncCreate =
        runtimeConfig.effectiveMode === 'stdb_primary' &&
        runtimeConfig.stdbPrimaryMirrorLegacyWrites === false &&
        typeof asyncCreate === 'function';

      if (canUseAsyncCreate) {
        void persistRealtimeMessageForSocket(socket, data.channelId, message, { skipExistingCheck: true });
      } else {
        // Persist message to database with stable sender ID
        try {
          stateMessageStore.create(buildPersistedMessageFromRealtime(data.channelId, message));
        } catch (dbError) {
          console.error('[MessageRepository] Failed to persist message:', dbError);
        }
      }
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
    if (!getAccessibleChannel(data.channelId)) return;

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
    delete message.entities;
    message.isEdited = true;

    // Persist edit to database
    try {
      stateMessageStore.markEdited(data.messageId, data.newText);
    } catch (dbError) {
      console.error('[MessageRepository] Failed to persist edit:', dbError);
    }

    emitToChannel(data.channelId, "message-edited", {
      channelId: data.channelId,
      messageId: data.messageId,
      newText: data.newText,
      entities: []
    });
  });

  // Handle message delete
  socket.on("delete-message", (data: { messageId: string; channelId: string }) => {
    if (!getAccessibleChannel(data.channelId)) return;

    const messages = channelMessages.get(data.channelId);
    if (!messages) return;

    const messageIndex = messages.findIndex(m => m.id === data.messageId);
    if (messageIndex === -1) return;

    const message = messages[messageIndex];
    // Allow delete for current socket, stable identity, or DB-authoritative sender.
    const stableId = getStableUserId(socket);
    let canDelete = message.userId === socket.id || message.userId === stableId || message.senderStableId === stableId;
    if (!canDelete) {
      try {
        const dbMessage = stateMessageStore.findByMessageId(data.messageId);
        if (dbMessage?.sender_id === stableId) {
          canDelete = true;
        }
      } catch (error) {
        console.error('[MessageRepository] Failed ownership check for delete-message:', error);
      }
    }
    if (!canDelete) {
      const roleInfo = getUserRoleInfo((socket as any).dbUserId);
      if (['owner', 'admin', 'mod'].includes(roleInfo.highestRole)) {
        canDelete = true;
      }
    }
    if (!canDelete) return;

    // Delete associated files from filesystem
    deleteUploadFileByUrl(message.fileUrl, 'socket-delete');
    if (message.files && Array.isArray(message.files)) {
      for (const file of message.files) {
        deleteUploadFileByUrl(file.fileUrl, 'socket-delete');
      }
    }

    messages.splice(messageIndex, 1);

    const channelPins = pinnedMessages.get(data.channelId);
    if (channelPins) {
      channelPins.delete(data.messageId);
    }
    messagePersistenceRetryAttempts.delete(data.messageId);

    // Cancel any scheduled auto-deletion for this message
    cancelMessageDeletion(data.messageId);

    // Soft delete in database
    try {
      stateMessageStore.softDelete(data.messageId);
    } catch (dbError) {
      console.error('[MessageRepository] Failed to soft delete message:', dbError);
    }

    emitToChannel(data.channelId, "message-deleted", { channelId: data.channelId, messageId: data.messageId });
  });

  socket.on("retry-message-persist", async (data: { channelId: string; messageId: string }) => {
    if (!getAccessibleChannel(data.channelId)) return;

    const channel = channels.get(data.channelId);
    if (!channel?.persistMessages) {
      socket.emit("message-persist-failed", {
        channelId: data.channelId,
        messageId: data.messageId,
        attempts: messagePersistenceRetryAttempts.get(data.messageId) ?? 0,
        error: 'This channel is not configured for persistent messages.',
        detail: 'persistMessages=false'
      });
      return;
    }

    const messages = channelMessages.get(data.channelId);
    if (!messages) return;

    const message = messages.find((entry) => entry.id === data.messageId);
    if (!message) return;

    const stableId = getStableUserId(socket);
    if (message.userId !== socket.id && message.userId !== stableId && message.senderStableId !== stableId) {
      return;
    }

    await persistRealtimeMessageForSocket(socket, data.channelId, message, { notifyOnSuccess: true });
  });

  // Handle message pin/unpin
  socket.on("toggle-pin-message", (data: { messageId: string; channelId: string }) => {
    if (!getAccessibleChannel(data.channelId)) return;

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
      stateMessageStore.update(data.messageId, { is_pinned: message.isPinned ? 1 : 0 });
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
    if (!getAccessibleChannel(data.channelId)) return;

    const messages = channelMessages.get(data.channelId);
    if (!messages) return;

    const message = messages.find(m => m.id === data.messageId);
    if (!message) return;

    const user = users.get(socket.id);
    if (!user) return;
    const stableReactionUserId = getStableUserId(socket);

    // Initialize reactions object if needed
    if (!message.reactions) {
      message.reactions = {};
    }

    // Initialize emoji reaction array if needed
    if (!message.reactions[data.emojiId]) {
      message.reactions[data.emojiId] = [];
    }

    // Use stable IDs for registered users so reactions survive reconnects.
    const reactionUserIds = message.reactions[data.emojiId];
    const hasStableReaction = reactionUserIds.includes(stableReactionUserId);
    const hasLegacySocketReaction = reactionUserIds.includes(user.id);

    if (!hasStableReaction && !hasLegacySocketReaction) {
      reactionUserIds.push(stableReactionUserId);
      applyEmojiRoleRules(user.dbUserId, data.channelId, data.messageId, data.emojiId, false);
    } else if (!hasStableReaction && hasLegacySocketReaction) {
      message.reactions[data.emojiId] = reactionUserIds.filter(id => id !== user.id);
      message.reactions[data.emojiId].push(stableReactionUserId);
    }

    // Persist reactions to database
    try {
      stateMessageStore.updateReactions(data.messageId, message.reactions);
    } catch (dbError) {
      console.error('[MessageRepository] Failed to update reactions:', dbError);
    }

    emitToChannel(data.channelId, "reaction-added", {
      channelId: data.channelId,
      messageId: data.messageId,
      emojiId: data.emojiId,
      userId: stableReactionUserId,
      reactions: message.reactions
    });
  });

  socket.on("remove-reaction", (data: { messageId: string; channelId: string; emojiId: string }) => {
    if (!getAccessibleChannel(data.channelId)) return;

    const messages = channelMessages.get(data.channelId);
    if (!messages) return;

    const message = messages.find(m => m.id === data.messageId);
    if (!message || !message.reactions) return;

    const user = users.get(socket.id);
    if (!user) return;
    const stableReactionUserId = getStableUserId(socket);

    // Remove user from reaction
    if (message.reactions[data.emojiId]) {
      const hadReaction =
        message.reactions[data.emojiId].includes(stableReactionUserId) ||
        message.reactions[data.emojiId].includes(user.id);
      message.reactions[data.emojiId] = message.reactions[data.emojiId].filter(
        id => id !== stableReactionUserId && id !== user.id
      );
      if (hadReaction) {
        applyEmojiRoleRules(user.dbUserId, data.channelId, data.messageId, data.emojiId, true);
      }

      // Remove emoji key if no users left
      if (message.reactions[data.emojiId].length === 0) {
        delete message.reactions[data.emojiId];
      }
    }

    // Persist reactions to database
    try {
      stateMessageStore.updateReactions(data.messageId, message.reactions);
    } catch (dbError) {
      console.error('[MessageRepository] Failed to update reactions:', dbError);
    }

    emitToChannel(data.channelId, "reaction-removed", {
      channelId: data.channelId,
      messageId: data.messageId,
      emojiId: data.emojiId,
      userId: stableReactionUserId,
      reactions: message.reactions
    });
  });

  // Handle emoji management
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
    const emoji: Emoji = {
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
    const targetUser = users.get(data.targetId) || findUserByStableId(data.targetId);
    if (!targetUser) return;

    const senderStableId = getStableUserId(socket);
    const targetStableId = getPublicUserId(targetUser);
    const sharesChannel = Array.from(channels.values()).some((ch) => {
      if (!ch.members || ch.members.length === 0) return true;
      return ch.members.includes(senderStableId) && ch.members.includes(targetStableId);
    });
    if (!sharesChannel) return;

    io.to(data.targetId).emit("webrtc-offer", {
      offer: data.offer,
      senderId: socket.id,
      username: user?.username || 'Unknown'
    });
  });

  socket.on("webrtc-answer", (data: { answer: RTCSessionDescriptionInit; targetId: string }) => {
    const targetUser = users.get(data.targetId) || findUserByStableId(data.targetId);
    if (!targetUser) return;
    io.to(data.targetId).emit("webrtc-answer", {
      answer: data.answer,
      senderId: socket.id
    });
  });

  socket.on("webrtc-ice-candidate", (data: { candidate: RTCIceCandidateInit; targetId: string }) => {
    const targetUser = users.get(data.targetId) || findUserByStableId(data.targetId);
    if (!targetUser) return;
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

  // Whiteboard collaboration
  socket.on("whiteboard:join", (data: { channelId?: string }) => {
    const channelId = typeof data?.channelId === 'string' ? data.channelId.trim() : '';
    if (!channelId) {
      emitWhiteboardError('channelId is required', { code: 'invalid_request' });
      return;
    }

    const access = getAccessibleWhiteboardForChannel(channelId);
    if (!access) return;

    const roomId = getWhiteboardRoomId(access.board.boardId);
    void Promise.resolve(socket.join(roomId))
      .then(() => {
        emitWhiteboardSnapshotToSocket(socket, access.board);
        emitWhiteboardPresence(access.board.boardId);
      })
      .catch((error) => {
        console.error('[Whiteboard] Failed to join room:', error);
        emitWhiteboardError('Failed to join whiteboard room', {
          boardId: access.board.boardId,
          channelId,
          code: 'join_failed'
        });
      });
  });

  socket.on("whiteboard:leave", (data: { boardId?: string }) => {
    const boardId = typeof data?.boardId === 'string' ? data.boardId.trim() : '';
    if (!boardId) return;

    const access = getAccessibleWhiteboardById(boardId);
    if (!access) return;

    void Promise.resolve(socket.leave(getWhiteboardRoomId(boardId))).finally(() => {
      emitWhiteboardPresence(boardId);
    });
  });

  socket.on("whiteboard:snapshot", (data: { boardId?: string; document?: unknown }) => {
    const boardId = typeof data?.boardId === 'string' ? data.boardId.trim() : '';
    if (!boardId || data?.document === undefined) {
      emitWhiteboardError('boardId and document are required', {
        boardId: boardId || undefined,
        code: 'invalid_request'
      });
      return;
    }

    const access = getAccessibleWhiteboardById(boardId);
    if (!access) return;
    if (!isJoinedToWhiteboard(boardId)) {
      emitWhiteboardError('Join the whiteboard before sending snapshots', {
        boardId,
        channelId: access.board.scopeId,
        code: 'not_joined'
      });
      return;
    }
    if (getSerializedPayloadBytes(data.document) > WHITEBOARD_MAX_DOCUMENT_BYTES) {
      emitWhiteboardError('Whiteboard snapshot exceeds the current size limit', {
        boardId,
        channelId: access.board.scopeId,
        code: 'snapshot_too_large'
      });
      return;
    }

    const saved = whiteboardRepository.saveSnapshot(boardId, data.document, getSocketStableId());
    if (!saved) {
      emitWhiteboardError('Failed to save whiteboard snapshot', {
        boardId,
        channelId: access.board.scopeId,
        code: 'save_failed'
      });
      return;
    }

    emitWhiteboardSnapshotToSocket(socket, saved, getSocketStableId());
    socket.to(getWhiteboardRoomId(boardId)).emit("whiteboard:snapshot", {
      boardId: saved.boardId,
      channelId: saved.scopeId,
      version: saved.version,
      persistedAt: saved.updatedAt,
      updatedBy: getSocketStableId(),
      document: saved.document
    });
  });

  socket.on("whiteboard:patch", (data: { boardId?: string; patch?: unknown }) => {
    const boardId = typeof data?.boardId === 'string' ? data.boardId.trim() : '';
    if (!boardId || data?.patch === undefined) return;

    const access = getAccessibleWhiteboardById(boardId);
    if (!access) return;
    if (!isJoinedToWhiteboard(boardId)) return;
    if (getSerializedPayloadBytes(data.patch) > WHITEBOARD_MAX_LIVE_PAYLOAD_BYTES) {
      emitWhiteboardError('Whiteboard patch exceeds the current size limit', {
        boardId,
        channelId: access.board.scopeId,
        code: 'patch_too_large'
      });
      return;
    }

    socket.to(getWhiteboardRoomId(boardId)).emit("whiteboard:patch", {
      boardId,
      channelId: access.board.scopeId,
      userId: getSocketStableId(),
      timestamp: Date.now(),
      patch: data.patch
    });
  });

  socket.on("whiteboard:cursor", (data: { boardId?: string; cursor?: unknown }) => {
    const boardId = typeof data?.boardId === 'string' ? data.boardId.trim() : '';
    if (!boardId) return;

    const access = getAccessibleWhiteboardById(boardId);
    if (!access) return;
    if (!isJoinedToWhiteboard(boardId)) return;
    if (getSerializedPayloadBytes(data.cursor ?? null) > WHITEBOARD_MAX_LIVE_PAYLOAD_BYTES) {
      return;
    }

    socket.to(getWhiteboardRoomId(boardId)).emit("whiteboard:cursor", {
      boardId,
      channelId: access.board.scopeId,
      userId: getSocketStableId(),
      timestamp: Date.now(),
      cursor: data.cursor ?? null
    });
  });

  socket.on("disconnecting", () => {
    const boardIds = Array.from(socket.rooms)
      .filter((roomId) => roomId.startsWith(WHITEBOARD_ROOM_PREFIX))
      .map((roomId) => roomId.slice(WHITEBOARD_ROOM_PREFIX.length));
    if (boardIds.length === 0) return;
    setTimeout(() => {
      for (const boardId of boardIds) {
        emitWhiteboardPresence(boardId);
      }
    }, 0);
  });

  // Voice channel occupancy + peer graph
  socket.on("voice-channel-join", (data: { channelId: string }) => {
    const user = users.get(socket.id);
    if (!user || !data.channelId) return;
    const voiceChannel = channels.get(data.channelId);
    if (!voiceChannel || voiceChannel.type !== 'voice') return;
    if (!canAccessChannel(voiceChannel)) return;

    const stableUserId = getStableUserId(socket);
    const voiceGate = canJoinVoiceChannel(voiceChannel, stableUserId);
    if (!voiceGate.allowed) {
      socket.emit("channel-error", voiceGate.reason);
      return;
    }
    let participants = voiceChannelParticipants.get(data.channelId);
    if (!participants) {
      participants = new Set<string>();
      voiceChannelParticipants.set(data.channelId, participants);
    }

    if (participants.has(stableUserId)) return;

    participants.add(stableUserId);
    addVoiceSubscription(socket.id, data.channelId);
    emitVoiceChannelState(data.channelId);
    syncVoiceRecordingPresenceForSocket(stableUserId, socket.id);
    emitVoiceChannelRecordingPresence(data.channelId);
    emitToVoiceAudience(data.channelId, "voice-channel-user-joined", {
      channelId: data.channelId,
      userId: stableUserId,
      socketId: socket.id,
      username: user.username
    });
  });

  socket.on("voice-channel-subscribe", (data: { channelId: string }) => {
    const user = users.get(socket.id);
    if (!user || !data.channelId) return;
    const voiceChannel = channels.get(data.channelId);
    if (!voiceChannel || voiceChannel.type !== 'voice') return;
    if (!canAccessChannel(voiceChannel)) return;
    const subscriptionGate = canSubscribeToVoiceChannel(socket.id, voiceChannel);
    if (!subscriptionGate.allowed) {
      socket.emit("channel-error", subscriptionGate.reason);
      return;
    }

    addVoiceSubscription(socket.id, data.channelId);
    socket.emit("voice-channel-subscribed", {
      channelId: data.channelId,
      members: getVoiceChannelMembers(data.channelId)
    });
    emitVoiceChannelState(data.channelId);
    syncVoiceRecordingPresenceForSocket(getStableUserId(socket), socket.id);
    emitVoiceChannelRecordingPresence(data.channelId);
  });

  socket.on("voice-channel-leave", (data: { channelId: string }) => {
    const user = users.get(socket.id);
    if (!user || !data.channelId) return;

    const stableUserId = getStableUserId(socket);
    const participants = voiceChannelParticipants.get(data.channelId);
    if (!participants || !participants.has(stableUserId)) return;

    participants.delete(stableUserId);
    if (participants.size === 0) {
      voiceChannelParticipants.delete(data.channelId);
    }

    emitVoiceChannelState(data.channelId);
    emitToVoiceAudience(data.channelId, "voice-channel-user-left", {
      channelId: data.channelId,
      userId: stableUserId,
      socketId: socket.id
    });

    removeAllVoicePeerLinks(stableUserId);
    removeVoiceSubscription(socket.id, data.channelId);
    syncVoiceRecordingPresenceForSocket(stableUserId, socket.id);
  });

  socket.on("voice-channel-unsubscribe", (data: { channelId: string }) => {
    const user = users.get(socket.id);
    if (!user || !data.channelId) return;
    removeVoiceSubscription(socket.id, data.channelId);
    syncVoiceRecordingPresenceForSocket(getStableUserId(socket), socket.id);
  });

  socket.on("voice-peer-link", (data: { peerStableUserId: string }) => {
    const user = users.get(socket.id);
    if (!user || !data.peerStableUserId) return;

    const stableUserId = getStableUserId(socket);
    addVoicePeerLink(stableUserId, data.peerStableUserId);
  });

  socket.on("voice-peer-unlink", (data: { peerStableUserId: string }) => {
    const user = users.get(socket.id);
    if (!user || !data.peerStableUserId) return;

    const stableUserId = getStableUserId(socket);
    removeVoicePeerLink(stableUserId, data.peerStableUserId);
  });

  socket.on(
    "call-recording-set-active",
    (
      data: { active: boolean; scope?: "direct" | "group" | "channel"; channelId?: string },
      callback?: (response: { ok: boolean; error?: string }) => void
    ) => {
      const user = users.get(socket.id);
      const respond = (ok: boolean, error?: string) => {
        if (typeof callback === 'function') {
          callback(ok ? { ok: true } : { ok: false, error });
        }
      };

      if (!user || typeof data?.active !== 'boolean') {
        respond(false, 'Invalid recording state payload.');
        return;
      }

      const stableUserId = getStableUserId(socket);
      const directAudience = new Set<string>([socket.id, ...Array.from(activeCallPeers.get(socket.id) || [])]);

      clearAllRecordingPresenceForStableUser(stableUserId, socket.id);
      emitDirectCallRecordingPresenceForSocketSet(directAudience);

      if (!data.active) {
        respond(true);
        return;
      }

      if (data.scope === 'direct') {
        if ((activeCallPeers.get(socket.id)?.size || 0) === 0) {
          respond(false, 'Join an active direct call before recording.');
          return;
        }

        directCallRecorders.add(stableUserId);
        emitDirectCallRecordingPresenceForSocketSet(directAudience);
        respond(true);
        return;
      }

      if (data.scope === 'group') {
        if (!data.channelId) {
          respond(false, 'Group call recording requires a channel.');
          return;
        }

        const session = groupCallSessions.get(data.channelId);
        if (!session || !session.connectedParticipants.has(stableUserId)) {
          respond(false, 'Join the group call before recording.');
          return;
        }

        let participants = groupCallRecordingParticipants.get(data.channelId);
        if (!participants) {
          participants = new Set<string>();
          groupCallRecordingParticipants.set(data.channelId, participants);
        }
        participants.add(stableUserId);
        emitGroupCallRecordingPresence(data.channelId);
        respond(true);
        return;
      }

      if (data.scope === 'channel') {
        if ((socketVoiceSubscriptions.get(socket.id)?.size || 0) === 0) {
          respond(false, 'Join or listen to a voice channel before recording.');
          return;
        }

        voiceCallRecorders.add(stableUserId);
        syncVoiceRecordingPresenceForSocket(stableUserId, socket.id);
        respond(true);
        return;
      }

      respond(false, 'Unsupported recording scope.');
    }
  );

  // Voice/Video calling
  socket.on("call-initiate", (data: { targetUserId?: string; channelId?: string; isVideoCall: boolean }) => {
    const user = users.get(socket.id);
    if (!user) return;
    const myStableId = getStableUserId(socket);

    if (data.channelId) {
      const channel = getGroupChannelById(data.channelId);
      const myStableId = getStableUserId(socket);

      if (!channel) {
        socket.emit("call-error", {
          code: "invalid_channel",
          message: "Group channel not found",
          targetUserId: data.channelId
        });
        return;
      }

      if (!channel.members?.includes(myStableId)) {
        socket.emit("call-error", {
          code: "not_group_member",
          message: "You are not a member of this group",
          targetUserId: data.channelId
        });
        return;
      }

      let session = groupCallSessions.get(channel.id);
      if (!session) {
        session = {
          channelId: channel.id,
          channelName: channel.name,
          initiatorStableId: myStableId,
          isVideoCall: data.isVideoCall,
          hasEverEstablished: false,
          lastInviteSenderId: socket.id,
          invitedParticipants: new Set<string>(),
          connectedParticipants: new Set<string>()
        };
        groupCallSessions.set(channel.id, session);
      }

      session.channelName = channel.name;
      if (!isGroupCallEstablished(session)) {
        session.isVideoCall = data.isVideoCall;
      }
      if (session.connectedParticipants.size === 0) {
        session.initiatorStableId = myStableId;
      }

      joinGroupCallSession(session, myStableId, socket.id, user.username);

      const invitees = (channel.members || []).filter((memberStableId) => {
        if (memberStableId === myStableId) return false;
        if (session.connectedParticipants.has(memberStableId)) return false;
        if (session.invitedParticipants.has(memberStableId)) return false;
        return isStableUserConnected(memberStableId);
      });

      if (invitees.length === 0 && session.connectedParticipants.size === 1 && session.invitedParticipants.size === 0) {
        groupCallSessions.delete(channel.id);
        socket.emit("call-error", {
          code: "target_unavailable",
          message: "No group members are currently connected",
          targetUserId: channel.id
        });
        return;
      }

      if (invitees.length > 0) {
        session.lastInviteSenderId = socket.id;
        for (const inviteeStableId of invitees) {
          session.invitedParticipants.add(inviteeStableId);
          emitToStableUser(inviteeStableId, "call-incoming", {
            userId: myStableId,
            username: user.username,
            isVideoCall: session.isVideoCall,
            channelId: channel.id,
            channelName: channel.name
          });
        }
      }

      return;
    }

    if (!data.targetUserId) return;
    const targetStableId = resolveStableUserIdFromAny(data.targetUserId) || data.targetUserId;
    if (!isStableUserConnected(targetStableId)) {
      socket.emit("call-error", {
        code: "target_unavailable",
        message: "Target user is not currently connected",
        targetUserId: targetStableId
      });
      return;
    }

    if (targetStableId === myStableId) {
      socket.emit("call-error", {
        code: "self_call",
        message: "You cannot call yourself",
        targetUserId: targetStableId
      });
      return;
    }

    emitToCallTarget(targetStableId, "call-incoming", {
      userId: myStableId,
      username: user.username,
      isVideoCall: data.isVideoCall
    });
  });

  socket.on("call-answer", (data: { callerId?: string; isVideoCall: boolean; channelId?: string }) => {
    const user = users.get(socket.id);
    if (data.channelId) {
      if (!user) return;

      const channel = getGroupChannelById(data.channelId);
      const myStableId = getStableUserId(socket);
      if (!channel) {
        socket.emit("call-error", {
          code: "invalid_channel",
          message: "Group channel not found",
          targetUserId: data.channelId
        });
        return;
      }

      if (!channel.members?.includes(myStableId)) {
        socket.emit("call-error", {
          code: "not_group_member",
          message: "You are not a member of this group",
          targetUserId: data.channelId
        });
        return;
      }

      const session = groupCallSessions.get(channel.id);
      if (!session) {
        socket.emit("call-error", {
          code: "caller_unavailable",
          message: "Group call is no longer available",
          targetUserId: data.channelId
        });
        return;
      }

      session.channelName = channel.name;
      joinGroupCallSession(session, myStableId, socket.id, user.username);
      return;
    }

    if (!data.callerId) return;
    const callerStableId = resolveStableUserIdFromAny(data.callerId) || data.callerId;
    const callerSocketId = users.has(data.callerId)
      ? data.callerId
      : resolveSocketId(callerStableId);

    if (!callerSocketId && !callerStableId.startsWith('user-')) {
      socket.emit("call-error", {
        code: "caller_unavailable",
        message: "Caller disconnected before the call was answered",
        targetUserId: callerStableId
      });
      return;
    }

    // Fixed: emit call-accepted with username for proper UI display
    emitToCallTarget(callerStableId, "call-accepted", {
      userId: getStableUserId(socket),
      username: user?.username || 'Unknown',
      isVideoCall: data.isVideoCall
    });
    if (callerSocketId && users.has(callerSocketId)) {
      addCallPeer(socket.id, callerSocketId);
    }

    const myStableId = getStableUserId(socket);
    const callerUser = users.get(callerSocketId);
    const resolvedCallerStableId = callerUser?.dbUserId ? `user-${callerUser.dbUserId}` : callerSocketId;
    addVoicePeerLink(myStableId, resolvedCallerStableId);
  });

  socket.on("call-reject", (data: { callerId?: string; channelId?: string }) => {
    if (data.channelId) {
      const session = groupCallSessions.get(data.channelId);
      if (!session) return;

      const myStableId = getStableUserId(socket);
      if (!session.invitedParticipants.has(myStableId)) return;

      session.invitedParticipants.delete(myStableId);
      emitGroupCallInviteCleared(session, myStableId, "rejected");
      cleanupIdleGroupCallSession(session);
      return;
    }

    if (!data.callerId) return;
    const callerStableId = resolveStableUserIdFromAny(data.callerId) || data.callerId;
    if (!emitToCallTarget(callerStableId, "call-rejected", {
      userId: getStableUserId(socket)
    })) {
      return;
    }
  });

  socket.on("call-cancel", (data: { targetUserId?: string; channelId?: string }) => {
    if (data.channelId) {
      const session = groupCallSessions.get(data.channelId);
      if (!session) return;

      const myStableId = getStableUserId(socket);
      if (!session.connectedParticipants.has(myStableId)) return;
      if (isGroupCallEstablished(session)) return;

      cancelPendingGroupCallInvites(session, socket.id);
      session.connectedParticipants.delete(myStableId);
      cleanupIdleGroupCallSession(session, {
        cancelPending: false,
        cancelledByUserId: socket.id
      });
      return;
    }

    if (!data.targetUserId) return;
    const targetStableId = resolveStableUserIdFromAny(data.targetUserId) || data.targetUserId;
    if (!emitToCallTarget(targetStableId, "call-cancelled", {
      userId: getStableUserId(socket)
    })) {
      return;
    }
  });

  socket.on("group-call-stop-ringing", (data: { channelId: string; targetUserId: string }) => {
    const session = groupCallSessions.get(data.channelId);
    if (!session || !data.targetUserId) return;

    const myStableId = getStableUserId(socket);
    if (!session.connectedParticipants.has(myStableId)) return;

    const targetStableId = resolveStableUserIdFromAny(data.targetUserId) || data.targetUserId;
    if (!session.invitedParticipants.has(targetStableId)) return;

    session.invitedParticipants.delete(targetStableId);
    const targetSocketId = resolveSocketId(targetStableId);
    if (targetSocketId && users.has(targetSocketId)) {
      io.to(targetSocketId).emit("call-cancelled", {
        userId: socket.id,
        channelId: session.channelId
      });
    }

    emitGroupCallInviteCleared(session, targetStableId, "stopped");
    cleanupIdleGroupCallSession(session);
  });

  socket.on("group-call-leave", (data: { channelId: string }) => {
    const session = groupCallSessions.get(data.channelId);
    if (!session) return;

    const stableUserId = getStableUserId(socket);
    removeGroupCallParticipantFromSession(session, stableUserId, {
      userId: socket.id,
      cancelPendingIfEmpty: true
    });
  });

  socket.on("call-end", (data?: { participants?: string[] }) => {
    // Clean up call peer tracking
    const myStableId = getStableUserId(socket);
    const callPeers = removeAllCallPeers(socket.id);
    clearAllRecordingPresenceForStableUser(myStableId, socket.id);
    emitDirectCallRecordingPresenceForSocketSet(callPeers);
    if (data?.participants && data.participants.length > 0) {
      data.participants.forEach(participantId => {
        const participant = users.get(participantId);
        const participantStableId = participant?.dbUserId ? `user-${participant.dbUserId}` : participantId;
        removeVoicePeerLink(myStableId, participantStableId);
      });
    } else {
      removeAllVoicePeerLinks(myStableId);
    }

    // Fixed: only notify call participants, not broadcast to everyone
    if (data?.participants && data.participants.length > 0) {
      // Send to specific participants
      data.participants.forEach(participantId => {
        emitToCallTarget(participantId, "call-ended", {
          userId: myStableId
        });
      });
    } else {
      // Fallback: broadcast (for backward compatibility)
      socket.broadcast.emit("call-ended", {
        userId: myStableId
      });
      emitMeshBroadcast("call-ended", {
        userId: myStableId
      });
    }
  });

  socket.on("call-offer", (data: { offer: RTCSessionDescriptionInit; targetId: string; channelId?: string }) => {
    let targetSocketId = data.targetId;
    let targetStableId = resolveStableUserIdFromAny(data.targetId);
    if (data.channelId) {
      const channel = channels.get(data.channelId);
      if (!channel) {
        return;
      }

      if (channel.type === 'voice') {
        const audience = getVoiceAudienceSocketIds(data.channelId);
        if (!audience.has(socket.id) || !audience.has(data.targetId)) {
          return;
        }
      } else if (channel.type === 'group') {
        const session = groupCallSessions.get(data.channelId);
        const senderStableId = getStableUserId(socket);
        targetStableId = resolveStableUserIdFromAny(data.targetId);
        const resolvedTargetSocketId = users.has(data.targetId)
          ? data.targetId
          : (targetStableId ? resolveSocketId(targetStableId) : null);

        if (
          !session ||
          !targetStableId ||
          !resolvedTargetSocketId ||
          !users.has(resolvedTargetSocketId) ||
          !session.connectedParticipants.has(senderStableId) ||
          !session.connectedParticipants.has(targetStableId)
        ) {
          return;
        }

        targetSocketId = resolvedTargetSocketId;
      } else {
        return;
      }
    }
    const user = users.get(socket.id);
    const delivered = emitToCallTarget(targetStableId || targetSocketId, "call-offer", {
      offer: data.offer,
      senderId: getStableUserId(socket),
      username: user?.username || 'Unknown',
      channelId: data.channelId
    });
    if (!delivered) {
      socket.emit("call-error", {
        code: "target_unavailable",
        message: "Target user is not currently connected",
        targetUserId: targetStableId || targetSocketId
      });
    }
  });

  socket.on("call-answer-sdp", (data: { answer: RTCSessionDescriptionInit; targetId: string }) => {
    emitToCallTarget(data.targetId, "call-answer-sdp", {
      answer: data.answer,
      senderId: getStableUserId(socket)
    });
  });

  socket.on("call-ice-candidate", (data: { candidate: RTCIceCandidateInit; targetId: string }) => {
    emitToCallTarget(data.targetId, "call-ice-candidate", {
      candidate: data.candidate,
      senderId: getStableUserId(socket)
    });
  });

  // Channel management
  socket.on("create-channel", (data: string | {
    name: string;
    description?: string;
    channelType?: 'text' | 'voice';
    type?: 'text' | 'voice';
    channel_type?: 'text' | 'voice';
    watchQueueEnabled?: boolean;
    minRole?: string;
    parentChannelId?: string;
    isBreakout?: boolean;
    breakoutIndex?: number;
  }) => {
    const highestRole = getSocketHighestRole();
    if (!['owner', 'admin', 'mod'].includes(highestRole)) {
      socket.emit("channel-error", "Only owner/admin/mod can create channels");
      return;
    }

    const channelName = typeof data === 'string' ? data : data.name;
    const channelDescription = typeof data === 'string' ? '' : (data.description || '');
    const requestedType =
      typeof data === 'string'
        ? 'text'
        : (data.channelType || data.type || data.channel_type || 'text');
    const channelType: 'text' | 'voice' = requestedType === 'voice' ? 'voice' : 'text';
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
      watchQueueEnabled: typeof data === 'string' ? false : data.watchQueueEnabled === true,
      minRole: 'guest',
      createdAt: Date.now(),
      type: channelType,
      parentChannelId: typeof data === 'string' ? undefined : data.parentChannelId,
      isBreakout: typeof data === 'string' ? false : data.isBreakout === true,
      breakoutIndex: typeof data === 'string' ? undefined : data.breakoutIndex,
      persistMessages: false
    };

    channels.set(channelId, channel);
    channelMessages.set(channelId, []);
    pinnedMessages.set(channelId, new Set());

    // Persist to DB for restart durability
    try {
      channelRepository.create({
        channel_id: channelId,
        channel_type: channelType,
        name: channelName,
        description: channelDescription,
        min_role: 'guest',
        created_at: channel.createdAt,
        created_by: getStableUserId(socket),
        parent_channel_id: channel.parentChannelId || null,
        is_breakout: channel.isBreakout ? 1 : 0,
        breakout_index: channel.breakoutIndex || null,
        persist_messages: channel.persistMessages ? 1 : 0,
        watch_queue_enabled: channel.watchQueueEnabled ? 1 : 0
      });
    } catch (dbError) {
      console.error('[ChannelRepository] Failed to persist channel:', dbError);
    }

    emitGlobalEvent("channel-created", channel);

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

    if (ENABLE_LOGGING) console.log(`Channel created: ${channelName}`);
  });

  socket.on("create-breakout-rooms", (data: { parentChannelId: string; roomCount?: number; autoAssign?: boolean }) => {
    const parentChannel = channels.get(data.parentChannelId);
    if (!parentChannel || parentChannel.type !== 'voice' || parentChannel.isBreakout) {
      socket.emit("channel-error", "Breakout rooms require a parent voice channel");
      return;
    }
    if (!canAccessChannel(parentChannel)) {
      socket.emit("channel-error", "Access denied to this voice channel");
      return;
    }
    if (!canManageVoiceBreakouts()) {
      socket.emit("channel-error", "Only owner/admin/mod can manage breakout rooms");
      return;
    }

    const existingBreakouts = getBreakoutChannelsForParent(parentChannel.id);
    if (existingBreakouts.length > 0) {
      socket.emit("channel-error", "Close existing breakout rooms before creating a new set");
      return;
    }

    const roomCount = Math.max(2, Math.min(20, Math.floor(data.roomCount || 2)));
    const createdRooms: Channel[] = [];
    const creatorStableId = getStableUserId(socket);

    for (let i = 0; i < roomCount; i += 1) {
      const index = i + 1;
      let channelId = `${parentChannel.id}-breakout-${index}`;
      let suffix = 1;
      while (channels.has(channelId)) {
        suffix += 1;
        channelId = `${parentChannel.id}-breakout-${index}-${suffix}`;
      }

      const breakoutChannel: Channel = {
        id: channelId,
        name: `${parentChannel.name} Room ${index}`,
        description: `Breakout room ${index} for ${parentChannel.name}`,
        minRole: parentChannel.minRole || 'guest',
        createdAt: Date.now(),
        type: 'voice',
        parentChannelId: parentChannel.id,
        isBreakout: true,
        breakoutIndex: index,
        persistMessages: false
      };

      channels.set(channelId, breakoutChannel);
      channelMessages.set(channelId, []);
      pinnedMessages.set(channelId, new Set());

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

      createdRooms.push(breakoutChannel);
      emitGlobalEvent("channel-created", breakoutChannel);
    }

    if (data.autoAssign !== false && createdRooms.length > 0) {
      const parentParticipants = Array.from(voiceChannelParticipants.get(parentChannel.id) || []);
      parentParticipants.forEach((stableUserId, idx) => {
        const targetRoom = createdRooms[idx % createdRooms.length];
        moveVoiceParticipant(stableUserId, parentChannel.id, targetRoom.id);
      });
    }

    io.emit("voice-breakouts-updated", {
      parentChannelId: parentChannel.id,
      breakoutChannelIds: createdRooms.map(room => room.id)
    });
  });

  socket.on("close-breakout-rooms", (data: { parentChannelId: string }) => {
    const parentChannel = channels.get(data.parentChannelId);
    if (!parentChannel || parentChannel.type !== 'voice' || parentChannel.isBreakout) {
      socket.emit("channel-error", "Breakout parent voice channel not found");
      return;
    }
    if (!canAccessChannel(parentChannel)) {
      socket.emit("channel-error", "Access denied to this voice channel");
      return;
    }
    if (!canManageVoiceBreakouts()) {
      socket.emit("channel-error", "Only owner/admin/mod can manage breakout rooms");
      return;
    }

    const breakoutChannels = getBreakoutChannelsForParent(parentChannel.id);
    if (breakoutChannels.length === 0) return;

    breakoutChannels.forEach((breakoutChannel) => {
      const participants = Array.from(voiceChannelParticipants.get(breakoutChannel.id) || []);
      participants.forEach((stableUserId) => moveVoiceParticipant(stableUserId, breakoutChannel.id, parentChannel.id));

      voiceChannelParticipants.delete(breakoutChannel.id);

      channels.delete(breakoutChannel.id);
      channelMessages.delete(breakoutChannel.id);
      pinnedMessages.delete(breakoutChannel.id);
      channelRepository.delete(breakoutChannel.id);
      emitGlobalEvent("channel-deleted", breakoutChannel.id);
    });

    emitVoiceChannelState(parentChannel.id);
    io.emit("voice-breakouts-updated", {
      parentChannelId: parentChannel.id,
      breakoutChannelIds: []
    });
  });

  socket.on("move-user-to-breakout", (data: { parentChannelId: string; targetUserId: string; toChannelId: string }) => {
    const parentChannel = channels.get(data.parentChannelId);
    if (!parentChannel || parentChannel.type !== 'voice') {
      socket.emit("channel-error", "Breakout parent voice channel not found");
      return;
    }
    if (!canAccessChannel(parentChannel)) {
      socket.emit("channel-error", "Access denied to this voice channel");
      return;
    }
    if (!canManageVoiceBreakouts()) {
      socket.emit("channel-error", "Only owner/admin/mod can move users between breakout rooms");
      return;
    }

    const targetChannel = channels.get(data.toChannelId);
    if (!targetChannel || targetChannel.type !== 'voice') {
      socket.emit("channel-error", "Target breakout channel not found");
      return;
    }
    if (targetChannel.id !== parentChannel.id && targetChannel.parentChannelId !== parentChannel.id) {
      socket.emit("channel-error", "Target channel is not part of this breakout set");
      return;
    }

    const stableUserId = resolveStableUserIdFromAny(data.targetUserId);
    if (!stableUserId) {
      socket.emit("channel-error", "Target user not found");
      return;
    }

    const familyChannels = [parentChannel, ...getBreakoutChannelsForParent(parentChannel.id)];
    const fromChannel = familyChannels.find(channel => {
      const participants = voiceChannelParticipants.get(channel.id);
      return participants?.has(stableUserId);
    });
    if (!fromChannel) {
      socket.emit("channel-error", "Target user is not connected to this voice channel set");
      return;
    }

    const voiceGate = canJoinVoiceChannel(targetChannel, stableUserId);
    if (!voiceGate.allowed) {
      socket.emit("channel-error", voiceGate.reason);
      return;
    }

    moveVoiceParticipant(stableUserId, fromChannel.id, targetChannel.id);
  });

  socket.on("move-user-to-voice-channel", (data: { targetUserId: string; toChannelId: string }) => {
    const targetChannel = channels.get(data.toChannelId);
    if (!targetChannel || targetChannel.type !== 'voice') {
      socket.emit("channel-error", "Target voice channel not found");
      return;
    }
    if (!canAccessChannel(targetChannel)) {
      socket.emit("channel-error", "Access denied to this voice channel");
      return;
    }

    const stableUserId = resolveStableUserIdFromAny(data.targetUserId);
    if (!stableUserId) {
      socket.emit("channel-error", "Target user not found");
      return;
    }
    if (!canMoveVoiceMember(stableUserId)) {
      socket.emit("channel-error", "Only owner/admin/mod can move that user");
      return;
    }

    const voiceGate = canJoinVoiceChannel(targetChannel, stableUserId);
    if (!voiceGate.allowed) {
      socket.emit("channel-error", voiceGate.reason);
      return;
    }

    const fromChannel = Array.from(channels.values()).find((channel) => {
      if (channel.type !== 'voice') return false;
      const participants = voiceChannelParticipants.get(channel.id);
      return participants?.has(stableUserId);
    });
    if (!fromChannel) {
      socket.emit("channel-error", "Target user is not connected to a voice channel");
      return;
    }
    if (!canAccessChannel(fromChannel)) {
      socket.emit("channel-error", "Access denied to this voice channel");
      return;
    }

    moveVoiceParticipant(stableUserId, fromChannel.id, targetChannel.id);
  });

  socket.on("thread:create", (data: {
    parentChannelId: string;
    name: string;
    parentMessageId?: string;
    privateThread?: boolean;
    autoArchiveMinutes?: number;
  }) => {
    const parentChannel = channels.get(data.parentChannelId);
    if (!parentChannel) {
      socket.emit("channel-error", "Parent channel does not exist");
      return;
    }

    if (!canAccessChannel(parentChannel)) {
      socket.emit("channel-error", "Access denied to parent channel");
      return;
    }

    if (parentChannel.type !== 'text' && parentChannel.type !== 'public') {
      socket.emit("channel-error", "Threads can only be created from text channels");
      return;
    }

    const rawName = (data.name || '').trim();
    if (!rawName) {
      socket.emit("channel-error", "Thread name is required");
      return;
    }
    if (rawName.length > 64) {
      socket.emit("channel-error", "Thread name must be 64 characters or fewer");
      return;
    }

    const slug = rawName
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
    const fallbackSlug = `thread-${Date.now().toString(36)}`;
    const baseSlug = slug || fallbackSlug;

    let channelId = `${parentChannel.id}-thread-${baseSlug}`;
    let dedupeCounter = 1;
    while (channels.has(channelId)) {
      dedupeCounter += 1;
      channelId = `${parentChannel.id}-thread-${baseSlug}-${dedupeCounter}`;
    }

    const now = Date.now();
    const requestedArchiveMinutes = data.autoArchiveMinutes ?? 1440;
    const threadAutoArchiveMinutes = Math.min(10080, Math.max(60, requestedArchiveMinutes));
    const threadType: Channel['type'] = data.privateThread ? 'thread_private' : 'thread_public';
    const stableCreatorId = getSocketStableId();

    const threadChannel: Channel = {
      id: channelId,
      name: rawName,
      description: '',
      minRole: parentChannel.minRole || 'guest',
      createdAt: now,
      type: threadType,
      members: data.privateThread ? [stableCreatorId] : undefined,
      parentChannelId: parentChannel.id,
      parentMessageId: data.parentMessageId,
      threadArchived: false,
      threadLocked: false,
      threadAutoArchiveMinutes,
      threadLastActivityAt: now,
      persistMessages: parentChannel.persistMessages ?? false
    };

    channels.set(channelId, threadChannel);
    channelMessages.set(channelId, []);
    pinnedMessages.set(channelId, new Set());

    try {
      channelRepository.create({
        channel_id: channelId,
        channel_type: threadType === 'thread_private' ? 'thread_private' : 'thread_public',
        name: rawName,
        description: '',
        min_role: threadChannel.minRole || 'guest',
        created_at: now,
        created_by: stableCreatorId,
        persist_messages: threadChannel.persistMessages ? 1 : 0,
        parent_channel_id: parentChannel.id,
        parent_message_id: data.parentMessageId || null,
        thread_archived: 0,
        thread_locked: 0,
        thread_auto_archive_minutes: threadAutoArchiveMinutes,
        thread_last_activity_at: now
      });

      if (threadChannel.members && threadChannel.members.length > 0) {
        channelMemberRepository.addMember({
          channel_id: channelId,
          user_id: stableCreatorId,
          username: users.get(socket.id)?.username || 'Unknown',
          registered_user_id: users.get(socket.id)?.dbUserId,
          joined_at: now
        });
      }
    } catch (dbError) {
      console.error('[ChannelRepository] Failed to persist thread channel:', dbError);
    }

    if (threadType === 'thread_private') {
      socket.emit("channel-created", threadChannel);
    } else {
      emitGlobalEvent("channel-created", threadChannel);
    }

    pluginLoader.triggerOnChannelCreate(threadChannel).catch((error) => {
      console.error('[Plugins] Failed to trigger onChannelCreate hook:', error);
    });
    dispatchWebhookEvent('channel.created', {
      channelId: threadChannel.id,
      name: threadChannel.name,
      type: threadChannel.type || 'text'
    }).catch((error) => {
      console.error('[Webhooks] Failed to dispatch channel.created:', error);
    });

    if (ENABLE_LOGGING) console.log(`Thread created: ${threadChannel.name} (${threadChannel.id})`);
  });

  socket.on("delete-channel", (channelId: string) => {
    const highestRole = getSocketHighestRole();
    if (!['owner', 'admin', 'mod'].includes(highestRole)) {
      socket.emit("channel-error", "Only owner/admin/mod can delete channels");
      return;
    }

    if (channelId === 'general' || channelId === 'voice') {
      socket.emit("channel-error", "Cannot delete base channels");
      return;
    }

    if (!channels.has(channelId)) {
      socket.emit("channel-error", "Channel does not exist");
      return;
    }

    const childThreadIds = Array.from(channels.values())
      .filter((channel) => channel.parentChannelId === channelId)
      .map((channel) => channel.id);
    for (const threadId of childThreadIds) {
      channels.delete(threadId);
      channelMessages.delete(threadId);
      pinnedMessages.delete(threadId);
      try {
        channelRepository.delete(threadId);
      } catch (dbError) {
        console.error('[ChannelRepository] Failed to delete child thread from DB:', dbError);
      }
      emitGlobalEvent("channel-deleted", threadId);
    }

    channels.delete(channelId);
    channelMessages.delete(channelId);
    pinnedMessages.delete(channelId);

    try {
      channelRepository.delete(channelId);
    } catch (dbError) {
      console.error('[ChannelRepository] Failed to delete channel from DB:', dbError);
    }

    emitGlobalEvent("channel-deleted", channelId);
    if (ENABLE_LOGGING) console.log(`Channel deleted: ${channelId}`);
  });

  // Update channel auto-delete settings
  socket.on("update-channel-settings", (data: {
    channelId: string;
    autoDeleteAfter?: '5s' | '1h' | '6h' | '12h' | '24h' | '3d' | '7d' | '14d' | '30d' | null;
    persistMessages?: boolean;
    name?: string;
    description?: string;
    watchQueueEnabled?: boolean;
    minRole?: string;
    voiceSettings?: {
      bitrateMode?: 'auto' | 'low' | 'standard' | 'high';
      userLimit?: number | null;
      forceSolo?: boolean;
    };
  }) => {
    const channel = channels.get(data.channelId);
    if (!channel) {
      socket.emit("channel-error", "Channel does not exist");
      return;
    }

    let validatedMinRole: string | undefined = data.minRole;
    if (data.minRole !== undefined) {
      const user = users.get(socket.id);
      const roleInfo = getUserRoleInfo(user?.dbUserId);
      if (!['owner', 'admin'].includes(roleInfo.highestRole)) {
        socket.emit("channel-error", "Only owner/admin can change channel role access");
        return;
      }
      if (!stateRbacStore.roleExists(data.minRole, 'default-workspace')) {
        socket.emit("channel-error", "Invalid minimum role");
        return;
      }
    }

    const actor = users.get(socket.id);
    const actorRole = getUserRoleInfo(actor?.dbUserId).highestRole;
    let normalizedVoiceSettings: Channel['voiceSettings'] | undefined;
    if (data.persistMessages !== undefined && actorRole !== 'owner') {
      socket.emit("channel-error", "Only owners can change message persistence");
      return;
    }
    if (data.name !== undefined && !['owner', 'admin'].includes(actorRole)) {
      socket.emit("channel-error", "Only owner/admin can rename channels");
      return;
    }
    if (data.watchQueueEnabled !== undefined && !['owner', 'admin'].includes(actorRole)) {
      socket.emit("channel-error", "Only owner/admin can change watch queue channel settings");
      return;
    }
    if (data.voiceSettings !== undefined) {
      if (channel.type !== 'voice') {
        socket.emit("channel-error", "Voice settings can only be changed on voice channels");
        return;
      }
      if (!['owner', 'admin'].includes(actorRole)) {
        socket.emit("channel-error", "Only owner/admin can change voice channel settings");
        return;
      }

      normalizedVoiceSettings = parseVoiceSettings(JSON.stringify(data.voiceSettings));
      const effectiveLimit = getVoiceChannelUserLimit({
        ...channel,
        voiceSettings: normalizedVoiceSettings
      });
      const participantCount = voiceChannelParticipants.get(channel.id)?.size || 0;
      if (effectiveLimit !== null && participantCount > effectiveLimit) {
        socket.emit("channel-error", `Current occupancy (${participantCount}) exceeds the configured voice limit (${effectiveLimit})`);
        return;
      }
    }

    // Update channel settings
    channel.autoDeleteAfter = data.autoDeleteAfter;
    if (data.name !== undefined) {
      channel.name = data.name.trim() || channel.name;
    }
    if (data.persistMessages !== undefined) {
      channel.persistMessages = data.persistMessages;
    }
    if (data.description !== undefined) {
      channel.description = data.description;
    }
    if (data.watchQueueEnabled !== undefined) {
      channel.watchQueueEnabled = data.watchQueueEnabled;
    }
    if (validatedMinRole !== undefined) {
      channel.minRole = validatedMinRole;
    }
    if (data.voiceSettings !== undefined) {
      channel.voiceSettings = normalizedVoiceSettings;
    }
    channels.set(data.channelId, channel);

    // Persist channel settings metadata to database (never transient voice occupancy)
    if (
      data.name !== undefined ||
      data.persistMessages !== undefined ||
      data.description !== undefined ||
      data.watchQueueEnabled !== undefined ||
      data.voiceSettings !== undefined ||
      data.minRole !== undefined
    ) {
      try {
        channelRepository.updateSettings(data.channelId, {
          name: data.name !== undefined ? (data.name.trim() || channel.name) : undefined,
          persist_messages: data.persistMessages !== undefined ? (data.persistMessages ? 1 : 0) : undefined,
          description: data.description,
          watch_queue_enabled: data.watchQueueEnabled !== undefined ? (data.watchQueueEnabled ? 1 : 0) : undefined,
          min_role: validatedMinRole,
          voice_settings_json: data.voiceSettings !== undefined ? (normalizedVoiceSettings ? JSON.stringify(normalizedVoiceSettings) : null) : undefined
        });
      } catch (e) {
        // Channel may not exist in DB yet (in-memory only)
      }
    }

    // Notify all clients about the update
    emitGlobalEvent("channel-settings-updated", {
      channelId: data.channelId,
      autoDeleteAfter: data.autoDeleteAfter,
      persistMessages: data.persistMessages,
      name: data.name,
      description: data.description,
      watchQueueEnabled: data.watchQueueEnabled,
      minRole: data.minRole,
      voiceSettings: data.voiceSettings !== undefined ? normalizedVoiceSettings : undefined
    });

    if (ENABLE_LOGGING) {
      console.log(`Channel ${data.channelId} settings updated:`, {
        autoDeleteAfter: data.autoDeleteAfter || 'disabled',
        persistMessages: data.persistMessages,
        name: data.name,
        description: data.description,
        watchQueueEnabled: data.watchQueueEnabled,
        minRole: data.minRole,
        voiceSettings: data.voiceSettings !== undefined ? normalizedVoiceSettings : undefined
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
          const dbMessages = stateMessageStore.getByChannel(dmId, { limit: 50 });
          channelMessages.set(dmId, dbMessages.map(msg => stateMessageStore.toClientFormat(msg)));
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
      persistMessages: false,
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
        persist_messages: 0
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
      emitToStableUser(memberId, "dm-deleted", { channelId: data.channelId });
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
      syncDbUserRoleState(data.targetUserId);
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
      if (data.roleName === 'owner') {
        const ownerCount = stateRbacStore.countRoleAssignments('owner', 'default-workspace');
        if (ownerCount <= 1) {
          socket.emit("channel-error", "Cannot remove the last owner");
          return;
        }
      }
      removeRole(data.targetUserId, data.roleName as any, 'default-workspace');
      syncDbUserRoleState(data.targetUserId);
    } catch (e) {
      socket.emit("channel-error", "Failed to remove role");
    }
  });

  socket.on("ban-user", (data: { targetUserId: number; reason?: string }) => {
    const user = users.get(socket.id);
    if (!user || !user.dbUserId) return;
    const myRoleInfo = getUserRoleInfo(user.dbUserId);
    if (!['owner', 'admin', 'mod'].includes(myRoleInfo.highestRole)) {
      socket.emit("channel-error", "Insufficient permissions to ban users");
      return;
    }

    if (!Number.isFinite(data.targetUserId)) {
      socket.emit("channel-error", "Invalid target user");
      return;
    }

    if (data.targetUserId === user.dbUserId) {
      socket.emit("channel-error", "You cannot ban yourself");
      return;
    }

    const targetUser = userRepository.findById(data.targetUserId);
    if (!targetUser) {
      socket.emit("channel-error", "Target user not found");
      return;
    }

    const targetRoleInfo = getUserRoleInfo(data.targetUserId);
    if (targetRoleInfo.highestRole === 'owner') {
      socket.emit("channel-error", "Owner account cannot be banned");
      return;
    }

    const myPriority = getRolePriority(myRoleInfo.highestRole);
    const targetPriority = getRolePriority(targetRoleInfo.highestRole);
    if (myPriority <= targetPriority) {
      socket.emit("channel-error", "You cannot ban a user with equal or higher role");
      return;
    }

    try {
      userRepository.update(data.targetUserId, { is_active: 0 });
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(data.targetUserId);

      for (const [sid, onlineUser] of users.entries()) {
        if (onlineUser.dbUserId === data.targetUserId) {
          io.to(sid).emit("channel-error", "Your account has been banned.");
          io.sockets.sockets.get(sid)?.disconnect(true);
        }
      }

      socket.emit("channel-error", `User ${targetUser.username} banned.`);

      if (ENABLE_LOGGING) {
        const reason = (data.reason || '').trim();
        console.log(`[Moderation] ${user.username} banned user ${targetUser.username}${reason ? ` | reason: ${reason}` : ''}`);
      }
    } catch {
      socket.emit("channel-error", "Failed to ban user");
    }
  });

  socket.on("get-role-definitions", () => {
    socket.emit("role-definitions-updated", { roles: getRoleDefinitions('default-workspace') });
  });

  socket.on("set-role-display-name", (data: { roleName: string; displayName: string }) => {
    const user = users.get(socket.id);
    if (!user || !user.dbUserId) return;
    const myRoleInfo = getUserRoleInfo(user.dbUserId);
    if (!['owner', 'admin'].includes(myRoleInfo.highestRole)) {
      socket.emit("channel-error", "Insufficient permissions to rename roles");
      return;
    }

    const nextDisplay = (data.displayName || '').trim();
    if (nextDisplay.length < 1 || nextDisplay.length > 40) {
      socket.emit("channel-error", "Role display names must be 1-40 characters");
      return;
    }

    try {
      stateRbacStore.setRoleDisplayName(data.roleName, nextDisplay, 'default-workspace');
      emitRoleDefinitions();
    } catch (error) {
      socket.emit("channel-error", "Failed to update role display name");
    }
  });

  socket.on("get-emoji-role-rules", () => {
    emitEmojiRoleRules(socket.id);
  });

  socket.on("set-emoji-role-rule", (data: {
    channelId: string;
    messageId: string;
    emojiId: string;
    roleName: string;
    removeOnUnreact?: boolean;
  }) => {
    const user = users.get(socket.id);
    if (!user || !user.dbUserId) return;
    const myRoleInfo = getUserRoleInfo(user.dbUserId);
    if (!['owner', 'admin'].includes(myRoleInfo.highestRole)) {
      socket.emit("channel-error", "Insufficient permissions to manage emoji role rules");
      return;
    }

    if (!data.channelId || !data.messageId || !data.emojiId || !data.roleName) {
      socket.emit("channel-error", "Channel, role-gate message, emoji, and role are required");
      return;
    }

    if (data.roleName === 'owner') {
      socket.emit("channel-error", "Owner role cannot be automated");
      return;
    }

    if (!stateRbacStore.roleExists(data.roleName, 'default-workspace')) {
      socket.emit("channel-error", "Unknown role");
      return;
    }

    const gateMessages = channelMessages.get(data.channelId) || [];
    const gateMessage = gateMessages.find((message) => message.id === data.messageId);
    if (!gateMessage || gateMessage.type !== 'role_gate') {
      socket.emit("channel-error", "Selected message is not a role-gate post");
      return;
    }

    try {
      db.prepare(`
        INSERT INTO emoji_role_rules (channel_id, message_id, emoji_id, role_name, remove_on_unreact, workspace_id, enabled)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(
        data.channelId,
        data.messageId,
        data.emojiId,
        data.roleName,
        data.removeOnUnreact ? 1 : 0,
        'default-workspace'
      );
      emitEmojiRoleRules();
    } catch (error) {
      socket.emit("channel-error", "Failed to add emoji role rule");
    }
  });

  socket.on("delete-emoji-role-rule", (data: { ruleId: number }) => {
    const user = users.get(socket.id);
    if (!user || !user.dbUserId) return;
    const myRoleInfo = getUserRoleInfo(user.dbUserId);
    if (!['owner', 'admin'].includes(myRoleInfo.highestRole)) {
      socket.emit("channel-error", "Insufficient permissions to manage emoji role rules");
      return;
    }

    try {
      db.prepare('DELETE FROM emoji_role_rules WHERE id = ? AND workspace_id = ?')
        .run(data.ruleId, 'default-workspace');
      emitEmojiRoleRules();
    } catch (error) {
      socket.emit("channel-error", "Failed to delete emoji role rule");
    }
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
        persist_messages: 0
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
      emitToStableUser(stableId, "group-created", groupPayload);
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
      emitToStableUser(memberId, "group-member-removed", { channelId: data.channelId, userId: stableId });
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
    emitToStableUser(data.targetUserId, "group-removed", { channelId: data.channelId });

    // Notify remaining members
    channel.members?.forEach(memberId => {
      emitToStableUser(memberId, "group-member-removed", { channelId: data.channelId, userId: data.targetUserId });
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
      emitToStableUser(memberId, "group-member-added", {
        channelId: data.channelId,
        userId: data.userId,
        user: addedUserInfo
      });
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
    emitToStableUser(data.userId, "group-created", {
      id: data.channelId,
      name: channel.name,
      createdAt: channel.createdAt,
      type: 'group',
      members: channel.members,
      memberUsers,
      avatar: dbChannel?.avatar || null
    });

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
      emitToStableUser(memberId, "group-avatar-updated", { channelId: data.channelId, avatar: data.avatarUrl });
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

    // Parse base64 image data — restrict to safe raster image types only
    const matches = data.imageData.match(/^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/);
    if (!matches) {
      socket.emit("emote-error", "Invalid image data (only PNG, JPEG, GIF, WebP allowed)");
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
      recordPresenceStateEvent(socket, 'user_left', {
        reason: 'disconnect'
      });

      // Clean up reverse mapping for registered users
      if (user.dbUserId) {
        const currentSocketForUser = dbUserIdToSocketId.get(user.dbUserId);
        if (currentSocketForUser === socket.id) {
          dbUserIdToSocketId.delete(user.dbUserId);
        }
        releaseStateMeshSocketLease(`user-${user.dbUserId}`, (socket as any).meshLeaseConnectedAt ?? null);
      }
      deletePresenceLeaseForUser(user, (socket as any).meshPresenceConnectedAt ?? null);

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
      const stableUserId = getStableUserId(socket);
      clearAllRecordingPresenceForStableUser(stableUserId, socket.id);
      emitDirectCallRecordingPresenceForSocketSet(callPeers);
      for (const peerId of callPeers) {
        io.to(peerId).emit("call-ended", { userId: socket.id });
      }

      // Remove user from all voice channels and emit leave events
      for (const session of Array.from(groupCallSessions.values())) {
        if (!session.connectedParticipants.has(stableUserId) && !session.invitedParticipants.has(stableUserId)) {
          continue;
        }

        removeGroupCallParticipantFromSession(session, stableUserId, {
          userId: socket.id,
          cancelPendingIfEmpty: true
        });
      }

      for (const [voiceChannelId, participants] of voiceChannelParticipants.entries()) {
        if (!participants.has(stableUserId)) continue;

        participants.delete(stableUserId);
        if (participants.size === 0) {
          voiceChannelParticipants.delete(voiceChannelId);
        }

        emitVoiceChannelState(voiceChannelId);
        emitToVoiceAudience(voiceChannelId, "voice-channel-user-left", {
          channelId: voiceChannelId,
          userId: stableUserId,
          socketId: socket.id
        });
      }
      removeAllVoicePeerLinks(stableUserId);
      removeAllVoiceSubscriptionsForSocket(socket.id);

      const leftPayload = {
        id: getPublicUserId(user),
        username: user.username,
        dbUserId: user.dbUserId,
        joinedAt: user.joinedAt ?? ((socket as any).meshPresenceConnectedAt ?? null)
      };
      socket.broadcast.emit("user-left", leftPayload);
      emitMeshBroadcast("user-left", leftPayload);

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

console.log(`[Plugins] System: ${PLUGINS_ENABLED ? 'enabled' : 'disabled'} | Install API: ${PLUGINS_ALLOW_INSTALL ? 'enabled' : 'disabled'}`);
