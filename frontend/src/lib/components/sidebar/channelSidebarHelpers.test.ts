import { describe, expect, test } from 'bun:test';
import { buildMixedRoot, filterMixedRoot } from './channelSidebarHelpers';
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
