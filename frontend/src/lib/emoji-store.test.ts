import { afterEach, describe, expect, test } from 'bun:test';
import { get } from 'svelte/store';
import { clearServerEmotes, emojis, mergeServerEmotes, type ServerEmote } from './emoji-store';
import type { Emoji } from './socket-types';

const bundled: Emoji = { id: '1F44D', name: 'thumbs_up', url: '/openmoji/1F44D.svg', category: 'people', source: 'openmoji', isCustom: false };
const wave: ServerEmote = { emote_id: 'emo_wave', name: 'wave', image_url: '/uploads/wave.gif', created_at_micros: 1, created_by_user_id: 1 };
const hug: ServerEmote = { ...wave, emote_id: 'emo_hug', name: 'hug', image_url: '/uploads/hug.png', type: 'sticker' };

afterEach(() => emojis.set([]));

describe('server emoji snapshots', () => {
	test('a deletion broadcast removes omitted custom entries while preserving bundled emoji', () => {
		emojis.set([bundled]);
		mergeServerEmotes([wave, hug]);
		mergeServerEmotes([hug]);
		expect(get(emojis).map((emoji) => emoji.id)).toEqual(['1F44D', 'emo_hug']);
	});

	test('an empty community list clears custom entries after deletion or a server switch', () => {
		emojis.set([bundled]);
		mergeServerEmotes([wave]);
		mergeServerEmotes([]);
		expect(get(emojis)).toEqual([bundled]);
	});

	test('switching to another server replaces URLs even when its shortcode has the same ID', () => {
		emojis.set([bundled]);
		mergeServerEmotes([wave, hug]);
		mergeServerEmotes([{ ...wave, image_url: '/uploads/other-server-wave.png', display_name: 'Other wave' }]);
		expect(get(emojis)).toHaveLength(2);
		expect(get(emojis)[1]).toMatchObject({ id: 'emo_wave', url: '/uploads/other-server-wave.png', displayName: 'Other wave' });
	});

	test('explicit clearing also removes custom-source records with a missing legacy flag', () => {
		emojis.set([bundled, { ...bundled, id: 'legacy-custom', source: 'custom', isCustom: false }]);
		clearServerEmotes();
		expect(get(emojis)).toEqual([bundled]);
	});

	test('identical shortcodes on separate Authorities resolve against their own server', () => {
		emojis.set([bundled]);
		mergeServerEmotes([wave], 'https://first.example');
		expect(get(emojis)[1].url).toBe('https://first.example/uploads/wave.gif');
		mergeServerEmotes([wave], 'https://second.example');
		expect(get(emojis)[1].url).toBe('https://second.example/uploads/wave.gif');
		expect(get(emojis)[0].url).toBe('/openmoji/1F44D.svg');
	});

	test('absolute custom asset URLs keep their explicit host', () => {
		mergeServerEmotes([{ ...wave, image_url: 'https://cdn.example/wave.gif' }], 'https://authority.example');
		expect(get(emojis)[0].url).toBe('https://cdn.example/wave.gif');
	});
});
