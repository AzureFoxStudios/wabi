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
	splitRootSections
} from './channelSidebarHelpers';
import type { DragAnchor } from './channelSidebarHelpers';
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
		expect(splitVoiceParticipants(people, false)).toEqual({ shown: ['a', 'b', 'c', 'd', 'e'], hidden: 2 });
	});

	test('expanded or short rooms list everyone', () => {
		expect(splitVoiceParticipants(people, true)).toEqual({ shown: people, hidden: 0 });
		expect(splitVoiceParticipants(['a', 'b'], false)).toEqual({ shown: ['a', 'b'], hidden: 0 });
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
});
