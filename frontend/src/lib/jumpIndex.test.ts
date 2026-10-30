import { expect, test } from 'bun:test';
import {
	JUMP_GROUPS,
	PREVIEW_TITLE,
	SCOPE_GROUPS,
	buildJumpIndex,
	flattenSections,
	formatEdited,
	highlightParts,
	matchJump,
	paletteKeyAction,
	presenceOf,
	searchJump,
	type JumpIndexInput,
	type JumpItem
} from './jumpIndex';

const NOW = new Date(2026, 8, 21, 9, 42).getTime();

function fixture(overrides: Partial<JumpIndexInput> = {}): JumpItem[] {
	return buildJumpIndex({
		now: NOW,
		locale: 'en-GB',
		activeView: 'messages',
		currentChannelName: 'general',
		office: { sheets: 'off', present: 'on' },
		unreadChannels: 1,
		channels: [
			{ id: 'general', name: 'general', type: 'text', current: true },
			{ id: 'small-discoveries', name: 'small-discoveries', type: 'text', unread: 3 },
			{ id: 'community-guide', name: 'community-guide', type: 'wiki' },
			{ id: 'conversations', name: 'conversations', type: 'forum' },
			{ id: 'studio-lounge', name: 'Studio lounge', type: 'voice', occupancy: 3 },
			{ id: 'folder', name: 'Archive', type: 'category' },
			{ id: 'dm-theo', name: 'dm-theo', type: 'dm', person: { name: 'Theo Park', color: '#edba89', presence: 'active' }, privacy: 'encryption-pending' },
			{ id: 'dm-nora', name: 'Nora Ellis', type: 'dm', person: { name: 'Nora Ellis' }, privacy: 'checking' },
			{ id: 'group-1', name: 'Weekend crew', type: 'group', members: 'Theo, Nora +2 more', privacy: null }
		],
		people: [
			{ id: 'u-sofia', name: 'Sofia Reyes', handle: 'sofia', status: 'offline' },
			{ id: 'u-theo', name: 'Theo Park', handle: 'theo', status: 'active', room: 'Studio lounge', color: '#edba89' },
			{ id: 'u-nora', name: 'Nora Ellis', handle: '@nora', status: 'away' }
		],
		documents: [
			{ id: 'd1', kind: 'document', title: 'A field guide to belonging', updatedAt: NOW - 60_000, shared: false },
			{ id: 'd2', kind: 'document', title: 'Studio gathering notes', updatedAt: new Date(2026, 8, 19, 16, 0).getTime(), shared: true, role: 'editor' },
			{ id: 's1', kind: 'sheets', title: 'Budget', updatedAt: NOW, shared: false },
			{ id: 'p1', kind: 'present', title: 'Monday deck', updatedAt: NOW - 120_000, shared: false }
		],
		...overrides
	});
}

const byId = (items: JumpItem[], id: string) => items.find((item) => item.id === id)!;
const titles = (items: JumpItem[], query: string, scope: Parameters<typeof searchJump>[2] = 'all') =>
	flattenSections(searchJump(items, query, scope)).map((result) => result.item.title);

test('office tools carry PREVIEW and say when their add-on is off on this device', () => {
	const items = fixture();
	const documents = byId(items, 'workspace:documents');
	expect(documents.truths).toEqual([{ kind: 'maturity', label: 'PREVIEW', title: PREVIEW_TITLE }]);
	expect(PREVIEW_TITLE).toBe('Integration candidate, not a deployed feature');
	expect(byId(items, 'workspace:sheets').truths.map((truth) => truth.kind)).toEqual(['hint', 'maturity']);
	expect(byId(items, 'workspace:sheets').truths[0]).toEqual({ kind: 'hint', label: 'off on this device' });
	// Present is on here: PREVIEW only.
	expect(byId(items, 'workspace:present').truths.map((truth) => truth.kind)).toEqual(['maturity']);
	// No other workspace claims a maturity, and no row uses retired words.
	for (const item of items) {
		const words = JSON.stringify(item).toLowerCase();
		for (const banned of ['beta', 'coming soon', 'available now', 'end-to-end', 'e2ee', 'secure', 'verified']) expect(words).not.toContain(banned);
	}
	expect(items.filter((item) => item.group === 'workspaces' && item.truths.some((truth) => truth.kind === 'maturity')).map((item) => item.title)).toEqual([
		'Documents',
		'Sheets',
		'Present'
	]);
});

test('one name per place, in folio order, with the current workspace marked', () => {
	const items = fixture({ activeView: 'planner' });
	const workspaces = items.filter((item) => item.group === 'workspaces').map((item) => item.title);
	expect(workspaces).toEqual([
		'Chat', 'Files', 'Whiteboard', 'Calls', 'Activity', 'Project', 'DMs', 'My Planner', 'Notes',
		'Documents', 'Sheets', 'Present', 'Media', 'Reader', '3D viewer', 'Map'
	]);
	expect(byId(items, 'workspace:planner').current).toBe(true);
	expect(byId(items, 'workspace:messages').subtitle).toBe('This channel · #general');
	expect(byId(items, 'workspace:dms').target).toEqual({ type: 'dms' });
	expect(byId(items, 'workspace:voice').target).toEqual({ type: 'view', view: 'voice' });
	expect(fixture({ canOpenWhiteboard: false }).some((item) => item.id === 'workspace:whiteboard')).toBe(false);
});

test('an add-on state that is not known yet says nothing, and one missing from this build is hidden', () => {
	const unknown = fixture({ office: {} });
	expect(byId(unknown, 'workspace:sheets').truths.map((truth) => truth.kind)).toEqual(['maturity']);
	expect(byId(unknown, 'workspace:present').truths.map((truth) => truth.kind)).toEqual(['maturity']);
	// Drafts of an add-on whose state is unknown stay out until it is known to be on.
	expect(unknown.some((item) => item.id === 'document:present:p1')).toBe(false);
	const absent = fixture({ office: { sheets: 'unavailable', present: 'on' } });
	expect(absent.some((item) => item.id === 'workspace:sheets')).toBe(false);
	expect(absent.some((item) => item.id === 'document:sheets:s1')).toBe(false);
	expect(byId(fixture({ office: { sheets: 'on' } }), 'document:sheets:s1').target).toEqual({ type: 'document', documentId: 's1', tool: 'sheets' });
});

test('recent documents say Local draft or, once shared, Server-readable with the role', () => {
	const items = fixture();
	const local = byId(items, 'document:document:d1');
	expect(local.truths).toEqual([{ kind: 'locality', label: 'Local draft', title: expect.any(String) }]);
	expect(local.subtitle).toBe('Documents · edited 09:41');
	const shared = byId(items, 'document:document:d2');
	expect(shared.truths).toEqual([{ kind: 'seal', label: 'Server-readable', title: expect.stringContaining('server operator can read') }]);
	expect(shared.subtitle).toBe('Documents · Shared · Editor · edited Sat 19');
	expect(shared.target).toEqual({ type: 'document', documentId: 'd2', tool: 'documents' });
	// Sheets drafts hide while the Sheets add-on is off; Present drafts show while it is on.
	expect(items.some((item) => item.id === 'document:sheets:s1')).toBe(false);
	expect(byId(items, 'document:present:p1').target).toEqual({ type: 'document', documentId: 'p1', tool: 'present' });
	// Newest first.
	expect(items.filter((item) => item.group === 'documents').map((item) => item.title)).toEqual([
		'A field guide to belonging', 'Monday deck', 'Studio gathering notes'
	]);
});

test('edited times follow the locale: time today, weekday this week, date otherwise', () => {
	expect(formatEdited(new Date(2026, 8, 21, 7, 5).getTime(), NOW, 'en-GB')).toBe('edited 07:05');
	expect(formatEdited(new Date(2026, 8, 19, 7, 5).getTime(), NOW, 'en-GB')).toBe('edited Sat 19');
	expect(formatEdited(new Date(2026, 7, 2).getTime(), NOW, 'en-GB')).toBe('edited 2 Aug');
	expect(formatEdited(new Date(2025, 7, 2).getTime(), NOW, 'en-GB')).toBe('edited 2 Aug 2025');
	expect(formatEdited(0, NOW, 'en-GB')).toBe('');
});

test('channels: kinds, unread, voice rooms, folders skipped, conversations open as conversations', () => {
	const items = fixture();
	expect(items.some((item) => item.id === 'channel:folder')).toBe(false);
	const general = byId(items, 'channel:general');
	expect(general).toMatchObject({ title: 'general', glyph: '#', subtitle: 'Channel', current: true });
	expect(general.target).toEqual({ type: 'channel', channelId: 'general' });
	expect(byId(items, 'channel:small-discoveries').unread).toBe(3);
	expect(byId(items, 'channel:community-guide')).toMatchObject({ icon: 'book', subtitle: 'Wiki' });
	expect(byId(items, 'channel:studio-lounge')).toMatchObject({ subtitle: 'Voice room · 3 in the room', target: { type: 'voice', channelId: 'studio-lounge' } });
	expect(byId(items, 'channel:dm-theo')).toMatchObject({ title: 'Theo Park', subtitle: 'DM', target: { type: 'conversation', channelId: 'dm-theo' } });
	expect(byId(items, 'channel:group-1')).toMatchObject({ subtitle: 'Group · Theo, Nora +2 more', target: { type: 'conversation', channelId: 'group-1' } });
});

test('a conversation shows its privacy only once the room status is known; channels never do', () => {
	const items = fixture();
	expect(byId(items, 'channel:dm-theo').truths).toEqual([{ kind: 'privacy', state: 'encryption-pending' }]);
	expect(byId(items, 'channel:dm-nora').truths).toEqual([]);
	expect(byId(items, 'channel:group-1').truths).toEqual([]);
	const leaked = buildJumpIndex({ channels: [{ id: 'g', name: 'general', type: 'text', privacy: 'experimental-encryption' }] });
	expect(byId(leaked, 'channel:g').truths).toEqual([]);
});

test('people: handle and where they are, here now first when nothing is typed', () => {
	const items = fixture();
	expect(byId(items, 'person:u-theo').subtitle).toBe('@theo · In Studio lounge');
	expect(byId(items, 'person:u-nora').subtitle).toBe('@nora · Away');
	expect(byId(items, 'person:u-sofia').subtitle).toBe('@sofia · Offline');
	expect(byId(items, 'person:u-theo').person).toMatchObject({ initial: 'T', presence: 'active', color: '#edba89' });
	expect(titles(items, '', 'people')).toEqual(['Theo Park', 'Nora Ellis', 'Sofia Reyes']);
	expect(presenceOf('active')).toBe('active');
	expect(presenceOf('idle')).toBe('away');
	expect(presenceOf('dnd')).toBe('busy');
	expect(presenceOf(undefined)).toBe('offline');
});

test('actions: new document is a local draft and a preview; mark all read counts unread channels', () => {
	const items = fixture();
	expect(items.filter((item) => item.group === 'actions').map((item) => item.title)).toEqual(['New document', 'New task', 'Mark all read', 'Open settings']);
	expect(byId(items, 'action:new-document')).toMatchObject({ subtitle: 'Starts as a local draft on this device' });
	expect(byId(items, 'action:new-document').truths.map((truth) => truth.kind)).toEqual(['maturity']);
	expect(byId(items, 'action:mark-all-read').subtitle).toBe('1 channel unread');
	expect(byId(fixture({ unreadChannels: 0 }), 'action:mark-all-read').subtitle).toBe('Nothing is unread');
	expect(byId(fixture({ unreadChannels: 4 }), 'action:mark-all-read').subtitle).toBe('4 channels unread');
});

test('match tiers: exact, prefix, word start, word-start runs, then substring', () => {
	const exact = matchJump('Notes', 'notes')!;
	const prefix = matchJump('Documents', 'doc')!;
	const word = matchJump('New document', 'doc')!;
	const runs = matchJump('My Planner', 'mypl')!;
	const inner = matchJump('small-discoveries', 'cove')!;
	expect(exact.score).toBeGreaterThan(prefix.score);
	expect(prefix.score).toBeGreaterThan(word.score);
	expect(word.score).toBeGreaterThan(runs.score);
	expect(runs.score).toBeGreaterThan(inner.score);
	expect(prefix.ranges).toEqual([[0, 3]]);
	expect(word.ranges).toEqual([[4, 7]]);
	expect(runs.ranges).toEqual([[0, 2], [3, 5]]);
	expect(inner.ranges).toEqual([[9, 13]]);
	expect(matchJump('Documents', 'xyz')).toBeNull();
	// One stray letter mid-word is not a match.
	expect(matchJump('Studio lounge', 'u')).toBeNull();
});

test('matching ignores case and accents and maps ranges back onto the original text', () => {
	const match = matchJump('Café Résumé', 'resu')!;
	expect(match.ranges).toEqual([[5, 9]]);
	expect(highlightParts('Café Résumé', match.ranges)).toEqual([
		{ text: 'Café ', hit: false },
		{ text: 'Résu', hit: true },
		{ text: 'mé', hit: false }
	]);
	// A decomposed title keeps its combining marks inside the highlighted range.
	const decomposed = 'Résumé';
	expect(matchJump(decomposed, 'res')!.ranges).toEqual([[0, 4]]);
	expect(matchJump('ŞEHİR', 'sehir')).not.toBeNull();
});

test('multi-word queries need every word, in the title or its keywords', () => {
	const planner = matchJump('My Planner', 'planner my')!;
	expect(planner.ranges).toEqual([[0, 2], [3, 10]]);
	expect(matchJump('My Planner', 'planner zebra')).toBeNull();
	// "kanban" is only a keyword: it finds the row but underlines nothing.
	const keyword = matchJump('My Planner', 'kanban', ['tasks', 'kanban'])!;
	expect(keyword.ranges).toEqual([]);
	expect(keyword.score).toBeLessThan(matchJump('My Planner', 'pla')!.score);
});

test('highlightParts tolerates overlapping and out-of-range ranges', () => {
	expect(highlightParts('general', [[0, 3], [2, 4], [10, 12]])).toEqual([
		{ text: 'gene', hit: true },
		{ text: 'ral', hit: false }
	]);
	expect(highlightParts('', [])).toEqual([{ text: '', hit: false }]);
});

test('"doc" finds the Documents workspace first, underlined, then the New document action', () => {
	const items = fixture();
	const sections = searchJump(items, 'doc');
	const first = flattenSections(sections)[0];
	expect(first.item.id).toBe('workspace:documents');
	expect(first.ranges).toEqual([[0, 3]]);
	expect(first.item.truths.some((truth) => truth.kind === 'maturity')).toBe(true);
	expect(sections[0].group).toBe('workspaces');
	expect(titles(items, 'doc')).toContain('New document');
	expect(titles(items, 'doc', 'workspaces')).not.toContain('New document');
});

test('with nothing typed: contract section order, a taste of each, where you are last', () => {
	const items = fixture();
	const sections = searchJump(items, '');
	expect(sections.map((section) => section.group)).toEqual(['workspaces', 'documents', 'channels', 'people', 'actions']);
	expect(sections[0].results.map((result) => result.item.title)).toEqual(['Calls', 'Activity', 'DMs', 'My Planner']);
	expect(sections[0].results.every((result) => result.ranges.length === 0)).toBe(true);
	// Unread first; the current channel sinks out of the short list.
	const channels = sections.find((section) => section.group === 'channels')!.results.map((result) => result.item.id);
	expect(channels[0]).toBe('channel:small-discoveries');
	expect(channels).not.toContain('channel:general');
	expect(channels.length).toBe(5);
	expect(searchJump(items, '', 'channels')[0].results.at(-1)!.item.id).toBe('channel:general');
});

test('scopes: each chip lists only its sections; Workspaces includes recent documents', () => {
	expect(SCOPE_GROUPS.all).toEqual(JUMP_GROUPS);
	const items = fixture();
	expect(searchJump(items, '', 'workspaces').map((section) => section.group)).toEqual(['workspaces', 'documents']);
	expect(searchJump(items, '', 'actions').map((section) => section.group)).toEqual(['actions']);
	expect(titles(items, 'theo', 'channels')).toEqual(['Theo Park']);
	expect(titles(items, 'theo', 'people')).toEqual(['Theo Park']);
	expect(searchJump(items, 'theo', 'people')[0].group).toBe('people');
	// A scope lists everything it has, not the Everything taste.
	expect(flattenSections(searchJump(items, '', 'workspaces')).length).toBe(16 + 3);
});

test('with a query, sections follow their best match and rows their score', () => {
	const items = fixture();
	const sections = searchJump(items, 'theo');
	// The DM and the person both match exactly; channels come before people in the fixed order.
	expect(sections.map((section) => section.group)).toEqual(['channels', 'people']);
	expect(titles(items, 'sett')).toEqual(['Open settings']);
	expect(titles(items, 'gen')).toEqual(['general']);
	expect(searchJump(items, 'zzz')).toEqual([]);
	const limited = searchJump(items, 'o', 'all', { limits: { workspaces: 1 } });
	expect(limited.find((section) => section.group === 'workspaces')?.results.length ?? 0).toBeLessThanOrEqual(1);
});

test('Ctrl K toggles everywhere, text fields included, but never steals a key an editor owns', () => {
	const key = (init: Record<string, unknown> = {}) => ({ key: 'k', code: 'KeyK', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...init });
	const ready = { open: false, appReady: true };
	expect(paletteKeyAction(key(), ready)).toBe('toggle');
	expect(paletteKeyAction(key({ target: { closest: () => null } }), ready)).toBe('toggle');
	expect(paletteKeyAction(key({ key: 'j' }), ready)).toBeNull();
	expect(paletteKeyAction(key({ shiftKey: true }), ready)).toBeNull();
	// A focused editor that handled Ctrl K, or declares it, keeps it.
	expect(paletteKeyAction(key({ defaultPrevented: true }), ready)).toBeNull();
	expect(paletteKeyAction(key({ target: { closest: (selector: string) => (selector === '[data-keeps-ctrl-k]' ? {} : null) } }), ready)).toBeNull();
	// Not before the app shell exists, and not over another modal dialog; always able to close.
	expect(paletteKeyAction(key(), { open: false, appReady: false })).toBeNull();
	expect(paletteKeyAction(key(), { open: false, appReady: true, modalOpen: true })).toBeNull();
	expect(paletteKeyAction(key(), { open: true, appReady: false, modalOpen: true })).toBe('toggle');
});
