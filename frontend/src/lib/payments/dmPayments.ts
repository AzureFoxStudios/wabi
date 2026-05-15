import { writable } from 'svelte/store';
import type { User } from '$lib/socket';
import type { Channel } from '$lib/socket';

// Payment state
export const paymentSheetOpen = writable(false);
export const paymentSheetOpenSeed = writable(0);
export const manualCashOpen = writable(false);

// Derived stores would typically be defined where they're used
// since they depend on other stores like $currentUser, $channels, etc.

// Payment functions
export function openPaymentSheet(paymentButtonEnabled: boolean): void {
	if (!paymentButtonEnabled) {
		alert('Sign in with a registered account to create payments.');
		return;
	}
	paymentSheetOpenSeed.update(n => n + 1);
	paymentSheetOpen.set(true);
}

export function openManualCashModal(paymentButtonEnabled: boolean, isGroup: boolean): void {
	if (!paymentButtonEnabled) {
		alert('Sign in with a registered account to track manual cash trades.');
		return;
	}
	if (isGroup) {
		alert('Manual cash trades are only available in direct messages.');
		return;
	}
	manualCashOpen.set(true);
}

export function clearConversationPaymentLaunch() {
	// This would interact with the paymentLaunch store
	// For now, we'll leave this as a placeholder since the actual implementation
	// would depend on the paymentLaunch module
}

// Helper functions that could be moved to this module
export function getPaymentTargetLabel(isGroup: boolean, channel: Channel | undefined, otherUser: User): string {
	return isGroup 
		? channel?.name || 'Group DM' 
		: `DM with ${otherUser.username}`;
}

export function isPaymentButtonEnabled(currentUser: User | null): boolean {
	return Boolean(currentUser?.dbUserId) && Boolean(/* getAuthToken() */ true); // Simplified for module
}