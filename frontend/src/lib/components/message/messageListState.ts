import { writable, derived, get } from 'svelte/store';
import { animationPassStore, type AnimationPassPreset } from '$lib/animationPass';
import { gifCaptionerSettingsStore } from '$lib/gifCaptionerSettings';

export const MESSAGE_RENDER_BATCH = 120;
export const MESSAGE_RENDER_MAX = 360;
export const MESSAGE_ANIMATION_BURST_WINDOW_MS = 600;
export const MESSAGE_ANIMATION_BURST_THRESHOLD = 3;
export const MESSAGE_ANIMATION_BURST_COOLDOWN_MS = 900;

export function createMessageListRenderState() {
	const messageRenderLimit = writable(MESSAGE_RENDER_BATCH);
	const lastChannelForRenderWindow = writable<string | null>(null);
	const lastObservedMessageCount = writable(0);
	const lastObservedLastMessageId = writable<string | null>(null);
	const burstArrivalTimestamps = writable<number[]>([]);
	const burstAnimationSuppressed = writable(false);
	const burstAnimationResetHandle = writable<number | null>(null);

	const messageAnimation = derived(animationPassStore, ($store) => {
		const baseDuration = $store.level === 'full' ? 260 : 190;
		const baseDistance = $store.level === 'full' ? 20 : 14;
		return {
			enabled: $store.enabled,
			preset: $store.preset as AnimationPassPreset,
			duration: Math.max(0, Math.round(baseDuration * $store.durationMultiplier)),
			distance: Math.max(0, Math.round(baseDistance * $store.durationMultiplier))
		};
	});

	const gifCaptionStyleClass = derived(gifCaptionerSettingsStore, ($store) => {
		const style = $store.captionStyle;
		if (style === 'accent') return 'style-accent';
		if (style === 'card') return 'style-card';
		return 'style-plain';
	});

	function clearBurstAnimationReset(): void {
		const handle = get(burstAnimationResetHandle);
		if (handle !== null) {
			window.clearTimeout(handle);
			burstAnimationResetHandle.set(null);
		}
	}

	function scheduleBurstAnimationReset(): void {
		clearBurstAnimationReset();
		const newHandle = window.setTimeout(() => {
			burstAnimationSuppressed.set(false);
			burstAnimationResetHandle.set(null);
		}, MESSAGE_ANIMATION_BURST_COOLDOWN_MS);
		burstAnimationResetHandle.set(newHandle);
	}

	function recordMessageBurst(additions: number): void {
		if (typeof window === 'undefined' || additions <= 0) return;
		const now = Date.now();
		burstArrivalTimestamps.update((timestamps) => {
			const updated = [...timestamps];
			for (let i = 0; i < additions; i++) {
				updated.push(now);
			}
			return updated.filter((ts) => now - ts <= MESSAGE_ANIMATION_BURST_WINDOW_MS);
		});
		if (get(burstArrivalTimestamps).length >= MESSAGE_ANIMATION_BURST_THRESHOLD) {
			burstAnimationSuppressed.set(true);
			scheduleBurstAnimationReset();
		}
	}

	function resetForNewChannel(channelId: string | null): void {
		lastChannelForRenderWindow.set(channelId);
		messageRenderLimit.set(MESSAGE_RENDER_BATCH);
		lastObservedMessageCount.set(0);
		lastObservedLastMessageId.set(null);
	}

	return {
		messageRenderLimit,
		lastChannelForRenderWindow,
		lastObservedMessageCount,
		lastObservedLastMessageId,
		burstArrivalTimestamps,
		burstAnimationSuppressed,
		burstAnimationResetHandle,
		messageAnimation,
		gifCaptionStyleClass,
		clearBurstAnimationReset,
		scheduleBurstAnimationReset,
		recordMessageBurst,
		resetForNewChannel
	};
}
