import { writable } from 'svelte/store';
import { currentChannel } from './socket';

/**
 * Phase 4 — the dedicated voice view (figure 1): all calls as cards, checkable
 * from any channel via the workspace picker (workspaceNavigationState.ts). Simple boolean view state;
 * addon tabs take precedence while open, and the view returns when they close.
 */
export const voiceViewOpen = writable(false);

// Un-stick (2026-09-07): selecting ANY other channel exits the voice
// dashboard. The view resolver rendered 'voice' for every channel while the
// flag stayed up, so clicking around felt like the view was stuck. The
// dashboard is opened from a channel, not tied to one — navigation wins.
let voiceViewOpenNow = false;
voiceViewOpen.subscribe((open) => {
	voiceViewOpenNow = open;
});
let lastChannelKey: string | null = null;
currentChannel.subscribe((channelKey) => {
	if (voiceViewOpenNow && lastChannelKey !== null && channelKey !== lastChannelKey) {
		voiceViewOpen.set(false);
	}
	lastChannelKey = channelKey;
});
