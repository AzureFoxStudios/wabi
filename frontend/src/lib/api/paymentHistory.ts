import type { PaymentAccountLink } from '../../../../shared/adminPolicyContracts';
import { getApiBase, fetchWithTimeout, safeJsonParse } from './utils';
import type { PaymentIntent, PaymentEvent } from './paymentCheckout';

export interface PaymentHistoryResponse {
	success: boolean;
	count: number;
	intents: PaymentIntent[];
}

const ACCOUNT_LINKS_STORAGE_KEY = 'wabi.payment.account-links';

/**
 * Saved payment references are kept on-device for v1: the server's
 * account-links store is a persistence stub (handlers.rs no-op until the
 * WabiDB payment projection lands — roadmap Phase 1). Links are also mirrored
 * to the server best-effort so the ingest events start flowing now.
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
		// Storage full/blocked — references simply won't persist across reloads.
	}
}

export async function listPaymentAccountLinks(token: string | null | undefined): Promise<PaymentAccountLink[]> {
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
	// The server returns Rust-shaped intents (see paymentCheckout.mapIntent is
	// private); map inline to keep this self-contained.
	const intents: PaymentIntent[] = (Array.isArray(data.intents) ? data.intents : []).map(
		(raw: Record<string, any>) => {
			const qrPayload = typeof raw.promptpayQrPayload === 'string' ? raw.promptpayQrPayload : '';
			const status =
				raw.status === 'completed'
					? 'succeeded'
					: raw.status === 'rejected'
						? 'failed'
						: raw.status === 'expired'
							? 'expired'
							: 'pending';
			return {
				intentId: String(raw.id || ''),
				workspaceId: 'default-workspace',
				createdByUserId: typeof raw.userId === 'number' ? raw.userId : null,
				channelId: null,
				pluginId: 'promptpay',
				providerName: 'PromptPay',
				providerIntentId: null,
				amountMinor: Number(raw.amountMinor || 0),
				currency: String(raw.currency || 'THB').toUpperCase(),
				countryCode: 'TH',
				status,
				checkoutMode: 'qr' as const,
				customerRef: typeof raw.promptpayProxyId === 'string' ? raw.promptpayProxyId : null,
				description: typeof raw.note === 'string' ? raw.note : null,
				metadata: null,
				presentation: qrPayload ? { mode: 'qr', qrData: qrPayload } : null,
				failureCode: null,
				failureMessage: null,
				expiresAt: null,
				completedAt: null,
				refundedAt: null,
				createdAt: Number(raw.createdAt || 0),
				updatedAt: Number(raw.updatedAt || 0)
			};
		}
	);
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
