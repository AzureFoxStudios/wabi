import { describe, expect, test } from 'bun:test';
import {
	buildMixedRoot,
	filterMixedRoot,
	resolveDropGap,
	FOLDER_EDGE_BAND_PX
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
