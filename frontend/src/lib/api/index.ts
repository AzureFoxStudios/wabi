/**
 * api/index.ts
 * Unified re-export layer maintaining 100% backward compatibility
 *
 * Re-exports all API modules:
 * - utils: Shared utilities and helpers
 * - payments: Payment operations
 * - auth: Authentication and user settings
 * - config: Public configuration and setup
 * - admin: Admin policies and management
 * - dictionary: Dictionary operations
 * - albums: Media album operations
 *
 * Total exports: 85 functions + types (fully backward compatible)
 */

// ============================================================================
// RE-EXPORTS FROM utils.ts
// ============================================================================

export { getApiBase, getApiBaseFor, API_TIMEOUT_MS, LAUNCH_PAGE_TIMEOUT_MS, RETRYABLE_STATUS, RETRY_DELAYS_MS, fetchWithTimeout, type RequestWithTimeout } from './utils';

// ============================================================================
// RE-EXPORTS FROM paymentCheckout.ts
// ============================================================================

export {
	listPaymentProviders,
	createPaymentIntent,
	getPaymentIntent,
	cancelPaymentIntent,
	getPaymentAccess,
	type PaymentIntent,
	type PaymentEvent,
	type PaymentAccessActorStatus,
	type PaymentAccessStatusResponse,
	type CreatePaymentIntentPayload,
	type CreatePaymentIntentResponse
} from './paymentCheckout';

// ============================================================================
// RE-EXPORTS FROM paymentHistory.ts
// ============================================================================

export {
	listPaymentAccountLinks,
	listPaymentHistory,
	upsertPaymentAccountLink,
	deletePaymentAccountLink,
	type PaymentHistoryResponse
} from './paymentHistory';

// ============================================================================
// RE-EXPORTS FROM paymentDonations.ts
// ============================================================================

export {
	getPaymentDonationSummary,
	getAdminPaymentDonationConfig,
	saveAdminPaymentDonationConfig,
	listAdminPaymentDonationAudit,
	refundAdminPaymentDonation,
	listAdminOfflineDonations,
	createAdminOfflineDonation,
	voidAdminOfflineDonation,
	type PaymentDonationTotal,
	type PaymentDonationSummaryResponse,
	type PaymentDonationLedgerEntry,
	type PaymentDonationAuditResponse,
	type OfflineDonationLedgerEntry,
	type OfflineDonationAuditResponse
} from './paymentDonations';

// ============================================================================
// RE-EXPORTS FROM paymentSettlements.ts
// ============================================================================

export {
	listManualCashSettlements,
	createManualCashSettlement,
	confirmManualCashSettlement,
	cancelManualCashSettlement,
	disputeManualCashSettlement,
	type ManualCashSettlementStatus,
	type ManualCashSettlement,
	type ManualCashSettlementListResponse
} from './paymentSettlements';

// ============================================================================
// RE-EXPORTS FROM auth.ts
// ============================================================================

export {
	register,
	login,
	upgradeToRegistered,
	changePassword,
	adminResetUserPassword,
	adminClearUserLoginLockout,
	storeEncryptionKeys,
	getPublicKey,
	getUserSettings,
	pollFollowedChannelActivity,
	saveUserSettings,
	type FollowedChannelPollChannelResult,
	type FollowedChannelPollResponse
} from './auth';

// ============================================================================
// RE-EXPORTS FROM config.ts
// ============================================================================

export {
	getLaunchPageConfig,
	getLaunchPageConfigFrom,
	getPublicFrontendAppMetadata,
	getPublicBackendEndpointsFrom,
	getSetupStatus,
	type PublicBackendEndpoint,
	type PublicBackendEndpointsResponse,
	type SetupStatus
} from './config';

// ============================================================================
// RE-EXPORTS FROM admin.ts
// ============================================================================

export {
	listAdminRelays,
	approveAdminRelay,
	deleteAdminRelay,
	registerDesktopHelper,
	heartbeatDesktopHelper,
	offlineDesktopHelper,
	getAdminPolicy,
	saveAdminPolicy,
	getAdminUploadLimits,
	saveAdminUploadLimits,
	getAdminPaymentAccessPolicy,
	getAdminCommunityNodeAnnouncementsPolicy,
	saveAdminCommunityNodeAnnouncementsPolicy,
	getAdminCommunityNodeAccessPolicy,
	saveAdminCommunityNodeAccessPolicy,
	getAdminFrontendAppMetadataPolicy,
	saveAdminFrontendAppMetadataPolicy,
	saveAdminPaymentAccessPolicy,
	getAdminPaymentUserBlocks,
	setAdminPaymentUserBlock,
	clearAdminPaymentUserBlock,
	getAdminCompressionConfig,
	getAdminCompressionMetrics,
	resetAdminCompressionMetrics,
	getAdminRuntimeGuardrails,
	type AdminPolicyKey
} from './admin';

// ============================================================================
// RE-EXPORTS FROM dictionary.ts
// ============================================================================

export {
	lookupDictionary,
	upsertDictionaryEntry,
	deleteDictionaryEntry,
	type DictionaryEntry
} from './dictionary';

// ============================================================================
// RE-EXPORTS FROM albums.ts
// ============================================================================

export {
	listMediaAlbums,
	createMediaAlbum,
	listMediaAlbumItems,
	addMediaAlbumItem,
	setMediaAlbumFeatured,
	reorderMediaAlbumItems,
	deleteMediaAlbum,
	deleteMediaAlbumItem,
	MediaAlbumApiError,
	type MediaAlbumScopeType,
	type MediaAlbum,
	type MediaAlbumItem,
	type MediaAlbumErrorCode
} from './albums';

// ============================================================================
// RE-EXPORTS FROM channels.ts
// ============================================================================

export { createChannelApi, deleteChannelApi } from './channels';

// ============================================================================
// RE-EXPORT TYPE ASSERTIONS FROM SHARED CONTRACTS
// ============================================================================

export type {
	PaymentCheckoutMode,
	PaymentIntentStatus,
	PaymentMethodCapability,
	PaymentProviderCapability,
	PaymentUserBlock
} from '../../../../shared/paymentContracts';

export type {
	CommunityNodeAccessMode,
	CommunityNodeAllowedUser,
	CommunityNodeAccessPolicy,
	CommunityNodeAnnouncementsPolicy,
	FrontendAppMetadataPolicy,
	PaymentAccessPolicy,
	PaymentAccountLink,
	PaymentDonationConfig
} from '../../../../shared/adminPolicyContracts';

export type {
	AdminCompressionConfig,
	AdminCompressionMetrics,
	AdminRuntimeGuardrailsResponse,
	DesktopHelperRegistrationPayload,
	DownloadLimitConfig,
	RuntimeGuardrailsSnapshot,
	RuntimeTuningConfig,
	UploadLimitConfig,
	UploadRoleTier
} from '../../../../shared/runtimeAdminContracts';

export type { LaunchPageConfig, LaunchPageHighlight } from '../../../../shared/launchPageContracts';

export type {
	AuthResponse,
	FollowedChannelPollRequest,
	UserSettingsPayload,
	UserSettingsResponse
} from '../../../../shared/userContracts';

export type { AdminRelayNode, ParsedRelayMetadata as AdminRelayNodeMetadata } from '../../../../shared/relayContracts';
