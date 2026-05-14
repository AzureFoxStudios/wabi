import { writable } from 'svelte/store';

export type ConversationPaymentSurface = 'payment_request' | 'manual_cash';

export type PendingConversationPaymentLaunch = {
	surface: ConversationPaymentSurface;
	targetUserId: string;
	targetDbUserId: number | null;
	requestedAt: number;
};

export const pendingConversationPaymentLaunch = writable<PendingConversationPaymentLaunch | null>(
	null
);

export function queueConversationPaymentLaunch(params: {
	surface: ConversationPaymentSurface;
	targetUserId: string;
	targetDbUserId?: number | null;
}): void {
	pendingConversationPaymentLaunch.set({
		surface: params.surface,
		targetUserId: params.targetUserId,
		targetDbUserId:
			typeof params.targetDbUserId === 'number' && Number.isFinite(params.targetDbUserId)
				? params.targetDbUserId
				: null,
		requestedAt: Date.now()
	});
}

export function clearConversationPaymentLaunch(): void {
	pendingConversationPaymentLaunch.set(null);
}

export function doesConversationPaymentLaunchMatch(
	launch: PendingConversationPaymentLaunch | null,
	user: { id: string; dbUserId?: number | null } | null | undefined
): boolean {
	if (!launch || !user) return false;
	if (launch.targetUserId === user.id) return true;
	return (
		typeof launch.targetDbUserId === 'number' &&
		typeof user.dbUserId === 'number' &&
		launch.targetDbUserId === user.dbUserId
	);
}
