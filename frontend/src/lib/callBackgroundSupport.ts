import { derived, type Readable } from 'svelte/store';
import { activeCallSessionId, activeVoiceChannel, isInCall } from './callingStateStores';
import { resumeCallAudioGraph } from './callAudioGraph';

/**
 * Keep a live call usable when the user leaves the app.
 *
 * Leaving a call screen for the home screen or another app is normal on a
 * phone. The web platform gives a PWA a few levers, all best-effort:
 *
 * - Screen Wake Lock: stops the screen timing out mid-call. The browser
 *   releases it whenever the page is hidden, so it is re-acquired on return.
 * - Media Session: marks the page as actively playing media, which lets
 *   Android show system media controls and treat the page as foreground-ish
 *   audio rather than a throwaway tab.
 * - Audio resume: a backgrounded AudioContext comes back suspended (or
 *   'interrupted' on iOS) and the call goes silently deaf unless it is
 *   resumed when the app is visible again.
 *
 * None of this can keep capture alive on platforms that suspend background
 * microphones (notably iOS PWAs); the installed APK/desktop app is the answer
 * there. Everything degrades silently when an API is missing.
 */
export interface CallBackgroundDeps {
	active: Readable<boolean>;
	doc?: Document;
	nav?: Navigator;
	resumeAudio: () => Promise<boolean>;
	title: () => string;
}

export function callIsActive(): Readable<boolean> {
	return derived(
		[isInCall, activeVoiceChannel, activeCallSessionId],
		([$inCall, $voice, $session]) => Boolean($inCall || $voice || $session)
	);
}

type WakeLockSentinelLike = { release(): Promise<void>; addEventListener?(type: 'release', cb: () => void): void };

export function installCallBackgroundSupport(deps?: Partial<CallBackgroundDeps>): () => void {
	const doc = deps?.doc ?? (typeof document === 'undefined' ? undefined : document);
	const nav = deps?.nav ?? (typeof navigator === 'undefined' ? undefined : navigator);
	if (!doc || !nav) return () => {};
	const active = deps?.active ?? callIsActive();
	const resumeAudio = deps?.resumeAudio ?? resumeCallAudioGraph;
	const title = deps?.title ?? (() => 'Call in progress');

	let inCall = false;
	let lock: WakeLockSentinelLike | null = null;
	let acquiring = false;

	const acquireWakeLock = async (): Promise<void> => {
		const api = (nav as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } }).wakeLock;
		if (!api || !inCall || lock || acquiring || doc.visibilityState === 'hidden') return;
		acquiring = true;
		try {
			const sentinel = await api.request('screen');
			if (!inCall) { await sentinel.release().catch(() => undefined); return; }
			lock = sentinel;
			sentinel.addEventListener?.('release', () => { if (lock === sentinel) lock = null; });
		} catch {
			// Denied (battery saver, permissions policy): the call still works.
		} finally {
			acquiring = false;
		}
	};
	const releaseWakeLock = (): void => {
		const held = lock; lock = null;
		void held?.release().catch(() => undefined);
	};

	const setMediaSession = (on: boolean): void => {
		const session = (nav as Navigator & { mediaSession?: MediaSession }).mediaSession;
		if (!session) return;
		try {
			if (on) {
				if (typeof MediaMetadata !== 'undefined') {
					session.metadata = new MediaMetadata({ title: title(), artist: 'Wabi', album: 'Call' });
				}
				session.playbackState = 'playing';
			} else {
				session.playbackState = 'none';
				session.metadata = null;
			}
		} catch {
			// Optional enhancement only.
		}
	};

	const onVisibility = (): void => {
		if (!inCall || doc.visibilityState === 'hidden') return;
		void resumeAudio().catch(() => false);
		void acquireWakeLock();
	};

	const unsubscribe = active.subscribe((value) => {
		if (value === inCall) return;
		inCall = value;
		setMediaSession(value);
		if (value) void acquireWakeLock();
		else releaseWakeLock();
	});
	doc.addEventListener('visibilitychange', onVisibility);
	const win = typeof window === 'undefined' ? undefined : window;
	win?.addEventListener('pageshow', onVisibility);

	return () => {
		unsubscribe();
		doc.removeEventListener('visibilitychange', onVisibility);
		win?.removeEventListener('pageshow', onVisibility);
		releaseWakeLock();
		if (inCall) setMediaSession(false);
		inCall = false;
	};
}
