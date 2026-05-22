import type {
	PaymentCheckoutMode,
	PaymentIntentStatus
} from '../../../../shared/paymentContracts';
import type { Message } from '../socket-types';
import type { MediaAlbumScopeType } from './mediaAlbumScope';
import type {
	FollowedChannelPollChannelResult as SharedFollowedChannelPollChannelResult,
	FollowedChannelPollResponse as SharedFollowedChannelPollResponse
} from '../../../../shared/userContracts';
import type {
	PaymentAccessPolicy,
	PaymentDonationConfig
} from '../../../../shared/adminPolicyContracts';

export interface PaymentIntent {
	intentId: string;
	workspaceId: string;
	createdByUserId: number | null;
	channelId: string | null;
	pluginId: string;
	providerName: string;
	providerIntentId: string | null;
	amountMinor: number;
	currency: string;
	countryCode: string | null;
	status: PaymentIntentStatus;
	checkoutMode: PaymentCheckoutMode;
	customerRef: string | null;
	description: string | null;
	metadata: Record<string, any> | null;
	presentation: Record<string, any> | null;
	failureCode: string | null;
	failureMessage: string | null;
	expiresAt: number | null;
	completedAt: number | null;
	refundedAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface PaymentEvent {
	eventId: string;
	eventType: string;
	status: PaymentIntentStatus | null;
	source: 'core' | 'plugin' | 'webhook' | 'manual';
	payload: Record<string, any> | null;
	signatureValid: boolean | null;
	idempotencyKey: string | null;
	createdAt: number;
}

export interface PaymentAccessActorStatus {
	authenticated: boolean;
	userId: number | null;
	roles: string[];
	blocked: boolean;
	canCreate: boolean;
	reasonCode: string | null;
	reason: string | null;
}

export interface PaymentAccessStatusResponse {
	success: boolean;
	policy: PaymentAccessPolicy;
	actor: PaymentAccessActorStatus;
}

export interface CreatePaymentIntentPayload {
	pluginId: string;
	methodId: string;
	amountMinor: number;
	currency: string;
	countryCode?: string;
	channelId?: string;
	description?: string;
	customerRef?: string;
	idempotencyKey?: string;
	metadata?: Record<string, any>;
}

export interface CreatePaymentIntentResponse {
	success: boolean;
	reused: boolean;
	idempotencyKey: string;
	intent: PaymentIntent;
	events: PaymentEvent[];
}

export interface PaymentHistoryResponse {
	success: boolean;
	count: number;
	intents: PaymentIntent[];
}

export interface PaymentDonationTotal {
	currency: string;
	amountMinor: number;
	paymentCount: number;
}

export interface PaymentDonationSummaryResponse {
	success: boolean;
	config: PaymentDonationConfig;
	totals: PaymentDonationTotal[];
	recentDonations: PaymentDonationLedgerEntry[];
	offlineTotals: PaymentDonationTotal[];
	recentOfflineDonations: OfflineDonationLedgerEntry[];
}

export interface PaymentDonationLedgerEntry {
	intentId: string;
	donorLabel: string;
	amountMinor: number;
	currency: string;
	status: Extract<PaymentIntentStatus, 'succeeded' | 'refunded'>;
	createdAt: number;
	completedAt: number | null;
	refundedAt: number | null;
	updatedAt: number;
	canRefund: boolean;
}

export interface PaymentDonationAuditResponse {
	success: boolean;
	count: number;
	donations: PaymentDonationLedgerEntry[];
}

export interface PublicBackendEndpoint {
	instanceId: string;
	url: string;
	region: string;
	role: string;
	status: string;
	currentConnections: number;
	currentRegisteredUsers: number;
	currentGuestUsers: number;
	leaseExpiresAt: number;
}

export interface PublicBackendEndpointsResponse {
	success: boolean;
	currentUrl: string | null;
	endpoints: PublicBackendEndpoint[];
	generatedAt: number;
}

export type ManualCashSettlementStatus =
	| 'pending'
	| 'confirmed_by_creator'
	| 'confirmed_by_counterparty'
	| 'completed'
	| 'canceled'
	| 'disputed';

export interface ManualCashSettlement {
	settlementId: string;
	channelId: string | null;
	amountMinor: number;
	currency: string;
	description: string | null;
	status: ManualCashSettlementStatus;
	createdByUserId: number;
	counterpartyUserId: number | null;
	creatorLabel: string;
	counterpartyLabel: string;
	creatorConfirmedAt: number | null;
	counterpartyConfirmedAt: number | null;
	completedAt: number | null;
	createdAt: number;
	updatedAt: number;
	viewerRole: 'creator' | 'counterparty' | 'observer';
	canConfirm: boolean;
	canCancel: boolean;
	canDispute: boolean;
}

export interface ManualCashSettlementListResponse {
	success: boolean;
	count: number;
	items: ManualCashSettlement[];
}

export interface OfflineDonationLedgerEntry {
	settlementId: string;
	donorLabel: string;
	amountMinor: number;
	currency: string;
	description: string | null;
	status: 'recorded' | 'voided';
	createdAt: number;
	completedAt: number | null;
	voidedAt: number | null;
	updatedAt: number;
	sourceType: 'offline_manual';
	canVoid: boolean;
	recordedByLabel: string | null;
}

export interface OfflineDonationAuditResponse {
	success: boolean;
	count: number;
	donations: OfflineDonationLedgerEntry[];
}

export type FollowedChannelPollChannelResult = SharedFollowedChannelPollChannelResult<Message>;
export type FollowedChannelPollResponse = SharedFollowedChannelPollResponse<Message>;
export type AdminPolicyKey =
	| 'upload_limits'
	| 'download_limits'
	| 'runtime_tuning'
	| 'payments_access'
	| 'community_node_announcements'
	| 'community_node_access'
	| 'frontend_app_metadata';
export interface DictionaryEntry {
	id?: number;
	term: string;
	definition: string;
	language: string;
	createdByUserId?: number | null;
	createdByUsername?: string | null;
	createdAt: number;
	updatedAt: number;
	votes: number;
}
export interface MediaAlbum {
	id: number;
	scopeType: MediaAlbumScopeType;
	scopeId: string;
	name: string;
	createdBy: number;
	createdAt: number;
	updatedAt: number;
	isFeatured: boolean;
	itemCount: number;
}

export interface MediaAlbumItem {
	id: number;
	albumId: number;
	attachmentUrl: string;
	attachmentName: string;
	attachmentSize: number | null;
	attachmentMime: string | null;
	messageId: string | null;
	caption: string | null;
	sortOrder: number;
	uploadedBy: number;
	uploadedAt: number;
}
export type MediaAlbumErrorCode =
	| 'ALBUM_UPLOAD_SIZE_LIMIT'
	| 'ALBUM_UPLOAD_RATE_LIMIT_USER'
	| 'ALBUM_UPLOAD_RATE_LIMIT_SCOPE';
export interface SetupStatus {
	setupRequired: boolean;
}
export interface CreateChannelResponse {
	id: string;
	name: string;
	channel_type: string;
	position: number;
	parent_id: string | null;
}
