import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { channelIdOfPanel, channelPanelId, channelPanelManifest, reconcileChannelPanels } from './channelDockPanelIds';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('docked channel panels', () => {
	test('a panel id names its channel and round-trips', () => {
		const id = channelPanelId('text-alt');
		expect(id).toBe('channel:text-alt');
		expect(channelIdOfPanel(id)).toBe('text-alt');
		expect(channelIdOfPanel('users')).toBeNull();
		expect(channelIdOfPanel('channel:')).toBeNull();
	});

	test('an id the dock cannot store is refused instead of falling back to another panel', () => {
		expect(channelPanelId('')).toBeNull();
		expect(channelPanelId('has space')).toBeNull();
		expect(channelPanelId('x'.repeat(200))).toBeNull();
		expect(channelPanelManifest({ id: 'has space', name: 'nope' })).toBeNull();
	});

	test('the manifest renders the channel chat and is labelled with the channel name', () => {
		const manifest = channelPanelManifest({ id: 'abc', name: 'Text-Alt' });
		expect(manifest?.component).toBe('channel-chat');
		expect(manifest?.label).toBe('#Text-Alt');
	});

	test('only docked channels this account can see get a panel, and several can exist at once', () => {
		const list = [{ id: 'general', name: 'general' }, { id: 'alt', name: 'Text-Alt' }, { id: 'other', name: 'other' }];
		const wanted = reconcileChannelPanels(['users', 'channel:alt', 'channel:gone', 'channel:general'], list);
		expect(wanted.map((manifest) => manifest.id)).toEqual(['channel:alt', 'channel:general']);
	});
});

describe('Chat is instance-scoped', () => {
	const chat = read('./components/Chat.svelte');

	test('the global selection is read in exactly one place, as the fallback for center stage', () => {
		expect(chat.match(/\$currentChannel\b/g)).toHaveLength(1);
		expect(chat).toContain('$: viewChannelId = channelId ?? $currentChannel;');
	});

	test('a companion does not take over the stage masthead search', () => {
		expect(chat).toContain('$: if (!companion) chatStageInfo.set({');
		expect(chat).toContain("$: searchInput = companion ? '' : $chatSearch.query;");
	});

	test('dock, floating panel and detached window all pass their own channel', () => {
		for (const path of ['./components/WorkspacePanelHost.svelte', './components/windowing/FloatingPanelHost.svelte', '../routes/detached/+page.svelte']) {
			expect(read(path)).toMatch(/channelId=\{[^}]+\} surface="companion"/);
		}
	});
});
