import { describe, expect, test } from 'bun:test';
import { emojiUploadError } from './emojiUploadErrors';

describe('emoji upload feedback', () => {
	test('shows the server collision and validation reason', async () => {
		for (const [status, error] of [[409, 'Emoji shortcode :wave: already exists. Choose another shortcode.'], [400, 'Asset type must be emoji or sticker']] as const) {
			expect(await emojiUploadError(new Response(JSON.stringify({ error }), { status }))).toBe(error);
		}
	});

	test('a non-JSON proxy failure includes its HTTP status', async () => {
		expect(await emojiUploadError(new Response('Bad gateway', { status: 502 })))
			.toBe('Upload failed (502). Please try again.');
	});
});
