import type { LaunchPageConfig } from '../../../../shared/launchPageContracts';
import type { AuthPolicy, FrontendAppMetadataPolicy } from '../../../../shared/adminPolicyContracts';
import { getApiBaseFor, fetchWithTimeout, LAUNCH_PAGE_TIMEOUT_MS } from './utils';

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

export interface SetupStatus {
	setupRequired: boolean;
}

import { getApiBase } from './utils';

export async function getLaunchPageConfig(): Promise<LaunchPageConfig | null> {
	return getLaunchPageConfigFrom();
}

export async function getLaunchPageConfigFrom(baseUrl?: string | null): Promise<LaunchPageConfig | null> {
	const res = await fetchWithTimeout(`${getApiBaseFor(baseUrl)}/api/public/launch-page`, {
		method: 'GET',
		timeoutMs: LAUNCH_PAGE_TIMEOUT_MS,
		retries: 2
	});
	if (!res.ok) return null;
	try {
		return await res.json();
	} catch {
		return null;
	}
}

export async function getPublicFrontendAppMetadata(baseUrl?: string | null): Promise<FrontendAppMetadataPolicy | null> {
	const res = await fetchWithTimeout(`${getApiBaseFor(baseUrl)}/api/public/frontend-app-metadata`, {
		method: 'GET',
		timeoutMs: LAUNCH_PAGE_TIMEOUT_MS,
		retries: 2
	});
	if (!res.ok) return null;
	try {
		return await res.json();
	} catch {
		return null;
	}
}

export async function getPublicAuthPolicy(baseUrl?: string | null): Promise<AuthPolicy> {
	const fallback: AuthPolicy = { mode: 'open', allowGuest: true, allowRegister: true, emailVerifyRequired: false };
	try {
		const res = await fetchWithTimeout(`${getApiBaseFor(baseUrl)}/api/public/auth-policy`, {
			method: 'GET', timeoutMs: LAUNCH_PAGE_TIMEOUT_MS, retries: 2
		});
		if (!res.ok) return fallback;
		const data = (await res.json()) as Partial<AuthPolicy>;
		return {
			mode: data.mode === 'invite' || data.mode === 'verified' ? data.mode : 'open',
			allowGuest: data.allowGuest !== false,
			allowRegister: data.allowRegister !== false,
			emailVerifyRequired: data.emailVerifyRequired === true
		};
	} catch {
		return fallback;
	}
}

export async function getPublicBackendEndpointsFrom(baseUrl?: string | null): Promise<PublicBackendEndpointsResponse | null> {
	const res = await fetchWithTimeout(`${getApiBaseFor(baseUrl)}/api/public/backend-endpoints`, {
		method: 'GET',
		timeoutMs: LAUNCH_PAGE_TIMEOUT_MS,
		retries: 2
	});
	if (!res.ok) return null;
	try {
		return await res.json();
	} catch {
		return null;
	}
}

export async function getSetupStatus(): Promise<SetupStatus> {
	try {
		const res = await fetchWithTimeout(`${getApiBase()}/api/setup/status`, {
			timeoutMs: 3000
		});
		if (!res.ok) return { setupRequired: false };
		return await res.json();
	} catch {
		return { setupRequired: false };
	}
}
