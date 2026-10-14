import { beforeEach, expect, test } from 'bun:test';
import { derived, get, writable } from 'svelte/store';
import { createWorkspaceNavigation, type WorkspaceAddonView } from './workspaceNavigation';
import { mobileTabQueue } from './mobileTabQueue';
import type { WorkspaceViewKey } from './components/chat/types';

const addonIds = { notifications: 'notifications', reader: 'reader', model: 'model-viewport', map: 'server-map', media: 'media-albums',
	planner: 'planner', notes: 'notes', lore: 'lore', files: 'files',
	documents: 'workspace-documents', sheets: 'workspace-sheets', present: 'workspace-present' };
const officeLabels: Partial<Record<WorkspaceAddonView, string>> = { documents: 'Documents', sheets: 'Sheets', present: 'Present' };
const views: WorkspaceViewKey[] = ['messages', 'whiteboard', 'voice', ...Object.keys(addonIds) as (keyof typeof addonIds)[]];
const channel = writable('current-channel');
const voice = writable(false);
const boards = writable<Record<string, 'messages' | 'whiteboard'>>({});
const surface = derived([channel, boards], ([id, boards]) => boards[id] ?? 'messages');
const ensured: WorkspaceAddonView[] = [];
const navigation = createWorkspaceNavigation({ addonIds, queue: mobileTabQueue, channel, voice, surface,
	addonAliases: { 'workspace-audience': 'present' },
	// Mirrors bridge.ensureWorkspaceTab: register only when absent, never navigate.
	ensureAddonTab: (view) => {
		ensured.push(view);
		const label = officeLabels[view];
		if (label && !get(mobileTabQueue.addonTabs).some(tab => tab.id === addonIds[view])) {
			mobileTabQueue.registerAddonTab({ id: addonIds[view], label });
		}
	},
	setSurface: (id, view) => { if (id) boards.update(state => ({ ...state, [id]: view })); }
});

beforeEach(() => {
	mobileTabQueue.closeAllAddonTabs();
	mobileTabQueue.setActiveChannel('older-channel');
	channel.set('current-channel');
	voice.set(false);
	boards.set({});
	ensured.length = 0;
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
			} else {
				expect(get(mobileTabQueue.activeTabId)).toBe(`addon:${addonIds[to as keyof typeof addonIds]}`);
			}
			// …and back again: every view is reachable from every other view.
			navigation.select(from);
			expect(get(navigation.activeView)).toBe(from);
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
	navigation.select('documents');
	expect(get(navigation.activeView)).toBe('documents');
	navigation.select('messages');
	expect(get(navigation.activeView)).toBe('messages');
	expect(get(mobileTabQueue.activeTabId)).toBeNull();
});

test('an open office tool owns the active view instead of the channel surface', () => {
	for (const tool of ['documents', 'sheets', 'present'] as const) {
		navigation.select('whiteboard');
		mobileTabQueue.openAddonTab(addonIds[tool]);
		expect(get(navigation.activeView)).toBe(tool);
	}
});

test('selecting an office view registers its tab once, with its own name, then opens it', () => {
	for (const id of [addonIds.documents, addonIds.sheets, addonIds.present]) mobileTabQueue.unregisterAddonTab(id);
	navigation.select('sheets');
	expect(ensured).toEqual(['sheets']);
	expect(get(mobileTabQueue.addonTabs).filter(tab => tab.id === addonIds.sheets)).toEqual([{ id: addonIds.sheets, label: 'Sheets' }]);
	expect(get(mobileTabQueue.activeTabId)).toBe('addon:workspace-sheets');
	navigation.select('messages');
	navigation.select('sheets');
	expect(get(mobileTabQueue.addonTabs).filter(tab => tab.id === addonIds.sheets)).toHaveLength(1);
	expect(get(navigation.activeView)).toBe('sheets');
});

test('the registration hook decides what to register; built-in views stay registered by the shell', () => {
	navigation.select('files');
	navigation.select('planner');
	expect(ensured).toEqual(['files', 'planner']);
	expect(get(mobileTabQueue.addonTabs).some(tab => tab.id === addonIds.files)).toBe(false);
});

test('a joined presentation counts as Present, and choosing Present keeps the room', () => {
	mobileTabQueue.openAddonTab('workspace-audience');
	expect(get(navigation.activeView)).toBe('present');
	navigation.select('present');
	expect(get(mobileTabQueue.activeTabId)).toBe('addon:workspace-audience');
	expect(get(navigation.activeView)).toBe('present');
	navigation.select('documents');
	expect(get(navigation.activeView)).toBe('documents');
	navigation.select('present');
	expect(get(mobileTabQueue.activeTabId)).toBe('addon:workspace-present');
	navigation.select('messages');
	expect(get(navigation.activeView)).toBe('messages');
});

test('an alias never shadows a view’s own tab', () => {
	const shadowed = createWorkspaceNavigation({ addonIds, queue: mobileTabQueue, channel, voice, surface,
		addonAliases: { [addonIds.files]: 'present' }, setSurface: () => {} });
	mobileTabQueue.openAddonTab(addonIds.files);
	expect(get(shadowed.activeView)).toBe('files');
});

test('unknown addon tabs fall back to the channel surface, not an office view', () => {
	mobileTabQueue.openAddonTab('workspace-unregistered');
	expect(get(navigation.activeView)).toBe('messages');
	voice.set(true);
	expect(get(navigation.activeView)).toBe('voice');
});

test('a navigation built without a view’s tab id leaves that view unselectable instead of opening nothing', () => {
	const partial = createWorkspaceNavigation({ addonIds: { files: 'files' }, queue: mobileTabQueue, channel, voice, surface, setSurface: () => {} });
	voice.set(true);
	partial.select('documents');
	expect(get(voice)).toBe(true);
	expect(get(mobileTabQueue.activeTabId)).toBe('channel:older-channel');
	partial.select('files');
	expect(get(partial.activeView)).toBe('files');
	expect(get(voice)).toBe(false);
});
