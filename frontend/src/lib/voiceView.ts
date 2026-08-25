import { writable } from 'svelte/store';

/**
 * Phase 4 — the dedicated voice view (figure 1): all calls as cards, checkable
 * from any channel via the workspace view pills. Simple boolean view state;
 * addon tabs take precedence while open, and the view returns when they close.
 */
export const voiceViewOpen = writable(false);
