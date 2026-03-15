export interface PaymentIntentRealtimeUpdate {
	workspaceId: string;
	intentId: string;
	createdByUserId: number | null;
	channelId: string | null;
	status: string;
	isDonation: boolean;
}

export interface DonationRealtimeUpdate {
	workspaceId: string;
	reason:
		| 'intent'
		| 'refund'
		| 'config'
		| 'offline_recorded'
		| 'offline_voided';
	intentId?: string | null;
	settlementId?: string | null;
	status?: string | null;
}

export interface ManualCashRealtimeUpdate {
	workspaceId: string;
	settlementId: string;
	channelId: string;
	participantUserIds: number[];
	status: string;
}

export interface PaymentAccountLinksRealtimeUpdate {
	workspaceId: string;
	userId: number;
}

export interface PaymentUserBlocksRealtimeUpdate {
	workspaceId: string;
	userId: number;
}

export interface PaymentAccessRealtimeUpdate {
	workspaceId: string;
	userId?: number | null;
}

export interface PaymentRealtimeNotifier {
	notifyPaymentIntentUpdated(update: PaymentIntentRealtimeUpdate): void;
	notifyDonationUpdated(update: DonationRealtimeUpdate): void;
	notifyManualCashUpdated(update: ManualCashRealtimeUpdate): void;
	notifyPaymentAccountLinksUpdated(update: PaymentAccountLinksRealtimeUpdate): void;
	notifyPaymentUserBlocksUpdated(update: PaymentUserBlocksRealtimeUpdate): void;
	notifyPaymentAccessUpdated(update: PaymentAccessRealtimeUpdate): void;
}

const noopNotifier: PaymentRealtimeNotifier = {
	notifyPaymentIntentUpdated() {},
	notifyDonationUpdated() {},
	notifyManualCashUpdated() {},
	notifyPaymentAccountLinksUpdated() {},
	notifyPaymentUserBlocksUpdated() {},
	notifyPaymentAccessUpdated() {}
};

let activeNotifier: PaymentRealtimeNotifier = noopNotifier;

export function setPaymentRealtimeNotifier(notifier: PaymentRealtimeNotifier | null | undefined): void {
	activeNotifier = notifier || noopNotifier;
}

export function notifyPaymentIntentUpdated(update: PaymentIntentRealtimeUpdate): void {
	activeNotifier.notifyPaymentIntentUpdated(update);
}

export function notifyDonationUpdated(update: DonationRealtimeUpdate): void {
	activeNotifier.notifyDonationUpdated(update);
}

export function notifyManualCashUpdated(update: ManualCashRealtimeUpdate): void {
	activeNotifier.notifyManualCashUpdated(update);
}

export function notifyPaymentAccountLinksUpdated(update: PaymentAccountLinksRealtimeUpdate): void {
	activeNotifier.notifyPaymentAccountLinksUpdated(update);
}

export function notifyPaymentUserBlocksUpdated(update: PaymentUserBlocksRealtimeUpdate): void {
	activeNotifier.notifyPaymentUserBlocksUpdated(update);
}

export function notifyPaymentAccessUpdated(update: PaymentAccessRealtimeUpdate): void {
	activeNotifier.notifyPaymentAccessUpdated(update);
}
