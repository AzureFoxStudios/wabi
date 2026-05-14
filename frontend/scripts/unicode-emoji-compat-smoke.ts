import { computeUnicodeEmojiConversion } from '../src/lib/unicodeEmojisCore';
import type { Emoji } from '../src/lib/socket-types';

function expect(condition: unknown, message: string): void {
	if (!condition) {
		throw new Error(message);
	}
}

function makeEmoji(partial: Partial<Emoji> & Pick<Emoji, 'id' | 'name' | 'url'>): Emoji {
	return {
		id: partial.id,
		name: partial.name,
		url: partial.url,
		category: partial.category ?? 'default',
		isCustom: partial.isCustom ?? false,
		source: partial.source,
		type: partial.type,
		displayName: partial.displayName,
		artist: partial.artist
	};
}

function run(): void {
	const catalog: Emoji[] = [
		makeEmoji({
			id: 'e1',
			name: 'smile',
			url: 'https://cdn.example/emojis/1f604.png',
			source: 'default',
			category: 'default'
		}),
		makeEmoji({
			id: 'e2',
			name: 'openmoji_1F44B',
			url: 'https://cdn.example/openmoji/1F44B.svg',
			source: 'openmoji',
			category: 'openmoji'
		}),
		makeEmoji({
			id: 'e3',
			name: 'party_parrot',
			url: 'https://cdn.example/custom/party_parrot.gif',
			source: 'custom',
			category: 'custom',
			isCustom: true
		})
	];

	const mixed = computeUnicodeEmojiConversion(
		'Hello :smile: :openmoji_1F44B: :party_parrot: :unknown_token:',
		catalog,
		{ convertDefault: true, convertOpenmoji: true }
	);
	expect(
		mixed.convertedText.includes('😄'),
		'expected default shortcode to convert to Unicode'
	);
	expect(
		mixed.convertedText.includes('👋'),
		'expected OpenMoji shortcode to convert to Unicode'
	);
	expect(
		mixed.convertedText.includes(':party_parrot:'),
		'expected custom shortcode to remain unchanged'
	);
	expect(
		mixed.convertedText.includes(':unknown_token:'),
		'expected unknown shortcode to remain unchanged'
	);
	expect(mixed.convertedTokens === 2, 'expected exactly two converted tokens');
	expect(mixed.unknownTokens === 2, 'expected exactly two unknown/custom tokens');
	expect(mixed.shortcodeCollisions === 0, 'expected no collisions in mixed fixture');

	const defaultOnly = computeUnicodeEmojiConversion(
		':smile: :openmoji_1F44B:',
		catalog,
		{ convertDefault: true, convertOpenmoji: false }
	);
	expect(
		defaultOnly.convertedText === '😄 :openmoji_1F44B:',
		'expected source toggle to skip OpenMoji conversion'
	);

	const openmojiOnly = computeUnicodeEmojiConversion(
		':smile: :openmoji_1F44B:',
		catalog,
		{ convertDefault: false, convertOpenmoji: true }
	);
	expect(
		openmojiOnly.convertedText === ':smile: 👋',
		'expected source toggle to skip default conversion'
	);

	const allOff = computeUnicodeEmojiConversion(
		':smile: :openmoji_1F44B:',
		catalog,
		{ convertDefault: false, convertOpenmoji: false }
	);
	expect(
		allOff.convertedText === ':smile: :openmoji_1F44B:',
		'expected all-off toggle to preserve outgoing shortcodes'
	);
	expect(allOff.convertedTokens === 0, 'expected all-off converted count to remain zero');

	const collisionCatalog: Emoji[] = [
		makeEmoji({
			id: 'c1',
			name: 'dup_face',
			url: 'https://cdn.example/emojis/1f600.png',
			source: 'default'
		}),
		makeEmoji({
			id: 'c2',
			name: 'dup_face',
			url: 'https://cdn.example/emojis/1f603.png',
			source: 'default'
		})
	];
	const collision = computeUnicodeEmojiConversion(':dup_face:', collisionCatalog, {
		convertDefault: true,
		convertOpenmoji: true
	});
	expect(
		collision.convertedText === '😀',
		'expected deterministic first-match behavior for collisions'
	);
	expect(collision.shortcodeCollisions === 1, 'expected collision counter to increment');

	console.log('[unicode-emoji-compat-smoke] all checks passed');
}

run();
