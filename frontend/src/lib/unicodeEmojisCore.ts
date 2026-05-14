import type { Emoji } from './socket-types';

export type UnicodeEmojiSource = 'default' | 'openmoji';

export interface UnicodeEmojiConversionSettings {
	convertDefault: boolean;
	convertOpenmoji: boolean;
}

export interface UnicodeEmojiConversionPreview {
	convertedText: string;
	convertedTokens: number;
	unknownTokens: number;
	shortcodeCollisions: number;
}

const SHORTCODE_TOKEN_PATTERN = /:([a-zA-Z0-9_+-]+):/g;

function parseCodepointSequence(sequence: string): string | null {
	const parts = sequence
		.split('-')
		.map((part) => part.trim())
		.filter(Boolean);
	if (parts.length === 0) return null;

	const codepoints: number[] = [];
	for (const part of parts) {
		if (!/^[0-9a-fA-F]{1,6}$/.test(part)) return null;
		const value = Number.parseInt(part, 16);
		if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return null;
		codepoints.push(value);
	}

	try {
		return String.fromCodePoint(...codepoints);
	} catch {
		return null;
	}
}

function extractCodepointSequence(emoji: Emoji): string | null {
	const urlMatch = emoji.url.match(
		/\/([0-9a-fA-F]+(?:-[0-9a-fA-F]+)*)\.(?:png|svg|webp|gif)(?:[?#].*)?$/i
	);
	if (urlMatch?.[1]) return urlMatch[1];

	if (emoji.name.startsWith('openmoji_')) {
		const openmojiCodepoint = emoji.name.slice('openmoji_'.length);
		return openmojiCodepoint || null;
	}

	return null;
}

function resolveEmojiSource(emoji: Emoji): UnicodeEmojiSource | null {
	if (emoji.isCustom || emoji.source === 'custom') return null;
	if (emoji.source === 'openmoji' || emoji.name.startsWith('openmoji_')) {
		return 'openmoji';
	}
	return 'default';
}

function isSourceEnabled(
	source: UnicodeEmojiSource,
	settings: UnicodeEmojiConversionSettings
): boolean {
	if (source === 'openmoji') return settings.convertOpenmoji;
	return settings.convertDefault;
}

function resolveEmojiUnicode(emoji: Emoji): string | null {
	const codepointSequence = extractCodepointSequence(emoji);
	if (!codepointSequence) return null;
	return parseCodepointSequence(codepointSequence);
}

function buildUnicodeMap(
	emojiCatalog: Emoji[],
	settings: UnicodeEmojiConversionSettings
): { unicodeByShortcode: Map<string, string>; collisionCount: number } {
	const unicodeByShortcode = new Map<string, string>();
	let collisionCount = 0;
	for (const emoji of emojiCatalog) {
		const source = resolveEmojiSource(emoji);
		if (!source || !isSourceEnabled(source, settings)) continue;
		const shortcode = emoji.name?.trim();
		if (!shortcode) continue;
		const unicode = resolveEmojiUnicode(emoji);
		if (!unicode) continue;
		const existingUnicode = unicodeByShortcode.get(shortcode);
		if (existingUnicode) {
			if (existingUnicode !== unicode) {
				collisionCount += 1;
			}
			continue;
		}
		unicodeByShortcode.set(shortcode, unicode);
	}
	return { unicodeByShortcode, collisionCount };
}

export function computeUnicodeEmojiConversion(
	text: string,
	emojiCatalog: Emoji[],
	settings: UnicodeEmojiConversionSettings
): UnicodeEmojiConversionPreview {
	const { unicodeByShortcode, collisionCount } = buildUnicodeMap(emojiCatalog, settings);
	if (unicodeByShortcode.size === 0) {
		return {
			convertedText: text,
			convertedTokens: 0,
			unknownTokens: 0,
			shortcodeCollisions: collisionCount
		};
	}

	let convertedTokens = 0;
	let unknownTokens = 0;
	const convertedText = text.replace(SHORTCODE_TOKEN_PATTERN, (match, shortcode: string) => {
		const unicode = unicodeByShortcode.get(shortcode);
		if (!unicode) {
			unknownTokens += 1;
			return match;
		}
		convertedTokens += 1;
		return unicode;
	});

	return {
		convertedText,
		convertedTokens,
		unknownTokens,
		shortcodeCollisions: collisionCount
	};
}
