import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { writable } from 'svelte/store';

/**
 * The shared call actions behind the Calls page, the companion rows and the sidebar status row
 * (callSurfaces.ts). The calling runtime is stubbed: these tests pin what the surfaces do to the
 * session model and what a member is told, not media.
 */

const joined: Array<{ channelId: string; options: unknown }> = [];
const toasts: string[] = [];
let leaveFails = false;

mock.module('./calling', () => ({
	joinVoiceChannel: async (_socket: unknown, channelId: string, options: unknown) => {
		joined.push({ channelId, options });
		return null;
	},
	leaveVoiceChannel: async () => {
		if (leaveFails) throw new Error('socket closed');
	},
	toggleMute: () => {},
	toggleDeafen: () => {},
	toggleVideo: async () => {},
	endCall: () => {},
	isMuted: writable(false),
	isDeafened: writable(false),
	isVideoOff: writable(true)
}));
mock.module('./socketConnection', () => ({ getSocket: () => ({ connected: true }) }));
mock.module('./calling_impl_core', () => ({ revokeGroupCall: () => {} }));
mock.module('./callRecording', () => ({ confirmLeaveWhileRecording: () => true }));
mock.module('./workspaceNavigationState', () => ({ selectWorkspaceView: () => {} }));
mock.module('./toast', () => ({ showToast: (message: string) => toasts.push(message) }));

const { callSessionManager } = await import('./callSessionManager');
const { joinVoice, leaveCall, setCallVolume, toggleCallSpeaker } = await import('./callSurfaces');
const { sessionSilenced } = await import('./callSessionTypes');

function room(id: string, direction: 'transmit' | 'listen') {
	callSessionManager.register({ id, channelId: id, kind: 'channel', name: id, direction });
	callSessionManager.markConnected(id, null);
	return callSessionManager.get(id)!;
}

beforeEach(() => {
	callSessionManager.leaveAll();
	joined.length = 0;
	toasts.length = 0;
	leaveFails = false;
});

describe('joinVoice', () => {
	it('"Join" leaves the mic where the runtime put it: it never re-focuses the session model', async () => {
		room('lounge', 'transmit');
		// The runtime registers a second room listen-only while the mic is in the first one.
		const joining = joinVoice('cowork', 'join');
		room('cowork', 'listen');
		expect(await joining).toBe(true);
		expect(callSessionManager.get('lounge')?.focus).toBe('focused');
		expect(callSessionManager.get('cowork')).toMatchObject({ focus: 'background', direction: 'listen' });
		expect(joined).toEqual([{ channelId: 'cowork', options: {} }]);
	});

	it('"Listen" asks the runtime for a receive-only join', async () => {
		await joinVoice('listening-room', 'listen');
		expect(joined).toEqual([{ channelId: 'listening-room', options: { listenOnly: true } }]);
	});
});

describe('Silence this call', () => {
	it('is one silence: pressed at volume 0 it brings the last audible volume back', () => {
		room('lounge', 'transmit');
		setCallVolume('lounge', 35);
		setCallVolume('lounge', 0);
		expect(sessionSilenced(callSessionManager.get('lounge')!)).toBe(true);
		toggleCallSpeaker('lounge');
		expect(callSessionManager.get('lounge')).toMatchObject({ muted: false, volume: 35 });
	});

	it('mutes an audible call, and moving the volume makes it audible again', () => {
		room('lounge', 'transmit');
		toggleCallSpeaker('lounge');
		expect(callSessionManager.get('lounge')?.muted).toBe(true);
		setCallVolume('lounge', 60);
		expect(callSessionManager.get('lounge')).toMatchObject({ muted: false, volume: 60 });
	});

	it('turns off a muted call at volume 0 with full volume when none was heard before', () => {
		room('quiet', 'listen');
		callSessionManager.setVolume('quiet', 0);
		callSessionManager.setSessionMuted('quiet', true);
		toggleCallSpeaker('quiet');
		expect(callSessionManager.get('quiet')).toMatchObject({ muted: false, volume: 100 });
	});
});

describe('leaveCall', () => {
	it('says which room could not be left instead of failing silently', async () => {
		const lounge = room('lounge', 'transmit');
		leaveFails = true;
		expect(leaveCall(lounge, 'Studio lounge')).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(toasts).toEqual(["Couldn't leave Studio lounge. Try again."]);
	});
});
