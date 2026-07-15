/**
 * loreRecording.ts
 *
 * Optional auto-upload of finished call recordings to the Lore "Recordings"
 * Asset Storage channel.
 *
 * This module is the ONLY place the call-recording core touches Lore. The core
 * module (callRecording.ts) stays Lore-agnostic and just calls
 * `uploadRecordingToLoreServer`.
 *
 * The Lore addon is a server-side Rust feature (`--features wabi-lore`). On a
 * minimal server the routes don't exist, so we runtime-guard via
 * `checkLoreHealth` and silently no-op when the addon is absent. The shared
 * client therefore does nothing on a minimal deployment and "lights up" only
 * when its server is built with Lore.
 */

import { fetchWithTimeout } from './api/utils';
import { loreUrl, checkLoreHealth } from './api/lore';
import { getAuthToken } from './authSession';

export type LoreUploadOutcome =
	| { status: 'done'; path: string }
	| { status: 'no-channel' }
	| { status: 'error'; message: string }
	| { status: 'unavailable' };

// Cache the Lore availability check so we only hit /health once per session.
let loreAvailable: boolean | null = null;

async function isLoreAvailable(): Promise<boolean> {
	if (loreAvailable !== null) return loreAvailable;
	const token = getAuthToken();
	if (!token) {
		loreAvailable = false;
		return false;
	}
	try {
		const res = await checkLoreHealth(token);
		loreAvailable = res.status === 'ok';
	} catch {
		loreAvailable = false;
	}
	return loreAvailable;
}

/**
 * Upload a finished recording blob to the server-resolved "Recordings" channel.
 *
 * The target channel is resolved server-side by name, so the client only needs
 * to POST the file bytes. Returns a discriminated outcome the caller maps to UI
 * state.
 */
export async function uploadRecordingToLoreServer(
	blob: Blob,
	fileName: string
): Promise<LoreUploadOutcome> {
	if (!(await isLoreAvailable())) {
		return { status: 'unavailable' };
	}
	const token = getAuthToken();
	if (!token) {
		return { status: 'unavailable' };
	}

	const file = new File([blob], fileName, { type: blob.type });
	const params = new URLSearchParams();
	params.set('filename', fileName);
	params.set('message', `Call recording ${fileName}`);
	const url = `${loreUrl('/recordings')}?${params.toString()}`;

	try {
		const res = await fetchWithTimeout(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/octet-stream'
			},
			body: await file.arrayBuffer()
		});

		// The operator has not created the Recordings channel yet.
		if (res.status === 404) {
			return { status: 'no-channel' };
		}
		if (!res.ok) {
			const err = (await res.json().catch(() => ({}))) as { error?: string };
			return { status: 'error', message: err.error || `Upload failed (${res.status})` };
		}
		const data = (await res.json().catch(() => ({}))) as { path?: string };
		return { status: 'done', path: data.path || fileName };
	} catch (error) {
		return {
			status: 'error',
			message: error instanceof Error ? error.message : 'Upload failed'
		};
	}
}

/** Reset the cached availability check (e.g. on logout / server switch). */
export function resetLoreRecordingCache(): void {
	loreAvailable = null;
}
