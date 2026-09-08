import { beforeEach, expect, test } from 'bun:test';
import { derived, get, writable } from 'svelte/store';
import { createWorkspaceNavigation } from './workspaceNavigation';
import { mobileTabQueue } from './mobileTabQueue';
import type { WorkspaceViewKey } from './components/chat/types';

const addonIds = { reader: 'reader', model: 'model-viewport', map: 'server-map', media: 'media-albums',
	planner: 'planner', notes: 'notes', lore: 'lore', files: 'files' };
const views: WorkspaceViewKey[] = ['messages', 'whiteboard', 'voice', ...Object.keys(addonIds) as (keyof typeof addonIds)[]];
const channel = writable('current-channel');
const voice = writable(false);
const boards = writable<Record<string, 'messages' | 'whiteboard'>>({});
const surface = derived([channel, boards], ([id, boards]) => boards[id] ?? 'messages');
const navigation = createWorkspaceNavigation({ addonIds, queue: mobileTabQueue, channel, voice, surface,
	setSurface: (id, view) => { if (id) boards.update(state => ({ ...state, [id]: view })); }
});

beforeEach(() => {
	mobileTabQueue.closeAllAddonTabs();
	mobileTabQueue.setActiveChannel('older-channel');
	channel.set('current-channel');
	voice.set(false);
	boards.set({});
});

for (const from of views) {
	for (const to of views) {
		test(`${from} → ${to} resolves the requested workspace`, () => {
			navigation.select(from);
			navigation.select(to);
			expect(get(navigation.activeView)).toBe(to);
			expect(get(voice)).toBe(to === 'voice');
			if (['messages', 'whiteboard', 'voice'].includes(to)) {
				expect(get(mobileTabQueue.activeTabId)).toBe('channel:current-channel');
			}
		});
	}
}

test('external addon open wins over a remembered whiteboard and voice view', () => {
	navigation.select('whiteboard');
	mobileTabQueue.openAddonTab(addonIds.files);
	expect(get(navigation.activeView)).toBe('files');
	voice.set(true);
	expect(get(navigation.activeView)).toBe('files');
	navigation.select('messages');
	expect(get(surface)).toBe('messages');
});

test('returning to messages preserves open addon tabs and other channels’ boards', () => {
	mobileTabQueue.registerAddonTab({ id: addonIds.reader, label: 'Reader' });
	boards.set({ 'older-channel': 'whiteboard' });
	navigation.select('reader');
	navigation.select('messages');
	expect(get(mobileTabQueue.tabs).some(tab => tab.id === 'addon:reader')).toBe(true);
	expect(get(boards)['older-channel']).toBe('whiteboard');
	mobileTabQueue.unregisterAddonTab(addonIds.reader);
});

test('without a channel, global workspaces remain usable but Whiteboard cannot open', () => {
	channel.set('');
	navigation.select('notes');
	navigation.select('whiteboard');
	expect(get(navigation.activeView)).toBe('notes');
	navigation.select('voice');
	expect(get(navigation.activeView)).toBe('voice');
	navigation.select('messages');
	expect(get(navigation.activeView)).toBe('messages');
	expect(get(mobileTabQueue.activeTabId)).toBeNull();
});
