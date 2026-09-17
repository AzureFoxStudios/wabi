import { describe, expect, test } from 'bun:test';
import {
	filterGalleryItems,
	splitGallerySections,
	galleryViewState,
	guessGalleryMediaKind,
	type GalleryFilterState
} from './galleryFilter';
import type { GalleryItem } from './galleryStore';

function item(overrides: Partial<GalleryItem> = {}): GalleryItem {
	return {
		id: 'album-1-item-1',
		albumId: 1,
		albumName: 'Album',
		attachmentUrl: 'https://wabi.example/uploads/a.png',
		attachmentName: 'a.png',
		attachmentSize: 10,
		attachmentMime: 'image/png',
		caption: null,
		uploadedBy: 7,
		uploadedAt: 1_700_000_000_000,
		creator: null,
		...overrides
	};
}

const blank: GalleryFilterState = { query: '', type: 'all', uploaderId: null };

describe('gallery filter helper (GF01)', () => {
	test('search matches attachment name, caption and creator username case-insensitively', () => {
		const items = [
			item({ id: '1', attachmentName: 'Sunset.png', caption: null, creator: null }),
			item({ id: '2', attachmentName: 'other.png', caption: 'BIRTHDAY party', creator: null }),
			item({
				id: '3',
				attachmentName: 'other2.png',
				creator: { dbUserId: 9, username: 'AtelierRin', profilePicture: '', color: '' } as GalleryItem['creator']
			}),
			item({ id: '4', attachmentName: 'unrelated.png', caption: 'nothing here', creator: null })
		];
		expect(filterGalleryItems(items, { ...blank, query: 'sunset' }).map((i) => i.id)).toEqual(['1']);
		expect(filterGalleryItems(items, { ...blank, query: 'birthday' }).map((i) => i.id)).toEqual(['2']);
		expect(filterGalleryItems(items, { ...blank, query: 'atelierrin' }).map((i) => i.id)).toEqual(['3']);
		expect(filterGalleryItems(items, { ...blank, query: 'zzz-no-hit' })).toEqual([]);
	});

	test('media-type filter falls back to file extension when MIME is missing', () => {
		const items = [
			item({ id: 'img-mime', attachmentName: 'a.bin', attachmentMime: 'image/png' }),
			item({ id: 'img-ext', attachmentName: 'photo.JPG', attachmentMime: null }),
			item({ id: 'vid-mime', attachmentName: 'b.bin', attachmentMime: 'video/mp4' }),
			item({ id: 'vid-ext', attachmentName: 'clip.webm', attachmentMime: null }),
			item({ id: 'unknown', attachmentName: 'notes.txt', attachmentMime: null })
		];
		expect(filterGalleryItems(items, { ...blank, type: 'image' }).map((i) => i.id)).toEqual([
			'img-mime',
			'img-ext'
		]);
		expect(filterGalleryItems(items, { ...blank, type: 'video' }).map((i) => i.id)).toEqual([
			'vid-mime',
			'vid-ext'
		]);
		expect(guessGalleryMediaKind(null, 'photo.JPG')).toBe('image');
		expect(guessGalleryMediaKind(null, 'clip.webm')).toBe('video');
		expect(guessGalleryMediaKind(null, 'notes.txt')).toBe('unknown');
		expect(guessGalleryMediaKind('image/png', 'weird.bin')).toBe('image');
	});

	test('uploader filter uses the stable uploadedBy id so offline uploaders stay filterable', () => {
		const items = [
			item({ id: '1', uploadedBy: 7, creator: null }),
			item({
				id: '2',
				uploadedBy: 7,
				creator: { dbUserId: 7, username: 'Rin', profilePicture: '', color: '' } as GalleryItem['creator']
			}),
			item({ id: '3', uploadedBy: 9, creator: null })
		];
		// Both rows for uploader 7 match even though one has no resolved creator.
		expect(filterGalleryItems(items, { ...blank, uploaderId: 7 }).map((i) => i.id)).toEqual(['1', '2']);
		expect(filterGalleryItems(items, { ...blank, uploaderId: 9 }).map((i) => i.id)).toEqual(['3']);
		expect(filterGalleryItems(items, { ...blank, uploaderId: 123 })).toEqual([]);
	});

	test('filters combine and apply BEFORE the recent/older split', () => {
		const items: GalleryItem[] = [];
		for (let n = 0; n < 10; n++) {
			items.push(
				item({
					id: `img-${n}`,
					attachmentName: n % 2 === 0 ? `match-${n}.png` : `other-${n}.png`,
					attachmentMime: 'image/png',
					uploadedBy: 7,
					uploadedAt: 1_700_000_000_000 - n
				})
			);
		}
		items.push(
			item({
				id: 'vid-0',
				attachmentName: 'match-clip.mp4',
				attachmentMime: 'video/mp4',
				uploadedBy: 7,
				uploadedAt: 1_700_000_100_000
			})
		);
		const filtered = filterGalleryItems(items, { query: 'match', type: 'video', uploaderId: 7 });
		expect(filtered.map((i) => i.id)).toEqual(['vid-0']);
		// The full image set filtered by query, then split: recent takes the
		// first 6 matches, older the rest — filters are never bypassed by the split.
		const matched = filterGalleryItems(items, { ...blank, query: 'match' });
		expect(matched).toHaveLength(6);
		const { recent, older } = splitGallerySections(matched, 6);
		expect(recent).toHaveLength(6);
		expect(older).toHaveLength(0);
		const all = filterGalleryItems(items, blank);
		const split = splitGallerySections(all, 6);
		expect(split.recent).toHaveLength(6);
		expect(split.older).toHaveLength(5);
		expect([...split.recent, ...split.older].map((i) => i.id)).toEqual(all.map((i) => i.id));
	});

	test('view state distinguishes an empty gallery from a filter with no matches', () => {
		expect(galleryViewState(0, 0)).toBe('empty');
		expect(galleryViewState(12, 0)).toBe('no-match');
		expect(galleryViewState(12, 3)).toBe('results');
	});
});
