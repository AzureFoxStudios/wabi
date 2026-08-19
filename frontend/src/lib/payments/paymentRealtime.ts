export type PaymentRealtimeEventMap = {
	'payments:intent-updated': {
		workspaceId: string;
		intentId: string;
		status: string;
		channelId: string | null;
		isDonation: boolean;
	};
	'payments:donations-updated': {
		workspaceId: string;
		reason: string;
		intentId?: string | null;
		settlementId?: string | null;
		status?: string | null;
	};
	'payments:donations-admin-updated': {
		workspaceId: string;
		reason: string;
		intentId?: string | null;
		settlementId?: string | null;
		status?: string | null;
	};
	'payments:account-links-updated': {
		workspaceId: string;
	};
	'payments:user-blocks-updated': {
		workspaceId: string;
		userId?: number | null;
	};
	'payments:access-updated': {
		workspaceId: string;
		userId?: number | null;
	};
};

type EventName = keyof PaymentRealtimeEventMap;
type Listener<K extends EventName> = (detail: PaymentRealtimeEventMap[K]) => void;

const listeners = new Map<EventName, Set<(detail: unknown) => void>>();

export function emitPaymentRealtimeEvent<K extends EventName>(
	eventName: K,
	detail: PaymentRealtimeEventMap[K]
): void {
	const handlers = listeners.get(eventName);
	if (!handlers || handlers.size === 0) return;
	for (const handler of handlers) {
		try {
			handler(detail);
		} catch (error) {
			console.error(`[PaymentRealtime] listener failed for ${eventName}:`, error);
		}
	}
}

export function subscribePaymentRealtimeEvent<K extends EventName>(
	eventName: K,
	handler: Listener<K>
): () => void {
	const normalized = listeners.get(eventName) || new Set<(detail: unknown) => void>();
	normalized.add(handler as (detail: unknown) => void);
	listeners.set(eventName, normalized);
	return () => {
		const current = listeners.get(eventName);
		if (!current) return;
		current.delete(handler as (detail: unknown) => void);
		if (current.size === 0) {
			listeners.delete(eventName);
		}
	};
}
