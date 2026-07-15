/**
 * callRecording.ts (unified re-export)
 * Maintains 100% backward compatibility
 *
 * Re-exports from:
 * - callRecordingTypes.ts: Type definitions and presets
 * - callRecordingUtils.ts: Utilities and helpers
 * - callRecordingAudio.ts: Audio mixing
 * - callRecordingVideo.ts: Video composition
 * - callRecordingArtifact.ts: Artifact creation and handling
 * - callRecordingSession.ts: Session management
 */

import { writable, get } from 'svelte/store';
import { getSocket } from './socket-manager';
import type { CallRecordingScope } from './callRecordingPresence';
import type {
	CallRecordingMode,
	CallRecordingPreset,
	CallRecordingSnapshot,
	CallRecordingStartOptions,
	CallRecordingState,
	RecordingScopeDescriptor
} from './callRecordingTypes';
import { INITIAL_STATE } from './callRecordingTypes';
import { CallRecordingSession, getCurrentSnapshot } from './callRecordingSession';
import {
	getDefaultMode,
	getDefaultPreset,
	getDefaultStemMode
} from './callRecordingUtils';
import { unlockAudioContext } from './callRecordingAudio';
import { uploadRecordingToLoreServer } from './loreRecording';

// ============================================================================
// RE-EXPORTS FROM callRecordingTypes.ts
// ============================================================================

export type { CallRecordingMode, CallRecordingPreset, CallRecordingStatus, CallRecordingState } from './callRecordingTypes';
export { INITIAL_STATE, PRESETS } from './callRecordingTypes';

// ============================================================================
// STATE & INTERNALS
// ============================================================================

export const callRecordingState = writable<CallRecordingState>({ ...INITIAL_STATE });

let currentSession: CallRecordingSession | null = null;
let recordingTimer: ReturnType<typeof setInterval> | null = null;

function startRecordingTimer(): void {
	if (recordingTimer) {
		clearInterval(recordingTimer);
	}
	recordingTimer = setInterval(() => {
		const state = get(callRecordingState);
		if (state.status !== 'recording' || !state.startedAt) return;
		callRecordingState.update((current) => ({
			...current,
			elapsedMs: Date.now() - (current.startedAt || Date.now())
		}));
	}, 500);
}

function stopRecordingTimer(): void {
	if (recordingTimer) {
		clearInterval(recordingTimer);
		recordingTimer = null;
	}
}

function resolveRecordingScope(snapshot: CallRecordingSnapshot): RecordingScopeDescriptor | null {
	if (!snapshot.isInCall || !snapshot.callMode) {
		return null;
	}

	if (snapshot.callMode === 'direct') {
		return { scope: 'direct' };
	}

	if (snapshot.callMode === 'group') {
		return snapshot.activeGroupCallId ? { scope: 'group', channelId: snapshot.activeGroupCallId } : null;
	}

	const voiceChannelIds = new Set(snapshot.listeningVoiceChannelIds);
	if (snapshot.activeVoiceChannelId) {
		voiceChannelIds.add(snapshot.activeVoiceChannelId);
	}

	return voiceChannelIds.size > 0 ? { scope: 'channel' } : null;
}

async function updateRecordingPresence(active: boolean, snapshot = getCurrentSnapshot()): Promise<void> {
	const socket = getSocket();
	if (!socket) {
		if (active) {
			throw new Error('Recording requires an active socket connection.');
		}
		return;
	}

	const scope = active ? resolveRecordingScope(snapshot) : null;
	if (active && !scope) {
		throw new Error('Unable to determine the active call scope for recording transparency.');
	}

	const payload = active
		? {
			active,
			scope: scope?.scope,
			channelId: scope?.channelId
		}
		: { active };

	await new Promise<void>((resolve, reject) => {
		socket.emit(
			'call-recording-set-active',
			payload,
			(response?: { ok?: boolean; error?: string }) => {
				if (response?.ok) {
					resolve();
					return;
				}
				reject(new Error(response?.error || 'Failed to publish recording presence.'));
			}
		);
	});
}

// ============================================================================
// PUBLIC API
// ============================================================================

export async function startCallRecording(options: CallRecordingStartOptions = {}): Promise<void> {
	if (currentSession) {
		throw new Error('A call recording is already active.');
	}

	// Unlock audio output within the user gesture so the per-mixer AudioContext
	// instances start in the `running` state (otherwise recordings are silent).
	unlockAudioContext();

	const snapshot = getCurrentSnapshot();
	const mode = options.mode || getDefaultMode(snapshot);
	const preset = options.preset || getDefaultPreset(mode);
	const respectLocalMute = options.respectLocalMute ?? null;
	const stemMode = options.stemMode || getDefaultStemMode();

	callRecordingState.set({
		...INITIAL_STATE,
		status: 'recording',
		mode,
		preset,
		stemMode,
		startedAt: Date.now(),
		elapsedMs: 0,
		lastError: null
	});

	try {
		await updateRecordingPresence(true, snapshot);
		currentSession = await CallRecordingSession.create({
			mode,
			preset,
			stemMode,
			respectLocalMute
		});
		const sessionState = currentSession.getState();
		callRecordingState.update((current) => ({
			...current,
			mode: sessionState.mode,
			preset: sessionState.preset,
			stemMode: sessionState.stemMode,
			startedAt: sessionState.startedAt,
			mimeType: sessionState.mimeType,
			fileName: sessionState.fileName
		}));
		startRecordingTimer();
	} catch (error) {
		await updateRecordingPresence(false).catch(() => undefined);
		currentSession = null;
		stopRecordingTimer();
		callRecordingState.set({
			...INITIAL_STATE,
			status: 'error',
			lastError: error instanceof Error ? error.message : 'Failed to start call recording.'
		});
		throw error;
	}
}

export async function stopCallRecording(): Promise<void> {
	if (!currentSession) return;
	const session = currentSession;
	currentSession = null;
	stopRecordingTimer();
	await updateRecordingPresence(false).catch(() => undefined);
	callRecordingState.update((current) => ({
		...current,
		status: 'saving'
	}));
	try {
		const exported = await session.stop();
		const fileName = get(callRecordingState).fileName;
		callRecordingState.update((current) => ({
			...current,
			status: 'idle',
			savedPath: exported.savedPath,
			savedPaths: exported.savedPaths,
			savedFileCount: exported.savedFileCount,
			saveTarget: exported.saveTarget,
			elapsedMs: current.startedAt ? Date.now() - current.startedAt : current.elapsedMs
		}));

		// Optional: auto-upload the main recording to the Lore "Recordings" channel.
		if (exported.mainBlob && fileName) {
			void uploadRecordingToLore(exported.mainBlob, fileName);
		}

		window.setTimeout(() => {
			callRecordingState.update((current) => ({
				...INITIAL_STATE,
				savedPath: current.savedPath,
				savedPaths: current.savedPaths,
				savedFileCount: current.savedFileCount,
				saveTarget: current.saveTarget,
				// Preserve Lore upload status across the 6s reset so an
				// in-flight or completed upload stays visible.
				loreUploadStatus: current.loreUploadStatus,
				loreUploadError: current.loreUploadError,
				loreUploadedPath: current.loreUploadedPath
			}));
		}, 6_000);
	} catch (error) {
		callRecordingState.set({
			...INITIAL_STATE,
			status: 'error',
			lastError: error instanceof Error ? error.message : 'Failed to save call recording.'
		});
		throw error;
	}
}

export function refreshCallRecordingMix(): void {
	currentSession?.refresh();
}

/**
 * Fire-and-forget upload of the main recording to the Lore Recordings channel.
 * Updates the shared recording state with the upload progress/result.
 */
async function uploadRecordingToLore(blob: Blob, fileName: string): Promise<void> {
	callRecordingState.update((current) => ({
		...current,
		loreUploadStatus: 'uploading',
		loreUploadError: null,
		loreUploadedPath: null
	}));
	try {
		const outcome = await uploadRecordingToLoreServer(blob, fileName);
		callRecordingState.update((current) => {
			switch (outcome.status) {
				case 'done':
					return { ...current, loreUploadStatus: 'done', loreUploadedPath: outcome.path };
				case 'no-channel':
					return { ...current, loreUploadStatus: 'no-channel' };
				case 'error':
					return { ...current, loreUploadStatus: 'error', loreUploadError: outcome.message };
				case 'unavailable':
				default:
					return { ...current, loreUploadStatus: 'none' };
			}
		});
	} catch (error) {
		callRecordingState.update((current) => ({
			...current,
			loreUploadStatus: 'error',
			loreUploadError: error instanceof Error ? error.message : 'Upload failed'
		}));
	}
}
