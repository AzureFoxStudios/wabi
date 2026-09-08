import { expect, test } from 'bun:test';
import { derived, get, writable } from 'svelte/store';
import { adminChannelDirectory, createAdminChannelOpener } from './adminChannelNavigation';
import { createWorkspaceNavigation } from './workspaceNavigation';
import { mobileTabQueue } from './mobileTabQueue';

test('directory includes supported server channel kinds with human labels, never private conversations or folders', () => {
	const types = ['public', 'text', 'voice', 'forum', 'gallery', 'wiki', 'stage', 'lore', 'planning', 'reception', 'dm', 'group', 'thread', 'thread_public', 'thread_private', 'category', 'unknown', 'constructor'];
	const directory = adminChannelDirectory(types.map(type => ({ id: type, name: type, type })));
	expect(directory.map(channel => String(channel.type))).toEqual(types.slice(0, 10));
	expect(directory.map(channel => channel.typeLabel)).toEqual(['Public', 'Text', 'Voice', 'Forum', 'Gallery', 'Wiki', 'Stage', 'Project', 'Planning', 'Reception']);
	expect(adminChannelDirectory([{ id: 'missing-kind', name: 'Unknown' }])).toEqual([]);
});

function fixture(type = 'forum') {
	let allowed = true;
	let channels = [{ id: 'destination', name: 'Destination', type }];
	const calls: unknown[] = [];
	const open = createAdminChannelOpener({
		channels: () => channels,
		canOpen: () => allowed,
		selectChannel: id => calls.push(['select', id]),
		showChannelSurface: () => calls.push('messages'),
		closeCenterConversation: () => calls.push('close-center-dm'),
		leaveAdmin: () => calls.push('leave-admin'),
		navigate: intent => calls.push(intent)
	});
	return { open, calls, revoke: () => { allowed = false; }, remove: () => { channels = []; } };
}

test('channel handoff restores the channel surface and exits Admin before the dock-preserving shell intent', () => {
	const { open, calls } = fixture();
	expect(open('destination')).toBe(true);
	expect(calls).toEqual([
		['select', 'destination'], 'messages', 'close-center-dm', 'leave-admin',
		{ view: 'chat', preserveRightPanel: true }
	]);
});

test('role loss, removed channels and unsupported kinds cannot perform a stale navigation', () => {
	const revoked = fixture(); revoked.revoke();
	const removed = fixture(); removed.remove();
	for (const attempt of [revoked, removed, fixture('dm'), fixture('category')]) {
		expect(attempt.open('destination')).toBe(false);
		expect(attempt.calls).toEqual([]);
	}
});

for (const type of ['voice', 'stage']) {
	test(`${type} opening is a message-surface selection, not a voice-view or media command`, () => {
		const { open, calls } = fixture(type);
		expect(open('destination')).toBe(true);
		expect(calls.filter(call => call === 'messages')).toHaveLength(1);
		expect(calls).toHaveLength(5);
	});
}

test('opening a channel uses the real workspace resolver, preserves other addon tabs and clears only the destination board', () => {
	const channel = writable('previous-channel');
	const voice = writable(true);
	const boards = writable<Record<string, 'messages' | 'whiteboard'>>({ 'previous-channel': 'whiteboard', destination: 'whiteboard' });
	const surface = derived([channel, boards], ([id, values]) => values[id] ?? 'messages');
	const navigation = createWorkspaceNavigation({
		addonIds: { reader: 'reader', model: 'model-viewport', map: 'server-map', media: 'media-albums', planner: 'planner', notes: 'notes', lore: 'lore', files: 'files' },
		queue: mobileTabQueue, channel, voice, surface,
		setSurface: (id, next) => boards.update(values => ({ ...values, [id]: next }))
	});
	mobileTabQueue.registerAddonTab({ id: 'reader', label: 'Reader' });
	navigation.select('reader');
	voice.set(true);
	const open = createAdminChannelOpener({
		channels: () => [{ id: 'destination', name: 'Knowledge', type: 'wiki' }],
		canOpen: () => true,
		selectChannel: id => channel.set(id),
		showChannelSurface: () => navigation.select('messages'),
		closeCenterConversation: () => {}, leaveAdmin: () => {}, navigate: () => {}
	});
	try {
		expect(open('destination')).toBe(true);
		expect(get(channel)).toBe('destination');
		expect(get(navigation.activeView)).toBe('messages');
		expect(get(mobileTabQueue.activeTabId)).toBe('channel:destination');
		expect(get(mobileTabQueue.tabs).some(tab => tab.id === 'addon:reader')).toBe(true);
		expect(get(boards)).toEqual({ 'previous-channel': 'whiteboard', destination: 'messages' });
		expect(get(voice)).toBe(false);
	} finally {
		mobileTabQueue.unregisterAddonTab('reader');
	}
});
