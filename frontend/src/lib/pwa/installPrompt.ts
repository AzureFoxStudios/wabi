/**
 * Capture beforeinstallprompt and expose install() for in-app Install UI.
 */
import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';

export type BeforeInstallPromptEvent = Event & {
	prompt: () => Promise<void>;
	userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

const deferredPrompt = writable<BeforeInstallPromptEvent | null>(null);
export const canInstallPwa = writable(false);
export const installOutcome = writable<'accepted' | 'dismissed' | null>(null);

const DISMISS_KEY = 'wabi.pwa.installBannerDismissedAt';
const DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

let listening = false;

export function startInstallPromptCapture(): () => void {
	if (!browser || listening) return () => {};
	listening = true;

	const onBip = (event: Event) => {
		event.preventDefault();
		const bip = event as BeforeInstallPromptEvent;
		deferredPrompt.set(bip);
		canInstallPwa.set(true);
	};

	const onInstalled = () => {
		deferredPrompt.set(null);
		canInstallPwa.set(false);
		installOutcome.set('accepted');
	};

	window.addEventListener('beforeinstallprompt', onBip);
	window.addEventListener('appinstalled', onInstalled);

	return () => {
		window.removeEventListener('beforeinstallprompt', onBip);
		window.removeEventListener('appinstalled', onInstalled);
		listening = false;
	};
}

export function isInstallBannerDismissed(): boolean {
	if (!browser) return true;
	try {
		const raw = localStorage.getItem(DISMISS_KEY);
		if (!raw) return false;
		const at = parseInt(raw, 10);
		if (!Number.isFinite(at)) return false;
		return Date.now() - at < DISMISS_COOLDOWN_MS;
	} catch {
		return false;
	}
}

export function dismissInstallBanner(): void {
	if (!browser) return;
	try {
		localStorage.setItem(DISMISS_KEY, String(Date.now()));
	} catch {
		/* ignore */
	}
	canInstallPwa.set(false);
}

export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
	const event = get(deferredPrompt);
	if (!event) return 'unavailable';
	try {
		await event.prompt();
		const choice = await event.userChoice;
		installOutcome.set(choice.outcome);
		deferredPrompt.set(null);
		canInstallPwa.set(false);
		return choice.outcome;
	} catch (err) {
		console.warn('[pwa] install prompt failed', err);
		return 'unavailable';
	}
}
