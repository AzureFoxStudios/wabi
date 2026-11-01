import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	buildMixedRoot,
	filterMixedRoot,
	resolveDropGap,
	FOLDER_EDGE_BAND_PX,
	formatBadge,
	unreadLabel,
	dmRowLabel,
	isCompactSidebarWidth,
	COMPACT_SIDEBAR_MAX_WIDTH,
	resolveSidebarPlace,
	splitVoiceParticipants,
	VOICE_PARTICIPANT_LIMIT,
	voiceMemberState,
	splitRootSections,
	sidebarWidthTier,
	NARROW_SIDEBAR_MAX_WIDTH,
	communityUnreadIds,
	planSidebarFoot,
	FOOT_LAYOUT,
	channelNoun,
	deleteConfirmCopy
} from './channelSidebarHelpers';
import type { DragAnchor, FootControl } from './channelSidebarHelpers';
import type { Channel } from '$lib/socket';

function ch(partial: Partial<Channel> & Pick<Channel, 'id' | 'name'>): Channel {
	return {
		type: 'text',
		...partial
	} as unknown as Channel;
}

describe('buildMixedRoot', () => {
	test('lets a channel sit above a folder when its position is lower', () => {
		const general = ch({ id: 'general', name: 'general', position: 0 });
		const folder = ch({ id: 'art', name: 'art', type: 'category', position: 1 });
		const nested = ch({ id: 'sfw', name: 'sfw', parentId: 'art', position: 0 });
		const voice = ch({ id: 'voice', name: 'voice', type: 'voice', position: 2 });

		const mixed = buildMixedRoot([general, folder, nested, voice], [general, nested, voice]);

		expect(mixed.map((item) => `${item.kind}:${item.id}`)).toEqual([
			'channel:general',
			'folder:art',
			'channel:voice'
		]);
		expect(mixed[1].kind === 'folder' && mixed[1].children.map((child) => child.id)).toEqual(['sfw']);
	});

	test('keeps empty folders in the mixed list', () => {
		const folder = ch({ id: 'empty', name: 'empty', type: 'category', position: 0 });
		const mixed = buildMixedRoot([folder], []);
		expect(mixed).toHaveLength(1);
		expect(mixed[0]).toMatchObject({ kind: 'folder', id: 'empty' });
	});

	test('filterMixedRoot keeps a folder when a child matches', () => {
		const folder = ch({ id: 'art', name: 'art', type: 'category', position: 0 });
		const nested = ch({ id: 'sfw', name: 'sfw-art', parentId: 'art', position: 0 });
		const mixed = buildMixedRoot([folder, nested], [nested]);
		const filtered = filterMixedRoot(mixed, 'sfw');
		expect(filtered).toHaveLength(1);
		expect(filtered[0].kind === 'folder' && filtered[0].children[0].id).toBe('sfw');
	});
});

describe('resolveDropGap', () => {
	const containerTop = 100;
	const scrollTop = 40;
	const toContent = (viewportY: number) => viewportY - containerTop + scrollTop;

	function anchor(partial: Partial<DragAnchor> & Pick<DragAnchor, 'kind' | 'id' | 'top' | 'bottom'>): DragAnchor {
		return { parentFolderId: null, ...partial };
	}

	const anchors: DragAnchor[] = [
		anchor({ kind: 'channel', id: 'general', top: 200, bottom: 232 }),
		// folder header at 240-270, its child row at 274-306 (dead zone 232-240 / 270-274)
		anchor({ kind: 'folder', id: 'art', top: 240, bottom: 270 }),
		anchor({ kind: 'channel', id: 'sfw', parentFolderId: 'art', top: 274, bottom: 306 }),
		anchor({ kind: 'channel', id: 'voice', top: 310, bottom: 342 })
	];

	test('row midpoint splits before/after within the root scope', () => {
		const upper = resolveDropGap(anchors, 210, false, containerTop, scrollTop, 400);
		expect(upper.gap).toEqual({ scope: 'root', anchorId: 'general', pos: 'before' });
		expect(upper.lineY).toBe(toContent(200));
		expect(upper.indented).toBe(false);

		const lower = resolveDropGap(anchors, 230, false, containerTop, scrollTop, 400);
		expect(lower.gap).toEqual({ scope: 'root', anchorId: 'general', pos: 'after' });
		expect(lower.lineY).toBe(toContent(232));
	});

	test('folder-child rows resolve to a positional insert inside the folder', () => {
		const result = resolveDropGap(anchors, 280, false, containerTop, scrollTop, 400);
		expect(result.gap).toEqual({ scope: 'folder', categoryId: 'art', anchorId: 'sfw', pos: 'before' });
		expect(result.indented).toBe(true);
	});

	test('dead zones between rows snap forward to the next anchor (line never lies)', () => {
		// 232-240 sits between #general and the art folder header ⇒ before-folder.
		const beforeFolder = resolveDropGap(anchors, 236, false, containerTop, scrollTop, 400);
		expect(beforeFolder.gap).toEqual({ scope: 'folder-header', categoryId: 'art', pos: 'before' });

		// 270-274 sits between the folder header and its first child row.
		const insideGap = resolveDropGap(anchors, 272, false, containerTop, scrollTop, 400);
		expect(insideGap.gap).toEqual({ scope: 'folder', categoryId: 'art', anchorId: 'sfw', pos: 'before' });
	});

	test('folder-header edge bands mean around-the-folder in the root sequence', () => {
		const topBand = resolveDropGap(anchors, 240 + FOLDER_EDGE_BAND_PX - 1, false, containerTop, scrollTop, 400);
		expect(topBand.gap).toEqual({ scope: 'folder-header', categoryId: 'art', pos: 'before' });

		const bottomBand = resolveDropGap(anchors, 270 - FOLDER_EDGE_BAND_PX + 1, false, containerTop, scrollTop, 400);
		expect(bottomBand.gap).toEqual({ scope: 'folder-header', categoryId: 'art', pos: 'after' });
	});

	test('dropping on a folder-header middle makes the channel the first child', () => {
		const result = resolveDropGap(anchors, 255, false, containerTop, scrollTop, 400);
		expect(result.gap).toEqual({ scope: 'folder', categoryId: 'art', anchorId: null, pos: 'before' });
		expect(result.lineY).toBe(toContent(270));
		expect(result.indented).toBe(true);
	});

	test('dragging a folder never targets inside another folder — middle degrades to nearest gap', () => {
		const result = resolveDropGap(anchors, 255, true, containerTop, scrollTop, 400);
		expect(result.gap).toEqual({ scope: 'folder-header', categoryId: 'art', pos: 'after' });

		const upperHalf = resolveDropGap(anchors, 250, true, containerTop, scrollTop, 400);
		expect(upperHalf.gap).toEqual({ scope: 'folder-header', categoryId: 'art', pos: 'before' });
	});

	test('past the last anchor resolves to the end of the root sequence', () => {
		const result = resolveDropGap(anchors, 500, false, containerTop, scrollTop, 400);
		expect(result.gap).toEqual({ scope: 'root', anchorId: null, pos: 'after' });
		expect(result.lineY).toBe(toContent(400));
		expect(result.indented).toBe(false);
	});

	test('above every anchor resolves before the first one', () => {
		const result = resolveDropGap(anchors, 150, false, containerTop, scrollTop, 400);
		expect(result.gap).toEqual({ scope: 'root', anchorId: 'general', pos: 'before' });
	});

	test('a voice-room drag only goes INTO a folder: its header edges never mean "around it"', () => {
		// A top-level voice room renders under VOICE, so "before/after the folder" in CHANNELS
		// would draw the line where the room never lands.
		for (const y of [240 + 1, 255, 270 - 1]) {
			const result = resolveDropGap(anchors, y, false, containerTop, scrollTop, 400, true);
			expect(result.gap).toEqual({ scope: 'folder', categoryId: 'art', anchorId: null, pos: 'before' });
			expect(result.indented).toBe(true);
		}
		// Rows still split before/after as usual.
		const row = resolveDropGap(anchors, 330, false, containerTop, scrollTop, 400, true);
		expect(row.gap).toEqual({ scope: 'root', anchorId: 'voice', pos: 'after' });
	});

	test('empty list still offers the root tail gap', () => {
		const result = resolveDropGap([], 300, false, containerTop, scrollTop, 320);
		expect(result.gap).toEqual({ scope: 'root', anchorId: null, pos: 'after' });
		expect(result.lineY).toBe(toContent(320));
	});
});

describe('formatBadge (spec §7.9: 1-99, then 99+)', () => {
	test('plain numerals, never "+N" or "*"', () => {
		expect(formatBadge(1)).toBe('1');
		expect(formatBadge(3)).toBe('3');
		expect(formatBadge(10)).toBe('10');
		expect(formatBadge(11)).toBe('11');
		expect(formatBadge(99)).toBe('99');
	});

	test('caps at 99+', () => {
		expect(formatBadge(100)).toBe('99+');
		expect(formatBadge(5000)).toBe('99+');
	});

	test('no badge for zero or non-counts', () => {
		expect(formatBadge(0)).toBe('');
		expect(formatBadge(-2)).toBe('');
		expect(formatBadge(Number.NaN)).toBe('');
		expect(formatBadge(Number.POSITIVE_INFINITY)).toBe('');
	});

	test('the spoken label matches the numerals', () => {
		expect(unreadLabel(3)).toBe('3 unread');
		expect(unreadLabel(240)).toBe('99+ unread');
		expect(unreadLabel(0)).toBe('');
	});
});

describe('dmRowLabel', () => {
	test('names the place "DMs and friends" and what is waiting', () => {
		expect(dmRowLabel(0, 0)).toBe('DMs and friends');
		expect(dmRowLabel(2, 0)).toBe('DMs and friends, 2 unread');
		expect(dmRowLabel(0, 1)).toBe('DMs and friends, 1 friend request');
		expect(dmRowLabel(4, 3)).toBe('DMs and friends, 4 unread, 3 friend requests');
	});
});

describe('isCompactSidebarWidth', () => {
	test('compact is a range of narrow widths, not only exactly 60', () => {
		expect(isCompactSidebarWidth(60)).toBe(true);
		expect(isCompactSidebarWidth(90)).toBe(true);
		// 121-160 used to keep the full foot, whose Settings button ran past the column edge.
		expect(isCompactSidebarWidth(150)).toBe(true);
		expect(isCompactSidebarWidth(COMPACT_SIDEBAR_MAX_WIDTH)).toBe(true);
		expect(isCompactSidebarWidth(COMPACT_SIDEBAR_MAX_WIDTH + 1)).toBe(false);
		expect(isCompactSidebarWidth(280)).toBe(false);
	});

	test('a collapsed column (0) is hidden, not compact', () => {
		expect(isCompactSidebarWidth(0)).toBe(false);
		expect(isCompactSidebarWidth(-10)).toBe(false);
		expect(isCompactSidebarWidth(Number.NaN)).toBe(false);
	});
});

describe('sidebarWidthTier', () => {
	test('compact rail, then a narrow column, then the full layout', () => {
		expect(sidebarWidthTier(60, false)).toBe('compact');
		expect(sidebarWidthTier(COMPACT_SIDEBAR_MAX_WIDTH, false)).toBe('compact');
		expect(sidebarWidthTier(COMPACT_SIDEBAR_MAX_WIDTH + 1, false)).toBe('narrow');
		expect(sidebarWidthTier(200, false)).toBe('narrow');
		expect(sidebarWidthTier(NARROW_SIDEBAR_MAX_WIDTH, false)).toBe('narrow');
		expect(sidebarWidthTier(NARROW_SIDEBAR_MAX_WIDTH + 1, false)).toBe('full');
		expect(sidebarWidthTier(264, false)).toBe('full');
	});

	test('the phone drawer is always full, whatever desktop width is stored', () => {
		expect(sidebarWidthTier(60, true)).toBe('full');
		expect(sidebarWidthTier(150, true)).toBe('full');
		expect(sidebarWidthTier(190, true)).toBe('full');
	});
});

describe('planSidebarFoot (nothing clipped at the column edge)', () => {
	const fine = { inCall: false, coarse: false };
	const fineCall = { inCall: true, coarse: false };
	const touch = { inCall: false, coarse: true };
	const touchCall = { inCall: true, coarse: true };

	/** Width the planned foot takes (mirrors the .sb-foot rules in surfaces/sidebar.css). */
	function used(plan: ReturnType<typeof planSidebarFoot>, coarse: boolean): number {
		const key = coarse ? 44 : 32;
		const n = plan.inline.length;
		const keys = n === 0 ? 0 : FOOT_LAYOUT.gap + n * key + (n - 1) * FOOT_LAYOUT.keyGap;
		const name = plan.name ? FOOT_LAYOUT.gap + FOOT_LAYOUT.minName : 0;
		return FOOT_LAYOUT.padStart + FOOT_LAYOUT.avatar + FOOT_LAYOUT.padEnd + name + keys;
	}

	test('the default column shows the whole foot (spec §8.1: name, Mute, Deafen, Settings)', () => {
		expect(planSidebarFoot(264, fine)).toEqual({ name: true, inline: ['mute', 'deafen', 'settings'], overflow: [] });
		expect(planSidebarFoot(280, fineCall)).toEqual({ name: true, inline: ['mute', 'end', 'deafen', 'settings'], overflow: [] });
	});

	test('Settings, then Deafen, move into the avatar menu before the name goes', () => {
		expect(planSidebarFoot(264, fineCall)).toEqual({ name: true, inline: ['mute', 'end', 'deafen'], overflow: ['settings'] });
		expect(planSidebarFoot(200, fine)).toEqual({ name: true, inline: ['mute'], overflow: ['deafen', 'settings'] });
	});

	test('the narrowest full column drops the name and keeps what fits', () => {
		expect(planSidebarFoot(COMPACT_SIDEBAR_MAX_WIDTH + 1, fine)).toEqual({ name: false, inline: ['mute', 'deafen'], overflow: ['settings'] });
		expect(planSidebarFoot(COMPACT_SIDEBAR_MAX_WIDTH + 1, fineCall)).toEqual({ name: false, inline: ['mute', 'end'], overflow: ['deafen', 'settings'] });
	});

	test('44px touch keys are planned at their real size', () => {
		expect(planSidebarFoot(264, touch)).toEqual({ name: true, inline: ['mute', 'deafen'], overflow: ['settings'] });
		expect(planSidebarFoot(252, touchCall).inline).toEqual(['mute', 'end']);
		// The phone drawer (min(88vw, 360px) or the full 389px) has room for everything.
		expect(planSidebarFoot(343, touchCall)).toEqual({ name: true, inline: ['mute', 'end', 'deafen', 'settings'], overflow: [] });
	});

	test('the planned foot never runs past the column, at any width the drag handle allows', () => {
		for (const opts of [fine, fineCall, touch, touchCall]) {
			for (let width = COMPACT_SIDEBAR_MAX_WIDTH + 1; width <= 744; width++) {
				const plan = planSidebarFoot(width, opts);
				expect(used(plan, opts.coarse)).toBeLessThanOrEqual(width);
				const every: FootControl[] = opts.inCall ? ['mute', 'end', 'deafen', 'settings'] : ['mute', 'deafen', 'settings'];
				expect([...plan.inline, ...plan.overflow].sort()).toEqual(every.sort());
			}
		}
	});

	test('the rail (or an unmeasured foot) puts every control in the avatar menu', () => {
		expect(planSidebarFoot(60, fineCall)).toEqual({ name: false, inline: [], overflow: ['mute', 'end', 'deafen', 'settings'] });
		expect(planSidebarFoot(Number.NaN, fine).inline).toEqual([]);
	});
});

describe('channelNoun + deleteConfirmCopy (the confirm names what is deleted)', () => {
	test('one noun per kind', () => {
		expect(channelNoun('voice')).toBe('voice room');
		expect(channelNoun('group')).toBe('group');
		expect(channelNoun('category')).toBe('folder');
		expect(channelNoun('text')).toBe('channel');
		expect(channelNoun(undefined)).toBe('channel');
	});

	test('a voice room or group is never called a channel', () => {
		const room = deleteConfirmCopy('voice room', 'Studio lounge', 0);
		expect(room.title).toBe('Delete this voice room?');
		expect(room.message).toBe('“Studio lounge” and its messages are removed for everyone. This can’t be undone.');
		expect(room.confirm).toBe('Delete voice room');
		expect(`${room.title} ${room.message} ${room.confirm}`).not.toMatch(/channel|#/);
		expect(deleteConfirmCopy('group', 'Weekend crew', 0).confirm).toBe('Delete group');
	});

	test('channels keep the # name; folders offer to keep their channels', () => {
		expect(deleteConfirmCopy('channel', 'general', 0).message).toBe('#general and its messages are removed for everyone. This can’t be undone.');
		const folder = deleteConfirmCopy('folder', 'Field projects', 2);
		expect(folder.secondary).toBe('Delete folder, keep channels');
		expect(folder.message).toContain('holds 2 channels');
		expect(deleteConfirmCopy('folder', 'Empty', 0).secondary).toBeNull();
	});
});

describe('communityUnreadIds (CHANNELS > Mark all read)', () => {
	const list = [
		{ id: 'general', type: 'text' },
		{ id: 'lounge', type: 'voice' },
		{ id: 'notes', type: undefined },
		{ id: 'dm-1', type: 'dm' },
		{ id: 'group-1', type: 'group' }
	] as Array<Pick<Channel, 'id' | 'type'>>;

	test('clears community channels only, never DMs or group DMs', () => {
		const ids = communityUnreadIds({ general: 3, lounge: 0, notes: 2, 'dm-1': 4, 'group-1': 1 }, list);
		expect(ids).toEqual(['general', 'notes']);
	});

	test('ignores ids the channel list does not know and non-counts', () => {
		expect(communityUnreadIds({ 'unknown-dm': 5, general: Number.NaN, notes: -1 }, list)).toEqual([]);
	});
});

describe('resolveSidebarPlace (exactly one current entry)', () => {
	test('Server home and DMs own the current mark', () => {
		expect(resolveSidebarPlace('server', 'messages')).toBe('server');
		expect(resolveSidebarPlace('dm', 'messages')).toBe('dm');
	});

	test("the channel's own views make its row the page", () => {
		expect(resolveSidebarPlace('chat', 'messages')).toBe('channel');
		expect(resolveSidebarPlace('chat', 'whiteboard')).toBe('channel');
		expect(resolveSidebarPlace('chat', 'files')).toBe('channel');
		expect(resolveSidebarPlace('chat', null)).toBe('channel');
	});

	test('another workspace in center stage leaves the channel as context only', () => {
		expect(resolveSidebarPlace('chat', 'planner')).toBe('context');
		expect(resolveSidebarPlace('chat', 'documents')).toBe('context');
		expect(resolveSidebarPlace('chat', 'voice')).toBe('context');
		expect(resolveSidebarPlace('following', 'messages')).toBe('context');
		expect(resolveSidebarPlace('business', 'messages')).toBe('context');
	});
});

describe('splitVoiceParticipants', () => {
	const people = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

	test(`lists at most ${VOICE_PARTICIPANT_LIMIT}, then counts the rest`, () => {
		expect(splitVoiceParticipants(people, false)).toEqual({ shown: ['a', 'b', 'c', 'd', 'e'], hidden: 2, collapsible: false });
	});

	test('an opened long room lists everyone and can fold back ("Show less")', () => {
		expect(splitVoiceParticipants(people, true)).toEqual({ shown: people, hidden: 0, collapsible: true });
	});

	test('short rooms list everyone with no toggle at all', () => {
		expect(splitVoiceParticipants(['a', 'b'], false)).toEqual({ shown: ['a', 'b'], hidden: 0, collapsible: false });
		expect(splitVoiceParticipants(['a', 'b'], true)).toEqual({ shown: ['a', 'b'], hidden: 0, collapsible: false });
		expect(splitVoiceParticipants(people.slice(0, VOICE_PARTICIPANT_LIMIT), false).hidden).toBe(0);
	});
});

describe('voiceMemberState', () => {
	test('one glyph and word per state', () => {
		expect(voiceMemberState({ isMuted: true })).toEqual({ icon: 'micOff', label: 'Muted' });
		expect(voiceMemberState({ isDeafened: true, isMuted: true })).toEqual({ icon: 'headphonesOff', label: 'Deafened' });
		expect(voiceMemberState({ isListenOnly: true })).toEqual({ icon: 'headphones', label: 'Listening' });
		expect(voiceMemberState({ speaking: true })).toEqual({ icon: 'mic', label: 'Speaking' });
		expect(voiceMemberState({})).toEqual({ icon: 'mic', label: 'Mic on' });
	});
});

describe('splitRootSections', () => {
	test('top-level voice rooms read under VOICE; folders keep any mix', () => {
		const general = ch({ id: 'general', name: 'general', position: 0 });
		const lounge = ch({ id: 'lounge', name: 'lounge', type: 'voice', position: 1 });
		const folder = ch({ id: 'art', name: 'art', type: 'category', position: 2 });
		const nestedVoice = ch({ id: 'studio', name: 'studio', type: 'voice', parentId: 'art', position: 0 });
		const wiki = ch({ id: 'guide', name: 'guide', type: 'wiki', position: 3 });
		const mixed = buildMixedRoot([general, lounge, folder, nestedVoice, wiki], [general, lounge, nestedVoice, wiki]);
		const { channels, voice } = splitRootSections(mixed);
		expect(channels.map((item) => item.id)).toEqual(['general', 'art', 'guide']);
		expect(voice.map((item) => item.id)).toEqual(['lounge']);
		const art = channels[1];
		expect(art.kind === 'folder' && art.children.map((child) => child.id)).toEqual(['studio']);
	});
});

describe('sidebar stylesheets stay on roles (spec §2.5, §4.7)', () => {
	const stylesDir = join(dirname(fileURLToPath(import.meta.url)), '../../../styles');
	const sheets = [
		'surfaces/sidebar.css',
		'components/sidebar-core-part1.css',
		'components/sidebar-core-part2.css',
		'components/sidebar-core-part3.css',
		'components/sidebar-channels.css',
		'components/sidebar-compact.css'
	];

	/** Remove block comments; one pattern, applied until the text stops changing. */
	function stripComments(css: string): string {
		let previous = '';
		let current = css;
		while (current !== previous) {
			previous = current;
			current = current.replace(/\/\*[\s\S]*?\*\//, '');
		}
		return current;
	}

	for (const sheet of sheets) {
		const css = stripComments(readFileSync(join(stylesDir, sheet), 'utf8'));

		test(`${sheet}: no raw colors or legacy color tokens`, () => {
			expect(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
			expect(css.match(/\brgba?\(/g) ?? []).toEqual([]);
			expect(css.match(/var\(--(?:surface|text|accent-primary|border|color)-[\w-]*/g) ?? []).toEqual([]);
		});

		test(`${sheet}: nothing loops, nothing animates "all", no !important`, () => {
			expect(css).not.toMatch(/\binfinite\b/);
			expect(css).not.toMatch(/transition\s*:\s*all\b/);
			expect(css).not.toMatch(/!important/);
			expect(css).not.toMatch(/(?:linear|radial)-gradient\(/);
		});
	}

	test('the 32px row grid and the 80px foot are the contract values', () => {
		const css = stripComments(readFileSync(join(stylesDir, 'surfaces/sidebar.css'), 'utf8'));
		expect(css).toContain('grid-template-columns: 20px minmax(0, 1fr) auto;');
		expect(css).toContain('height: var(--w-foot);');
		expect(css).toContain('height: var(--w-mast);');
	});

	/** The bodies of every `@media <query> {…}` block, matched by brace depth (no regex strip). */
	function mediaBodies(css: string, query: string): string {
		const opener = `@media ${query} {`;
		const bodies: string[] = [];
		let from = css.indexOf(opener);
		while (from !== -1) {
			let depth = 1;
			let at = from + opener.length;
			while (at < css.length && depth > 0) {
				if (css[at] === '{') depth++;
				else if (css[at] === '}') depth--;
				at++;
			}
			bodies.push(css.slice(from + opener.length, at - 1));
			from = css.indexOf(opener, at);
		}
		return bodies.join('\n');
	}

	test('touch keeps the masthead rule: the search stays 32px with a 44px hit extender, no keycap', () => {
		const css = stripComments(readFileSync(join(stylesDir, 'surfaces/sidebar.css'), 'utf8'));
		const coarse = mediaBodies(css, '(pointer: coarse)');
		expect(coarse).toMatch(/\.sb-search\s*\{\s*height:\s*32px;/);
		expect(coarse).toMatch(/\.sb-search::after\s*\{[^}]*inset:\s*-7px -1px;/);
		expect(coarse).toMatch(/\.sb-search \.w-kbd\s*\{\s*display:\s*none;/);
		// The section head grows with its 44px add key (touch and the drawer).
		const touchOrDrawer = mediaBodies(css, '(pointer: coarse), (max-width: 768px)');
		expect(touchOrDrawer).toMatch(/\.sb-sec\s*\{\s*height:\s*44px;/);
		// The phone drawer has no column beside it, so its masthead grows to hold a 44px field.
		const drawer = mediaBodies(css, '(max-width: 768px)');
		expect(drawer).toMatch(/\.sb-mast\s*\{\s*height:\s*calc\(var\(--w-head-a\) \+ 52px\);/);
		expect(drawer).toMatch(/\.sb-search\s*\{\s*height:\s*44px;/);
	});

	test('the sidebar sheets hold no dialog layout for other surfaces (modal-skin.css owns it)', () => {
		const part3 = stripComments(readFileSync(join(stylesDir, 'components/sidebar-core-part3.css'), 'utf8'));
		expect(part3).not.toMatch(/\.modal-content:has\(/);
	});
});
