import { expect, test } from 'bun:test';
import {
	JUMP_GROUPS,
	PREVIEW_TITLE,
	SCOPE_GROUPS,
	buildJumpIndex,
	bufferedPaletteKey,
	flattenSections,
	formatEdited,
	highlightParts,
	isTextEntry,
	jumpSteps,
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

test('recent documents say Local draft or, once shared, the tag Shared · <role> and the seal chip', () => {
	const items = fixture();
	const local = byId(items, 'document:document:d1');
	expect(local.truths).toEqual([{ kind: 'locality', label: 'Local draft', title: expect.any(String) }]);
	expect(local.subtitle).toBe('Documents · edited 09:41');
	const shared = byId(items, 'document:document:d2');
	// §9.3: seal chip "Server-readable" + tag "Shared · <role>", not a subtitle phrase.
	expect(shared.truths).toEqual([
		{ kind: 'locality', label: 'Shared · Editor', title: expect.any(String) },
		{ kind: 'seal', label: 'Server-readable', title: expect.stringContaining('server operator can read') }
	]);
	expect(shared.subtitle).toBe('Documents · edited Sat');
	const roleless = buildJumpIndex({ documents: [{ id: 'x', kind: 'document', title: 'Notes', updatedAt: NOW, shared: true }] });
	expect(byId(roleless, 'document:document:x').truths.map((truth) => (truth.kind === 'privacy' ? truth.state : truth.label))).toEqual(['Shared', 'Server-readable']);
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
	expect(formatEdited(new Date(2026, 8, 19, 7, 5).getTime(), NOW, 'en-GB')).toBe('edited Sat');
	expect(formatEdited(new Date(2026, 8, 19, 7, 5).getTime(), NOW, 'en-US')).toBe('edited Sat');
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
	expect(byId(items, 'channel:studio-lounge')).toMatchObject({ subtitle: 'Voice room · 3 in the room', live: true, target: { type: 'voice', channelId: 'studio-lounge' } });
	const empty = buildJumpIndex({ channels: [{ id: 'quiet', name: 'Quiet coworking', type: 'voice', occupancy: 0 }] });
	expect(byId(empty, 'channel:quiet').live).toBeUndefined();
	expect(byId(items, 'channel:general').live).toBeUndefined();
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

test('actions: new document is a local draft and a preview; new task says where it lands; mark all read counts unread channels', () => {
	const items = fixture();
	expect(items.filter((item) => item.group === 'actions').map((item) => item.title)).toEqual(['New document', 'New task', 'Mark all read', 'Open settings']);
	expect(byId(items, 'action:new-document')).toMatchObject({ subtitle: 'Starts as a local draft on this device' });
	// Not "Opens My Planner": it lands on the board's New task button, one Enter from the form.
	expect(byId(items, 'action:new-task')).toMatchObject({ subtitle: 'Opens the My Planner board at New task', target: { type: 'action', action: 'new-task' } });
	expect(byId(items, 'action:new-task').truths).toEqual([]);
	expect(byId(items, 'action:new-document').truths.map((truth) => truth.kind)).toEqual(['maturity']);
	expect(byId(items, 'action:mark-all-read')).toMatchObject({ subtitle: '1 channel unread' });
	expect(byId(items, 'action:mark-all-read').disabled).toBeUndefined();
	// Same rule as the sidebar menu: with nothing unread it is listed but not runnable.
	expect(byId(fixture({ unreadChannels: 0 }), 'action:mark-all-read')).toMatchObject({ subtitle: 'Nothing unread', disabled: true });
	expect(byId(fixture({ unreadChannels: 4 }), 'action:mark-all-read').subtitle).toBe('4 channels unread');
	// "new task" and "add task" find the action first; "tasks" still finds where tasks live.
	expect(titles(items, 'new task')[0]).toBe('New task');
	expect(titles(items, 'add task')[0]).toBe('New task');
	expect(titles(items, 'tasks')).toContain('My Planner');
});

test('jump steps: DMs and conversations hand center stage back to Chat before the DM view opens', () => {
	// The workspace picker closes a center DM, so it must run first; the DM view alone left Calls
	// or My Planner on stage with only the DMs row lit.
	expect(jumpSteps({ type: 'dms' })).toEqual([{ kind: 'view', view: 'messages' }, { kind: 'dm' }]);
	expect(jumpSteps({ type: 'conversation', channelId: 'dm-theo' }, 'voice')).toEqual([
		{ kind: 'view', view: 'messages' },
		{ kind: 'dm', channelId: 'dm-theo' }
	]);
	for (const target of [{ type: 'dms' }, { type: 'conversation', channelId: 'dm-theo' }] as const) {
		const steps = jumpSteps(target, 'planner');
		expect(steps.findIndex((step) => step.kind === 'view' && step.view === 'messages')).toBe(0);
		expect(steps.findIndex((step) => step.kind === 'dm')).toBe(steps.length - 1);
	}
	// A channel switches first, then Chat takes center stage; workspaces and voice rooms pick their view.
	expect(jumpSteps({ type: 'channel', channelId: 'general' })).toEqual([{ kind: 'channel', channelId: 'general' }, { kind: 'view', view: 'messages' }]);
	expect(jumpSteps({ type: 'view', view: 'planner' })).toEqual([{ kind: 'view', view: 'planner' }]);
	expect(jumpSteps({ type: 'voice', channelId: 'studio' })).toEqual([{ kind: 'view', view: 'voice' }]);
	// People, documents and the other actions need no shell step.
	expect(jumpSteps({ type: 'person', personId: 'u-theo' })).toEqual([]);
	expect(jumpSteps({ type: 'document', documentId: 'doc-1', tool: 'documents' })).toEqual([]);
	expect(jumpSteps({ type: 'action', action: 'new-document' })).toEqual([]);
	expect(jumpSteps({ type: 'action', action: 'mark-all-read' })).toEqual([]);
});

test('jump steps: new task opens My Planner on its board, and leaves an open planner on its view', () => {
	expect(jumpSteps({ type: 'action', action: 'new-task' }, 'messages')).toEqual([{ kind: 'planner-board' }, { kind: 'view', view: 'planner' }]);
	expect(jumpSteps({ type: 'action', action: 'new-task' })).toEqual([{ kind: 'planner-board' }, { kind: 'view', view: 'planner' }]);
	// An open planner has read its deep link already; a stale one would move a later visit.
	expect(jumpSteps({ type: 'action', action: 'new-task' }, 'planner')).toEqual([{ kind: 'view', view: 'planner' }]);
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

test('folding does not depend on the runtime locale (a Turkish runtime still finds "Iris")', () => {
	const lower = String.prototype.toLocaleLowerCase;
	const upper = String.prototype.toLocaleUpperCase;
	// Emulate a Turkish host: dotless ı for I, dotted İ for i.
	String.prototype.toLocaleLowerCase = function (this: string) {
		return this.replace(/I/g, 'ı').toLowerCase();
	} as typeof lower;
	String.prototype.toLocaleUpperCase = function (this: string) {
		return this.replace(/i/g, 'İ').toUpperCase();
	} as typeof upper;
	try {
		expect(matchJump('Iris Wong', 'iris')!.ranges).toEqual([[0, 4]]);
		expect(matchJump('Inbox', 'inb')).not.toBeNull();
		const person = buildJumpIndex({ people: [{ id: 'u', name: 'iris wong' }] });
		expect(byId(person, 'person:u').person?.initial).toBe('I');
	} finally {
		String.prototype.toLocaleLowerCase = lower;
		String.prototype.toLocaleUpperCase = upper;
	}
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
});

test('a scope with nothing typed reads like the table of contents: input (sidebar / folio) order, where you are kept in place', () => {
	const items = fixture({ activeView: 'planner' });
	const channels = flattenSections(searchJump(items, '', 'channels')).map((result) => result.item.id);
	// The palette passes sidebar order: channels, then voice, then conversations. Nothing is re-ranked.
	expect(channels).toEqual([
		'channel:general',
		'channel:small-discoveries',
		'channel:community-guide',
		'channel:conversations',
		'channel:studio-lounge',
		'channel:dm-theo',
		'channel:dm-nora',
		'channel:group-1'
	]);
	expect(byId(items, 'channel:general').current).toBe(true);
	// Workspaces in folio order, the current one (My Planner) in its place.
	expect(searchJump(items, '', 'workspaces')[0].results.map((result) => result.item.title).slice(0, 9)).toEqual([
		'Chat', 'Files', 'Whiteboard', 'Calls', 'Activity', 'Project', 'DMs', 'My Planner', 'Notes'
	]);
	// People keep here now first.
	expect(titles(items, '', 'people')[0]).toBe('Theo Park');
	// Typing ranks again.
	expect(titles(items, 'gen', 'channels')).toEqual(['general']);
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

test('the modal check runs only for Ctrl K, never for ordinary typing', () => {
	let calls = 0;
	const modalOpen = () => {
		calls += 1;
		return false;
	};
	const key = (init: Record<string, unknown> = {}) => ({ key: 'k', code: 'KeyK', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...init });
	for (const letter of ['a', 'b', 'k']) paletteKeyAction(key({ key: letter, ctrlKey: false }), { open: false, appReady: true, modalOpen });
	expect(calls).toBe(0);
	expect(paletteKeyAction(key(), { open: false, appReady: true, modalOpen })).toBe('toggle');
	expect(calls).toBe(1);
	expect(paletteKeyAction(key(), { open: false, appReady: true, modalOpen: () => true })).toBeNull();
});

test('macOS: Ctrl K in a text field stays "delete to end of line"; ⌘K and Ctrl K elsewhere open the palette', () => {
	const key = (init: Record<string, unknown> = {}) => ({ key: 'k', code: 'KeyK', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...init });
	const textarea = { tagName: 'TEXTAREA', closest: () => null };
	const field = { tagName: 'INPUT', type: 'text', closest: () => null };
	const editor = { tagName: 'DIV', isContentEditable: true, closest: () => null };
	const button = { tagName: 'BUTTON', closest: () => null };
	const mac = { open: false, appReady: true, mac: true };
	expect(paletteKeyAction(key({ target: textarea }), mac)).toBeNull();
	expect(paletteKeyAction(key({ target: field }), mac)).toBeNull();
	expect(paletteKeyAction(key({ target: editor }), mac)).toBeNull();
	expect(paletteKeyAction(key({ target: button }), mac)).toBe('toggle');
	expect(paletteKeyAction(key({ target: textarea, ctrlKey: false, metaKey: true }), mac)).toBe('toggle');
	// The palette's own field: Ctrl K still closes it.
	expect(paletteKeyAction(key({ target: field }), { ...mac, open: true })).toBe('toggle');
	// Elsewhere Ctrl K works in text fields too.
	expect(paletteKeyAction(key({ target: textarea }), { open: false, appReady: true })).toBe('toggle');
	expect(isTextEntry({ tagName: 'INPUT', type: 'checkbox' } as unknown as EventTarget)).toBe(false);
	expect(isTextEntry({ tagName: 'input', type: 'search' } as unknown as EventTarget)).toBe(true);
	expect(isTextEntry(null)).toBe(false);
});

test('keys pressed before the palette holds focus are queued (Enter, Tab and arrows too), Esc closes', () => {
	const key = (init: Record<string, unknown> = {}) => ({ key: 'g', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init });
	const waiting = { open: true, paletteHasFocus: false };
	for (const name of ['g', ' ', 'Backspace', 'Enter', 'Tab', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp']) {
		expect(bufferedPaletteKey(key({ key: name }), waiting)).toBe('queue');
	}
	expect(bufferedPaletteKey(key({ key: 'Escape' }), waiting)).toBe('close');
	// Modifiers, Shift alone, IME composition and keys already handled are left alone.
	expect(bufferedPaletteKey(key({ key: 'k', ctrlKey: true }), waiting)).toBeNull();
	expect(bufferedPaletteKey(key({ key: 'Shift' }), waiting)).toBeNull();
	expect(bufferedPaletteKey(key({ isComposing: true }), waiting)).toBeNull();
	expect(bufferedPaletteKey(key({ defaultPrevented: true }), waiting)).toBeNull();
	// Once the palette's field has focus it handles its own keys; a closed palette takes nothing.
	expect(bufferedPaletteKey(key(), { open: true, paletteHasFocus: true })).toBeNull();
	expect(bufferedPaletteKey(key(), { open: false, paletteHasFocus: false })).toBeNull();
});
