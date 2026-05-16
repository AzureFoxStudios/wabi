import type {
	AdminCompressionConfig,
	AdminCompressionMetrics,
	AdminRuntimeGuardrailsResponse,
	DesktopHelperRegistrationPayload,
	DownloadLimitConfig,
	RuntimeGuardrailsSnapshot,
	RuntimeTuningConfig,
	UploadLimitConfig
} from '../../../../shared/runtimeAdminContracts';
import type {
	CommunityNodeAccessPolicy,
	CommunityNodeAnnouncementsPolicy,
	FrontendAppMetadataPolicy,
	PaymentAccessPolicy
} from '../../../../shared/adminPolicyContracts';
import type { AdminRelayNode } from '../../../../shared/relayContracts';
import type { PaymentUserBlock } from '../../../../shared/paymentContracts';
import { getApiBase, fetchWithTimeout, safeJsonParse } from './utils';

export type AdminPolicyKey =
	| 'upload_limits'
	| 'download_limits'
	| 'runtime_tuning'
	| 'payments_access'
	| 'community_node_announcements'
	| 'community_node_access'
	| 'frontend_app_metadata';

export async function listAdminRelays(token: string | null | undefined): Promise<AdminRelayNode[]> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/relays/admin`, {
		method: 'GET',
		headers: token ? { Authorization: `Bearer ${token}` } : undefined
	});

	if (!res.ok) {
		const error = (await safeJsonParse(res)) as Record<string, any>;
		throw new Error(error.error || 'Failed to load relay roster');
	}

	try {
		const data = await res.json();
		return Array.isArray(data.relays) ? data.relays : [];
	} catch {
		throw new Error('Invalid response from server while loading relay roster');
	}
}

export async function approveAdminRelay(token: string | null | undefined, relayId: number): Promise<void> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/relay/approve`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ relay_id: relayId })
	});

	if (!res.ok) {
		const error = (await safeJsonParse(res)) as Record<string, any>;
		throw new Error(error.error || 'Failed to approve relay');
	}
}

export async function deleteAdminRelay(token: string | null | undefined, relayId: number): Promise<void> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/relay/${encodeURIComponent(String(relayId))}`, {
		method: 'DELETE',
		headers: token ? { Authorization: `Bearer ${token}` } : undefined
	});

	if (!res.ok) {
		const error = (await safeJsonParse(res)) as Record<string, any>;
		throw new Error(error.error || 'Failed to delete relay');
	}
}

export async function registerDesktopHelper(
	token: string | null | undefined,
	payload: DesktopHelperRegistrationPayload
): Promise<{ relayId: number; status: string }> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/desktop-helper/register`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(payload)
	});

	if (!res.ok) {
		const error = (await safeJsonParse(res)) as Record<string, any>;
		throw new Error(error.error || 'Failed to register desktop helper');
	}

	try {
		const data = await res.json();
		return {
			relayId: Number(data.relayId) || 0,
			status: typeof data.status === 'string' ? data.status : 'active'
		};
	} catch {
		throw new Error('Invalid response from server while registering desktop helper');
	}
}

export async function heartbeatDesktopHelper(
	token: string | null | undefined,
	payload: DesktopHelperRegistrationPayload
): Promise<void> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/desktop-helper/heartbeat`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(payload)
	});

	if (!res.ok) {
		const error = (await safeJsonParse(res)) as Record<string, any>;
		throw new Error(error.error || 'Failed to heartbeat desktop helper');
	}
}

export async function offlineDesktopHelper(
	token: string | null | undefined,
	helperId: string,
	reason?: string
): Promise<void> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/desktop-helper/offline`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ helperId, reason })
	});

	if (!res.ok) {
		const error = (await safeJsonParse(res)) as Record<string, any>;
		throw new Error(error.error || 'Failed to mark desktop helper offline');
	}
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
			const error = (await safeJsonParse(res)) as Record<string, any>;
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
			const error = (await safeJsonParse(res)) as Record<string, any>;
			throw new Error(error.error || `Failed to save policy: ${key}`);
		}
		try {
			const data = await res.json();
			return data.config;
		} catch {
			throw new Error(`Invalid response from server while saving policy: ${key}`);
		}
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

export async function getAdminCommunityNodeAnnouncementsPolicy(
	token: string
): Promise<CommunityNodeAnnouncementsPolicy> {
	const data = await getAdminPolicy<CommunityNodeAnnouncementsPolicy>(token, 'community_node_announcements');
	return data.config;
}

export async function saveAdminCommunityNodeAnnouncementsPolicy(
	token: string,
	config: CommunityNodeAnnouncementsPolicy
): Promise<CommunityNodeAnnouncementsPolicy> {
	return saveAdminPolicy<CommunityNodeAnnouncementsPolicy>(token, 'community_node_announcements', config);
}

export async function getAdminCommunityNodeAccessPolicy(token: string): Promise<CommunityNodeAccessPolicy> {
	const data = await getAdminPolicy<CommunityNodeAccessPolicy>(token, 'community_node_access');
	return data.config;
}

export async function saveAdminCommunityNodeAccessPolicy(
	token: string,
	config: CommunityNodeAccessPolicy
): Promise<CommunityNodeAccessPolicy> {
	return saveAdminPolicy<CommunityNodeAccessPolicy>(token, 'community_node_access', config);
}

export async function getAdminFrontendAppMetadataPolicy(token: string): Promise<FrontendAppMetadataPolicy> {
	const data = await getAdminPolicy<FrontendAppMetadataPolicy>(token, 'frontend_app_metadata');
	return data.config;
}

export async function saveAdminFrontendAppMetadataPolicy(
	token: string,
	config: FrontendAppMetadataPolicy
): Promise<FrontendAppMetadataPolicy> {
	return saveAdminPolicy<FrontendAppMetadataPolicy>(token, 'frontend_app_metadata', config);
}

export async function saveAdminPaymentAccessPolicy(token: string, config: PaymentAccessPolicy): Promise<PaymentAccessPolicy> {
	return saveAdminPolicy<PaymentAccessPolicy>(token, 'payments_access', config);
}

export async function getAdminPaymentUserBlocks(token: string): Promise<PaymentUserBlock[]> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/admin/payments/blocks`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	const data = (await safeJsonParse(res)) as Record<string, any>;
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
	const data = (await safeJsonParse(res)) as Record<string, any>;
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
	const data = (await safeJsonParse(res)) as Record<string, any>;
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
		const error = (await safeJsonParse(res)) as Record<string, any>;
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
		const error = (await safeJsonParse(res)) as Record<string, any>;
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
		const error = (await safeJsonParse(res)) as Record<string, any>;
		throw new Error(error.error || 'Failed to reset compression metrics');
	}
}

export async function getAdminRuntimeGuardrails(token: string): Promise<AdminRuntimeGuardrailsResponse> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/admin/runtime-guardrails`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const error = (await safeJsonParse(res)) as Record<string, any>;
		throw new Error(error.error || 'Failed to load runtime guardrails');
	}
	const data = await res.json();
	return {
		runtimeTuning: data.runtimeTuning as AdminRuntimeGuardrailsResponse['runtimeTuning'],
		guardrails: data.guardrails as RuntimeGuardrailsSnapshot
	};
}
