import type { PaymentAccountLink } from '../../../../shared/adminPolicyContracts';
import { getApiBase, fetchWithTimeout, safeJsonParse } from './utils';
import type { PaymentIntent, PaymentEvent } from './paymentCheckout';
import { mapIntent } from './paymentCheckout';

export interface PaymentHistoryResponse {
	success: boolean;
	count: number;
	intents: PaymentIntent[];
}

const ACCOUNT_LINKS_STORAGE_KEY = 'wabi.payment.account-links';

/**
 * Saved payment references live on the server since the Phase 1 payment
 * projection (scoped per user). The localStorage copy is a write-through
 * cache so the sheet keeps working offline / against older servers.
 */
function readStoredAccountLinks(): PaymentAccountLink[] {
	if (typeof localStorage === 'undefined') return [];
	try {
		const raw = localStorage.getItem(ACCOUNT_LINKS_STORAGE_KEY);
		const parsed = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed) ? (parsed as PaymentAccountLink[]) : [];
	} catch {
		return [];
	}
}

function writeStoredAccountLinks(links: PaymentAccountLink[]): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(ACCOUNT_LINKS_STORAGE_KEY, JSON.stringify(links));
	} catch {
		// Storage full/blocked — the server copy remains authoritative.
	}
}

export async function listPaymentAccountLinks(token: string | null | undefined): Promise<PaymentAccountLink[]> {
	if (!token) return [];
	try {
		const res = await fetchWithTimeout(`${getApiBase()}/api/payments/account-links`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${token}` }
		});
		const data = (await safeJsonParse(res)) as Record<string, any>;
		if (res.ok && Array.isArray(data.links)) {
			const links = (data.links as PaymentAccountLink[]).filter(
				(link) => Boolean(link.pluginId && link.providerAccountRef)
			);
			writeStoredAccountLinks(links);
			return links;
		}
	} catch {
		// Offline / old server — fall back to the device cache.
	}
	return readStoredAccountLinks().filter((link) => Boolean(link.pluginId && link.providerAccountRef));
}

export async function listPaymentHistory(
	token: string | null | undefined,
	limit = 200
): Promise<PaymentHistoryResponse> {
	void limit; // server returns the caller's intents; windowing lands with Phase 1
	const res = await fetchWithTimeout(`${getApiBase()}/api/payments/intents`, {
		method: 'GET',
		headers: token ? { Authorization: `Bearer ${token}` } : undefined
	});
	const data = (await safeJsonParse(res)) as Record<string, any>;
	if (!res.ok) {
		throw new Error(data.error || 'Failed to load payment history');
	}
	// The server returns Rust-shaped intents; reuse the canonical mapper from
	// paymentCheckout so all rails (promptpay/crypto/EPC/US) map identically.
	const intents: PaymentIntent[] = (Array.isArray(data.intents) ? data.intents : []).map(mapIntent);
	return { success: true, count: intents.length, intents };
}

export async function upsertPaymentAccountLink(
	token: string | null | undefined,
	payload: { pluginId: string; providerAccountRef: string; displayLabel?: string; metadata?: Record<string, any> }
): Promise<PaymentAccountLink> {
	const now = Date.now();
	const existing = readStoredAccountLinks().find((link) => link.pluginId === payload.pluginId);
	const link: PaymentAccountLink = {
		userId: existing?.userId ?? 0,
		workspaceId: existing?.workspaceId ?? 'default-workspace',
		pluginId: payload.pluginId,
		providerAccountRef: payload.providerAccountRef,
		displayLabel: payload.displayLabel ?? null,
		metadata: payload.metadata ?? null,
		linkedAt: existing?.linkedAt ?? now,
		updatedAt: now
	};
	writeStoredAccountLinks([
		link,
		...readStoredAccountLinks().filter((item) => item.pluginId !== payload.pluginId)
	]);
	// Best-effort server mirror (no-op store today; real projection in Phase 1).
	if (token) {
		try {
			await fetchWithTimeout(`${getApiBase()}/api/payments/account-links`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(payload)
			});
		} catch {
			// Local persistence already succeeded; server sync is opportunistic.
		}
	}
	return link;
}

export async function deletePaymentAccountLink(token: string | null | undefined, pluginId: string): Promise<boolean> {
	writeStoredAccountLinks(readStoredAccountLinks().filter((link) => link.pluginId !== pluginId));
	if (token) {
		try {
			await fetchWithTimeout(`${getApiBase()}/api/payments/account-links/${encodeURIComponent(pluginId)}`, {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${token}` }
			});
		} catch {
			// Local removal already succeeded; server sync is opportunistic.
		}
	}
	return true;
}

export type { PaymentEvent };
