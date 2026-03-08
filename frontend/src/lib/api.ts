import { getServerUrl } from './serverUrl';
import { authStore } from './authStore';

const getApiBase = () => getServerUrl();

/** Default timeout for all API requests (ms). */
const API_TIMEOUT_MS = 15000;
const LAUNCH_PAGE_TIMEOUT_MS = 1500;

/**
 * Wraps `fetch` with an AbortController timeout.
 * All API calls in this module go through here so the timeout is
 * defined in exactly one place.
 */
type RequestWithTimeout = RequestInit & { timeoutMs?: number };

async function fetchWithTimeout(url: string, options: RequestWithTimeout = {}): Promise<Response> {
	const controller = new AbortController();
	const timeoutMs =
		typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
			? options.timeoutMs
			: API_TIMEOUT_MS;
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	const requestOptions: RequestInit = { ...options };
	delete (requestOptions as RequestWithTimeout).timeoutMs;
	try {
		return await fetch(url, {
			...requestOptions,
			credentials: requestOptions.credentials ?? 'include',
			signal: controller.signal
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === 'AbortError') {
			throw new Error(`Request timed out after ${timeoutMs}ms`);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

export interface AuthResponse {
	token: string;
	user: {
		id: number;
		username: string;
		handle?: string;
		color: string;
		profilePicture?: string;
		isRegistered: boolean;
	};
}

export interface LaunchPageHighlight {
	title: string;
	description: string;
}

export interface LaunchPageConfig {
	enabled: boolean;
	brandName: string;
	headline: string;
	subheadline: string;
	logoUrl: string;
	heroImageUrl: string | null;
	heroTitle: string | null;
	heroBody: string | null;
	heroPrimaryCtaLabel: string | null;
	heroPrimaryCtaUrl: string | null;
	highlights: LaunchPageHighlight[];
	footerNote: string | null;
	palette: {
		backgroundTop: string;
		backgroundBottom: string;
		cardBackground: string;
		accent: string;
		text: string;
	};
}

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

export interface PaymentProviderCapability {
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
	metadata: Record<string, unknown> | null;
	presentation: Record<string, unknown> | null;
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
	payload: Record<string, unknown> | null;
	signatureValid: boolean | null;
	idempotencyKey: string | null;
	createdAt: number;
}

export interface PaymentAccessPolicy {
	enabled: boolean;
	allowGuest: boolean;
	allowedRoleNames: string[];
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

export interface PaymentAccountLink {
	userId: number;
	workspaceId: string;
	pluginId: string;
	providerAccountRef: string;
	displayLabel: string | null;
	metadata: Record<string, unknown> | null;
	linkedAt: number;
	updatedAt: number;
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
	metadata?: Record<string, unknown>;
}

export interface CreatePaymentIntentResponse {
	success: boolean;
	reused: boolean;
	idempotencyKey: string;
	intent: PaymentIntent;
	events: PaymentEvent[];
}

export async function listPaymentProviders(filters?: {
	countryCode?: string;
	currency?: string;
	amountMinor?: number;
}): Promise<PaymentProviderCapability[]> {
	const query = new URLSearchParams();
	if (filters?.countryCode) query.set('country', filters.countryCode);
	if (filters?.currency) query.set('currency', filters.currency);
	if (typeof filters?.amountMinor === 'number' && Number.isFinite(filters.amountMinor) && filters.amountMinor > 0) {
		query.set('amountMinor', String(Math.floor(filters.amountMinor)));
	}
	const suffix = query.size > 0 ? `?${query.toString()}` : '';
	const res = await fetchWithTimeout(`${getApiBase()}/api/payments/providers${suffix}`, {
		method: 'GET'
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(data.error || 'Failed to list payment providers');
	}
	return Array.isArray(data.providers) ? (data.providers as PaymentProviderCapability[]) : [];
}

export async function createPaymentIntent(
	token: string | null | undefined,
	payload: CreatePaymentIntentPayload
): Promise<CreatePaymentIntentResponse> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/payments/create`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(payload)
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(data.error || 'Failed to create payment intent');
	}
	return {
		success: Boolean(data.success),
		reused: Boolean(data.reused),
		idempotencyKey: typeof data.idempotencyKey === 'string' ? data.idempotencyKey : '',
		intent: data.intent as PaymentIntent,
		events: Array.isArray(data.events) ? (data.events as PaymentEvent[]) : []
	};
}

export async function getPaymentIntent(
	token: string | null | undefined,
	intentId: string,
	options?: {
		refresh?: boolean;
		includeEvents?: boolean;
		eventLimit?: number;
	}
): Promise<{ intent: PaymentIntent; events: PaymentEvent[]; providerRefreshError?: string | null }> {
	const query = new URLSearchParams();
	if (options?.refresh) query.set('refresh', 'true');
	if (options?.includeEvents === false) query.set('includeEvents', 'false');
	if (typeof options?.eventLimit === 'number' && Number.isFinite(options.eventLimit) && options.eventLimit > 0) {
		query.set('eventLimit', String(Math.floor(options.eventLimit)));
	}
	const suffix = query.size > 0 ? `?${query.toString()}` : '';
	const res = await fetchWithTimeout(`${getApiBase()}/api/payments/${encodeURIComponent(intentId)}${suffix}`, {
		method: 'GET',
		headers: token ? { Authorization: `Bearer ${token}` } : undefined
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(data.error || 'Failed to load payment intent');
	}
	return {
		intent: data.intent as PaymentIntent,
		events: Array.isArray(data.events) ? (data.events as PaymentEvent[]) : [],
		providerRefreshError:
			typeof data.providerRefreshError === 'string' || data.providerRefreshError === null
				? data.providerRefreshError
				: undefined
	};
}

export async function cancelPaymentIntent(
	token: string | null | undefined,
	intentId: string,
	reason?: string
): Promise<{ intent: PaymentIntent; events: PaymentEvent[] }> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/payments/${encodeURIComponent(intentId)}/cancel`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ reason: reason || 'Canceled by user' })
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(data.error || 'Failed to cancel payment intent');
	}
	return {
		intent: data.intent as PaymentIntent,
		events: Array.isArray(data.events) ? (data.events as PaymentEvent[]) : []
	};
}

export async function getPaymentAccess(
	token: string | null | undefined
): Promise<PaymentAccessStatusResponse> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/payments/access`, {
		method: 'GET',
		headers: token ? { Authorization: `Bearer ${token}` } : undefined
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(data.error || 'Failed to load payment access status');
	}
	return {
		success: Boolean(data.success),
		policy: (data.policy || {
			enabled: false,
			allowGuest: false,
			allowedRoleNames: ['owner', 'admin', 'mod', 'member']
		}) as PaymentAccessPolicy,
		actor: (data.actor || {
			authenticated: false,
			userId: null,
			roles: ['guest'],
			blocked: false,
			canCreate: false,
			reasonCode: 'unknown',
			reason: 'Unavailable'
		}) as PaymentAccessActorStatus
	};
}

export async function listPaymentAccountLinks(
	token: string | null | undefined
): Promise<PaymentAccountLink[]> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/payments/account-links`, {
		method: 'GET',
		headers: token ? { Authorization: `Bearer ${token}` } : undefined
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(data.error || 'Failed to load payment account links');
	}
	return Array.isArray(data.links) ? (data.links as PaymentAccountLink[]) : [];
}

export async function upsertPaymentAccountLink(
	token: string | null | undefined,
	payload: {
		pluginId: string;
		providerAccountRef: string;
		displayLabel?: string;
		metadata?: Record<string, unknown>;
	}
): Promise<PaymentAccountLink> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/payments/account-links`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(payload)
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(data.error || 'Failed to save payment account link');
	}
	return data.link as PaymentAccountLink;
}

export async function deletePaymentAccountLink(
	token: string | null | undefined,
	pluginId: string
): Promise<boolean> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/payments/account-links/${encodeURIComponent(pluginId)}`, {
		method: 'DELETE',
		headers: token ? { Authorization: `Bearer ${token}` } : undefined
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(data.error || 'Failed to clear payment account link');
	}
	return Boolean(data.cleared);
}

export async function getLaunchPageConfig(): Promise<LaunchPageConfig | null> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/public/launch-page`, {
		method: 'GET',
		timeoutMs: LAUNCH_PAGE_TIMEOUT_MS
	});
	if (!res.ok) return null;
	return res.json();
}

export async function register(username: string, password: string, handle?: string): Promise<AuthResponse> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/auth/register`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password, handle })
	});

	if (!res.ok) {
		const error = await res.json();
		throw new Error(error.error || 'Registration failed');
	}

	return res.json();
}

export async function login(username: string, password: string): Promise<AuthResponse> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/auth/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password })
	});

	if (!res.ok) {
		const error = await res.json();
		throw new Error(error.error || 'Login failed');
	}

	return res.json();
}

export async function upgradeToRegistered(sessionId: string, password: string): Promise<AuthResponse> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/auth/upgrade`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ sessionId, password })
	});

	if (!res.ok) {
		const error = await res.json();
		throw new Error(error.error || 'Upgrade failed');
	}

	return res.json();
}

export async function changePassword(
	token: string | null | undefined,
	currentPassword: string,
	newPassword: string
): Promise<void> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/auth/change-password`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ currentPassword, newPassword })
	});

	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || 'Failed to change password');
	}
}

export async function adminResetUserPassword(
	token: string | null | undefined,
	targetUserId: number,
	newPassword: string
): Promise<void> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/admin/users/reset-password`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ targetUserId, newPassword })
	});

	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || 'Failed to reset user password');
	}
}

export async function adminClearUserLoginLockout(
	token: string | null | undefined,
	targetUserId: number
): Promise<void> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/admin/users/clear-login-lockout`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ targetUserId })
	});

	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || 'Failed to clear login lockout');
	}
}

export async function storeEncryptionKeys(token: string | null | undefined, publicKey: string, privateKeyEncrypted: string): Promise<void> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/user/encryption-keys`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ publicKey, privateKeyEncrypted })
	});

	if (!res.ok && res.status !== 409) {
		// Include HTTP status in error for proper session validation
		const error = new Error(`Failed to store encryption keys (${res.status})`);
		(error as any).status = res.status;
		throw error;
	}
}

export async function getPublicKey(token: string | null | undefined, userId: number): Promise<string | null> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/users/${userId}/public-key`, {
		method: 'GET',
		headers: token ? { Authorization: `Bearer ${token}` } : undefined
	});

	if (!res.ok) {
		return null;
	}

	const data = await res.json();
	return data.publicKey || null;
}

export async function getUserSettings(token: string | null | undefined): Promise<any> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/user/settings`, {
		method: 'GET',
		headers: token ? { Authorization: `Bearer ${token}` } : undefined
	});

	if (!res.ok) {
		if (res.status === 401) {
			authStore.setAuthError('Your session has expired. Please log in again.', 'session_expired');
		}
		throw new Error('Failed to load settings');
	}

	return res.json();
}

export interface UserSettingsPayload {
	offline_message_retention?: string;
	allow_temp_user_messages?: boolean;
	home_experience?: 'community' | 'conversations';
}

export async function saveUserSettings(
	token: string | null | undefined,
	settings: UserSettingsPayload
): Promise<void> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/user/settings`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(settings)
	});

	if (!res.ok) {
		if (res.status === 401) {
			authStore.setAuthError('Your session has expired. Please log in again.', 'session_expired');
		}
		throw new Error('Failed to save settings');
	}
}

export type UploadRoleTier = 'new' | 'trusted' | 'moderator' | 'admin' | 'owner';

export interface UploadLimitConfig {
	perRoleBytes: Record<UploadRoleTier, number | null>;
	globalUploadCapBytes: number | null;
}

export interface DownloadLimitConfig {
	perRoleBytes: Record<UploadRoleTier, number | null>;
	globalDownloadCapBytes: number | null;
}

export type AdminPolicyKey = 'upload_limits' | 'download_limits' | 'runtime_tuning' | 'payments_access';

export interface RuntimeTuningConfig {
	applyOnRestart: true;
	threadPoolSize: number | null;
	heavyProfilingEnabled: boolean;
	heavyProfilingSampleRate: number;
}

export interface AdminCompressionConfig {
	httpTextCompression: {
		enabled: boolean;
		minBytes: number;
		brotliQuality: number;
		gzipLevel: number;
	};
	uploadCompression: {
		enabled: boolean;
		minBytes: number;
		gzipLevel: number;
		rolloutPercent: number;
	};
}

export interface AdminCompressionMetrics {
	counters: {
		uploadCount: number;
		downloadCount: number;
		uploadOriginalBytes: number;
		uploadStoredBytes: number;
		downloadStoredBytes: number;
		downloadResponseBytes: number;
		uploadStoredToOriginalRatio: number | null;
		downloadResponseToStoredRatio: number | null;
	};
	summaryByExt: {
		uploads: Array<{
			fileExt: string;
			count: number;
			originalBytes: number;
			storedBytes: number;
			responseBytes: number;
		}>;
		downloads: Array<{
			fileExt: string;
			count: number;
			originalBytes: number;
			storedBytes: number;
			responseBytes: number;
		}>;
	};
	recentSamples: {
		uploads: Array<Record<string, unknown>>;
		downloads: Array<Record<string, unknown>>;
	};
	clientVideoCompression?: {
		counters: {
			attemptCount: number;
			successCount: number;
			failureCount: number;
			cancelledCount: number;
			skippedCount: number;
			timeoutCount: number;
			notSmallerCount: number;
			inputBytes: number;
			outputBytes: number;
			successRate: number | null;
			outputToInputRatio: number | null;
		};
		summaryByRuntime: Array<{
			runtime: string;
			count: number;
			successCount: number;
			failureCount: number;
			cancelledCount: number;
			skippedCount: number;
		}>;
		topFailureCodes: Array<{
			failureCode: string;
			count: number;
		}>;
		recentSamples: Array<Record<string, unknown>>;
	};
}

export interface RuntimeGuardrailsSnapshot {
	uptimeSeconds: number;
	memory: {
		rssBytes: number;
		heapUsedBytes: number;
		heapTotalBytes: number;
		externalBytes: number;
		arrayBuffersBytes: number;
	};
	cpu: {
		userMicros: number;
		systemMicros: number;
	};
	heavyProfiling: {
		enabled: boolean;
		eventLoopDelayP95Ms: number | null;
		eventLoopDelayMaxMs: number | null;
	};
}

export interface AdminRuntimeGuardrailsResponse {
	runtimeTuning: {
		configured: RuntimeTuningConfig;
		startupApplied: RuntimeTuningConfig;
		restartRequired: boolean;
		effective: {
			uvThreadpoolSize: number | null;
			heavyProfilingEnabled: boolean;
		};
	};
	guardrails: RuntimeGuardrailsSnapshot;
}

export async function getAdminPolicy<T>(token: string, key: AdminPolicyKey): Promise<{
	key: AdminPolicyKey;
	config: T;
	defaults: T;
}> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 8000);
	try {
		const res = await fetch(`${getApiBase()}/api/admin/policies/${encodeURIComponent(key)}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${token}` },
			credentials: 'include',
			signal: controller.signal
		});
		if (!res.ok) {
			const error = await res.json().catch(() => ({}));
			throw new Error(error.error || `Failed to load policy: ${key}`);
		}
		return res.json();
	} finally {
		clearTimeout(timeout);
	}
}

export async function saveAdminPolicy<T>(token: string, key: AdminPolicyKey, config: T): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 8000);
	try {
		const res = await fetch(`${getApiBase()}/api/admin/policies/${encodeURIComponent(key)}`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json'
			},
			credentials: 'include',
			body: JSON.stringify(config),
			signal: controller.signal
		});
		if (!res.ok) {
			const error = await res.json().catch(() => ({}));
			throw new Error(error.error || `Failed to save policy: ${key}`);
		}
		const data = await res.json();
		return data.config;
	} finally {
		clearTimeout(timeout);
	}
}

export async function getAdminUploadLimits(token: string): Promise<{
	config: UploadLimitConfig;
	defaults: UploadLimitConfig;
}> {
	const data = await getAdminPolicy<UploadLimitConfig>(token, 'upload_limits');
	return { config: data.config, defaults: data.defaults };
}

export async function saveAdminUploadLimits(token: string, config: UploadLimitConfig): Promise<UploadLimitConfig> {
	return saveAdminPolicy<UploadLimitConfig>(token, 'upload_limits', config);
}

export async function getAdminPaymentAccessPolicy(token: string): Promise<PaymentAccessPolicy> {
	const data = await getAdminPolicy<PaymentAccessPolicy>(token, 'payments_access');
	return data.config;
}

export async function saveAdminPaymentAccessPolicy(token: string, config: PaymentAccessPolicy): Promise<PaymentAccessPolicy> {
	return saveAdminPolicy<PaymentAccessPolicy>(token, 'payments_access', config);
}

export interface PaymentUserBlock {
	userId: number;
	workspaceId: string;
	reason: string | null;
	blockedByUserId: number | null;
	blockedByUsername: string | null;
	blockedUsername: string | null;
	blockedAt: number;
	expiresAt: number | null;
}

export async function getAdminPaymentUserBlocks(token: string): Promise<PaymentUserBlock[]> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/admin/payments/blocks`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(data.error || 'Failed to load payment user blocks');
	}
	return Array.isArray(data.blocks) ? (data.blocks as PaymentUserBlock[]) : [];
}

export async function setAdminPaymentUserBlock(
	token: string,
	userId: number,
	opts?: { reason?: string; expiresAt?: number | null }
): Promise<PaymentUserBlock> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/admin/payments/blocks`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			userId,
			reason: opts?.reason ?? null,
			expiresAt: opts?.expiresAt ?? null
		})
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(data.error || 'Failed to set payment block');
	}
	return data.block as PaymentUserBlock;
}

export async function clearAdminPaymentUserBlock(token: string, userId: number): Promise<boolean> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/admin/payments/blocks/${encodeURIComponent(String(userId))}`, {
		method: 'DELETE',
		headers: { Authorization: `Bearer ${token}` }
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(data.error || 'Failed to clear payment block');
	}
	return Boolean(data.cleared);
}

export async function getAdminCompressionConfig(token: string): Promise<AdminCompressionConfig> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/admin/compression-config`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || 'Failed to load compression config');
	}
	const data = await res.json();
	return data.config as AdminCompressionConfig;
}

export async function getAdminCompressionMetrics(token: string): Promise<AdminCompressionMetrics> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/admin/compression-metrics`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || 'Failed to load compression metrics');
	}
	const data = await res.json();
	return data.metrics as AdminCompressionMetrics;
}

export async function resetAdminCompressionMetrics(token: string): Promise<void> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/admin/compression-metrics/reset`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || 'Failed to reset compression metrics');
	}
}

export async function getAdminRuntimeGuardrails(token: string): Promise<AdminRuntimeGuardrailsResponse> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/admin/runtime-guardrails`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || 'Failed to load runtime guardrails');
	}
	const data = await res.json();
	return {
		runtimeTuning: data.runtimeTuning as AdminRuntimeGuardrailsResponse['runtimeTuning'],
		guardrails: data.guardrails as RuntimeGuardrailsSnapshot
	};
}

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

export async function lookupDictionary(term: string, language = 'en', limit = 8): Promise<DictionaryEntry[]> {
	const params = new URLSearchParams({
		term,
		language,
		limit: String(limit)
	});
	const res = await fetchWithTimeout(`${getApiBase()}/api/dictionary?${params.toString()}`, { method: 'GET' });
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || 'Failed to lookup dictionary entry');
	}
	const data = await res.json();
	return Array.isArray(data.entries) ? data.entries : [];
}

export async function upsertDictionaryEntry(
	token: string,
	term: string,
	definition: string,
	language = 'en'
): Promise<DictionaryEntry> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/dictionary`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ term, definition, language })
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || 'Failed to save dictionary entry');
	}
	const data = await res.json();
	return data.entry as DictionaryEntry;
}

export async function deleteDictionaryEntry(token: string, term: string, language = 'en'): Promise<void> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/dictionary`, {
		method: 'DELETE',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ term, language })
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || 'Failed to delete dictionary entry');
	}
}

export type MediaAlbumScopeType = 'channel' | 'dm';

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

export class MediaAlbumApiError extends Error {
	status: number;
	code: string | null;
	retryAfterSeconds: number | null;
	details: Record<string, unknown> | null;

	constructor(
		message: string,
		opts: {
			status: number;
			code?: string | null;
			retryAfterSeconds?: number | null;
			details?: Record<string, unknown> | null;
		}
	) {
		super(message);
		this.name = 'MediaAlbumApiError';
		this.status = opts.status;
		this.code = opts.code ?? null;
		this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
		this.details = opts.details ?? null;
	}
}

export async function listMediaAlbums(
	token: string,
	scopeType: MediaAlbumScopeType,
	scopeId: string,
	limit = 100
): Promise<MediaAlbum[]> {
	const params = new URLSearchParams({
		scopeType,
		scopeId,
		limit: String(limit)
	});
	const res = await fetchWithTimeout(`${getApiBase()}/api/albums?${params.toString()}`, {
		method: 'GET',
		headers: {
			Authorization: `Bearer ${token}`
		}
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || 'Failed to list media albums');
	}
	const data = await res.json();
	return Array.isArray(data.albums) ? (data.albums as MediaAlbum[]) : [];
}

export async function createMediaAlbum(
	token: string,
	payload: { scopeType: MediaAlbumScopeType; scopeId: string; name: string }
): Promise<MediaAlbum> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/albums`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(payload)
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || 'Failed to create media album');
	}
	const data = await res.json();
	return data.album as MediaAlbum;
}

export async function listMediaAlbumItems(
	token: string,
	albumId: number,
	limit = 300
): Promise<{ album: MediaAlbum; items: MediaAlbumItem[] }> {
	const params = new URLSearchParams({ limit: String(limit) });
	const res = await fetchWithTimeout(`${getApiBase()}/api/albums/${albumId}/items?${params.toString()}`, {
		method: 'GET',
		headers: {
			Authorization: `Bearer ${token}`
		}
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || 'Failed to list media album items');
	}
	const data = await res.json();
	return {
		album: data.album as MediaAlbum,
		items: Array.isArray(data.items) ? (data.items as MediaAlbumItem[]) : []
	};
}

export async function addMediaAlbumItem(
	token: string,
	albumId: number,
	payload: {
		attachmentUrl: string;
		attachmentName: string;
		attachmentSize?: number | null;
		attachmentMime?: string | null;
		messageId?: string | null;
		caption?: string | null;
	}
): Promise<MediaAlbumItem> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/albums/${albumId}/items`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(payload)
	});
	if (!res.ok) {
		const payload = await res.json().catch(() => ({} as Record<string, unknown>));
		const code = typeof payload.code === 'string' ? payload.code : null;
		const retryAfterSeconds =
			typeof payload.retryAfterSeconds === 'number' && Number.isFinite(payload.retryAfterSeconds)
				? payload.retryAfterSeconds
				: null;
		const details =
			payload.details && typeof payload.details === 'object'
				? (payload.details as Record<string, unknown>)
				: null;
		let message = typeof payload.error === 'string' ? payload.error : 'Failed to add media album item';
		if (retryAfterSeconds !== null && retryAfterSeconds > 0) {
			message = `${message} Try again in ${retryAfterSeconds}s.`;
		}
		throw new MediaAlbumApiError(message, {
			status: res.status,
			code,
			retryAfterSeconds,
			details
		});
	}
	const data = await res.json();
	return data.item as MediaAlbumItem;
}

export async function setMediaAlbumFeatured(
	token: string,
	albumId: number,
	featured: boolean
): Promise<MediaAlbum> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/albums/${albumId}/featured`, {
		method: 'PATCH',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ featured })
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || 'Failed to update featured album state');
	}
	const data = await res.json();
	return data.album as MediaAlbum;
}

export async function reorderMediaAlbumItems(
	token: string,
	albumId: number,
	itemIds: number[]
): Promise<MediaAlbumItem[]> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/albums/${albumId}/items/reorder`, {
		method: 'PATCH',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ itemIds })
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || 'Failed to reorder media album items');
	}
	const data = await res.json();
	return Array.isArray(data.items) ? (data.items as MediaAlbumItem[]) : [];
}

export async function deleteMediaAlbum(token: string, albumId: number): Promise<void> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/albums/${albumId}`, {
		method: 'DELETE',
		headers: {
			Authorization: `Bearer ${token}`
		}
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || 'Failed to delete media album');
	}
}

export async function deleteMediaAlbumItem(token: string, albumId: number, itemId: number): Promise<void> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/albums/${albumId}/items/${itemId}`, {
		method: 'DELETE',
		headers: {
			Authorization: `Bearer ${token}`
		}
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || 'Failed to delete media album item');
	}
}
