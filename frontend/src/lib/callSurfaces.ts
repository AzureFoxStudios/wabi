/**
 * Phase 4 — shared actions for the voice view page and the right-panel calls
 * controller. Both surfaces drive the SAME session model; these helpers keep
 * the button semantics identical in one place.
 */

import { get, writable } from 'svelte/store';
import {
	callSessionManager
} from './callSessionManager';
import { sessionBadge, sessionSilenced, type CallSession } from './callSessionTypes';
import { confirmLeaveWhileRecording } from './callRecording';
import { getSocket } from './socketConnection';
import { revokeGroupCall } from './calling_impl_core';
import { CallJoinOfflineError, createCallJoinTracker, type CallJoinMode } from './callJoinState';
import { selectWorkspaceView } from './workspaceNavigationState';
import { showToast } from './toast';
import { readConnectionDetailsPreference } from './components/settings/connectionDetailsSetting';
import {
	joinVoiceChannel,
	leaveVoiceChannel,
	toggleMute,
	toggleDeafen,
	toggleVideo,
	endCall,
	isMuted,
	isDeafened,
	isVideoOff
} from './calling';

export { sessionBadge };

const joins = createCallJoinTracker((channelId, error) => console.warn(`[Calls] join ${channelId} failed:`, error));

/**
 * Join and Listen in progress and the failures they left, per room (§8.5): the Calls page shows
 * "Joining…" (aria-busy) on the button that was pressed and an inline notice with Retry under
 * that row when it fails.
 */
export const callJoinAttempts = joins.attempts;

/**
 * Join a voice room ("Join") or listen in ("Listen": receive only). Resolves true once joined.
 * A failure is recorded in `callJoinAttempts` (and logged), never thrown, so a button handler
 * can fire and forget.
 *
 * Where your mic goes is decided by the calling runtime, never by this helper: "Join" sends the
 * mic to the room only when it is not already in another call (calling_impl_core joins a second
 * room listen-only), so the Calls page offers "Join" only then. Re-focusing the session model
 * here would relabel the mic without moving it.
 */
export function joinVoice(channelId: string, mode: CallJoinMode = 'join'): Promise<boolean> {
	return joins.run(channelId, mode, async () => {
		const socket = getSocket();
		if (!socket?.connected) throw new CallJoinOfflineError();
		await joinVoiceChannel(socket, channelId, mode === 'listen' ? { listenOnly: true } : {});
	});
}

/** Close a join failure notice. */
export function dismissJoinFailure(channelId: string): void {
	joins.dismiss(channelId);
}

/**
 * The Calls page's Connection details section (§8.5, §9.5: one surface). Opened from the Calls
 * masthead ⋯ and from the sidebar voice status row's options; it lives on the Calls page so
 * route, latency and packet loss are described in one place. It starts from this device's
 * "Show connection details during calls" preference, so the saved choice still holds after a
 * reload; the section itself only shows while you are in a call.
 */
export const callConnectionDetailsOpen = writable(readConnectionDetailsPreference());

/** Show Connection details on the Calls page (opening Calls in center stage when needed). */
export function openConnectionDetails(): void {
	callConnectionDetailsOpen.set(true);
	selectWorkspaceView('voice');
}

/** A leave that did not go through says so where the member is (the raw error is only logged). */
function reportLeaveFailure(room: string, error: unknown): void {
	console.warn('[Calls] leave failed:', error);
	showToast(room ? `Couldn't leave ${room}. Try again.` : "Couldn't leave the call. Try again.", 'error');
}

/**
 * Leave one call. `room` names it in the failure toast. Returns false when nothing was left
 * (the session changed, or the recording guard was declined).
 */
export function leaveCall(session: CallSession, room = ''): boolean {
	if (callSessionManager.get(session.id)?.joinedAt !== session.joinedAt) return false;
	const socket = getSocket();
	// Recording leave-guard (2026-08-27): leaving must never silently kill an
	// active recording — confirm first, then stop+save via the guard.
	if (!confirmLeaveWhileRecording()) return false;
	if (session.kind === 'channel') {
		leaveVoiceChannel(socket, session.channelId ?? session.id).catch((error) => reportLeaveFailure(room, error));
		return true;
	}
	if (session.kind === 'group' && !socket?.connected) {
		revokeGroupCall(session.channelId ?? session.id);
		return true;
	}
	if (!socket) {
		reportLeaveFailure(room, new Error('No server connection'));
		return false;
	}
	// DM / group calls end through the call lifecycle.
	try {
		endCall(socket);
		return true;
	} catch (error) {
		reportLeaveFailure(room, error);
		return false;
	}
}

/**
 * Show this call on the call stage (the session model's focus). It does not move your mic:
 * transmit routing follows calling_impl_core (`shouldTransmitToChannel`), so no surface offers
 * this as "Speak here" until a real primary switch exists.
 */
export function focusCall(sessionId: string): void {
	callSessionManager.setFocus(sessionId);
}

/** The last audible volume per call, so turning "Silence this call" off brings the sound back. */
const audibleVolume = new Map<string, number>();

/** Moving the volume above 0 makes a silenced call audible again (one silence, not two). */
export function setCallVolume(sessionId: string, volume: number): void {
	if (volume > 0) {
		audibleVolume.set(sessionId, volume);
		if (callSessionManager.get(sessionId)?.muted) callSessionManager.setSessionMuted(sessionId, false);
	}
	callSessionManager.setVolume(sessionId, volume);
}

/**
 * "Silence this call" (§7.26): one silence. Pressed while the call is silent, by this toggle or
 * at volume 0; turning it off unmutes the call and, at volume 0, restores the last audible volume.
 */
export function toggleCallSpeaker(sessionId: string): void {
	const session = callSessionManager.get(sessionId);
	if (!session) return;
	if (!sessionSilenced(session)) {
		callSessionManager.setSessionMuted(sessionId, true);
		return;
	}
	if (session.muted) callSessionManager.setSessionMuted(sessionId, false);
	if (session.volume <= 0) callSessionManager.setVolume(sessionId, audibleVolume.get(sessionId) ?? 100);
}

/** Global mic mute for every call (single capture, one switch). */
export function muteAllMic(): void {
	if (!get(isMuted)) toggleMute();
}

export function unmuteAllMic(): void {
	if (get(isMuted)) toggleMute();
}

/** Global deafen: stops all output everywhere. */
export function deafenAll(): void {
	if (!get(isDeafened)) toggleDeafen();
}

export function undeafenAll(): void {
	if (get(isDeafened)) toggleDeafen();
}

/** Camera is a singleton capture shared by all calls. */
export function cameraOff(): void {
	if (!get(isVideoOff)) toggleVideo();
}

/** Leave every connected call (channels + DM/group). */
export function leaveAllCalls(): void {
	const socket = getSocket();
	if (!socket) return;
	if (!confirmLeaveWhileRecording()) return;
	const sessions = callSessionManager.list();
	let endedCall = false;
	for (const session of sessions) {
		if (session.kind === 'channel') {
			leaveVoiceChannel(socket, session.channelId ?? session.id).catch((error) => reportLeaveFailure(session.name, error));
		} else if (!endedCall) {
			try {
				endCall(socket);
				endedCall = true;
			} catch {
				/* call already gone */
			}
		}
	}
}
