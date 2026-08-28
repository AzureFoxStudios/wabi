/**
 * Phase 4 — shared actions for the voice view page and the right-panel calls
 * controller. Both surfaces drive the SAME session model; these helpers keep
 * the button semantics identical in one place.
 */

import { get } from 'svelte/store';
import {
	callSessionManager
} from './callSessionManager';
import { sessionBadge, type CallSession } from './callSessionTypes';
import { confirmLeaveWhileRecording } from './callRecording';
import { getSocket } from './socketConnection';
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

export function joinVoice(channelId: string): void {
	const socket = getSocket();
	if (!socket?.connected) return;
	void joinVoiceChannel(socket, channelId).catch((err) =>
		console.warn('[VoiceView] join failed:', err)
	);
}

export function leaveCall(session: CallSession): void {
	const socket = getSocket();
	if (!socket) return;
	// Recording leave-guard (2026-08-27): leaving must never silently kill an
	// active recording — confirm first, then stop+save via the guard.
	if (!confirmLeaveWhileRecording()) return;
	if (session.kind === 'channel') {
		void leaveVoiceChannel(socket, session.channelId ?? session.id);
		return;
	}
	// DM / group calls end through the call lifecycle.
	try {
		endCall(socket);
	} catch (err) {
		console.warn('[VoiceView] endCall failed:', err);
	}
}

export function focusCall(sessionId: string): void {
	callSessionManager.setFocus(sessionId);
}

export function setCallVolume(sessionId: string, volume: number): void {
	callSessionManager.setVolume(sessionId, volume);
}

export function toggleCallSpeaker(sessionId: string): void {
	const session = callSessionManager.get(sessionId);
	if (!session) return;
	callSessionManager.setSessionMuted(sessionId, !session.muted);
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
			void leaveVoiceChannel(socket, session.channelId ?? session.id);
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
