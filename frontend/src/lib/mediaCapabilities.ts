/**
 * What this runtime can do for calls. Read when a call needs it, never at
 * import, and kept free of `$app` imports so tests and workers can load it.
 *
 * The Linux desktop app runs in WebKitGTK, which every major distro builds
 * without WebRTC: there is no `RTCPeerConnection`, so direct P2P calls,
 * LiveKit and P2P file transfer cannot work there. The relay needs none of it.
 * Evidence: docs/plans/2026-11-20-linux-desktop-media.md.
 */

export function hasPeerConnection(): boolean {
	return typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection === 'function';
}

/** Shown wherever something that needs a peer connection is refused. */
export const PEER_CONNECTION_UNAVAILABLE =
	"This app's web engine has no WebRTC, so direct (P2P) and LiveKit connections are unavailable here.";

/** Throws the refusal instead of a ReferenceError from `new RTCPeerConnection`. */
export function requirePeerConnection(): void {
	if (!hasPeerConnection()) throw new Error(PEER_CONNECTION_UNAVAILABLE);
}

/** WebKitGTK or WPE: WebKit on Linux that is neither Chromium nor Android. */
export function isWebKitGtk(
	userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent
): boolean {
	return /\bLinux\b/.test(userAgent) && /AppleWebKit/.test(userAgent) && !/Chrome|Chromium|Android/.test(userAgent);
}

/**
 * Builds the guard below. `createContext` returns a live WebGL context or
 * null; it runs at most once, and only when `needsGuard()` is true.
 */
export function createVideoCodecGlGuard(needsGuard: () => boolean, createContext: () => unknown): () => boolean {
	let state: 'unknown' | 'ready' | 'unavailable' = 'unknown';
	let context: unknown = null; // held so the context, and its GL display, is not collected
	return () => {
		if (!needsGuard()) return true;
		if (state === 'unknown') {
			try {
				context = createContext();
			} catch {
				context = null;
			}
			state = context ? 'ready' : 'unavailable';
		}
		return state === 'ready';
	};
}

/**
 * Call immediately before the first `VideoEncoder` or `VideoDecoder` use.
 * False means video must not be attempted in this page.
 *
 * WebKitGTK 2.54 aborts the whole web process when WebCodecs video runs
 * before the page has a GL display, which happens when the DMABUF renderer is
 * disabled (a common NVIDIA workaround). One WebGL context gives it that
 * display. It costs about 8 MB, so it is created on first video use only.
 */
export const ensureVideoCodecGlDisplay = createVideoCodecGlGuard(isWebKitGtk, () => {
	const canvas = document.createElement('canvas');
	canvas.width = 1;
	canvas.height = 1;
	return canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl');
});
