import type { Emoji } from '$lib/socket';
import { applyChatFilter, expandInputWithChatAlias } from '$lib/chatEnhancements';
import { applyWriteUpperCase } from '$lib/composerEnhancements';
import { replaceEmojiShortcodesWithUnicode } from '$lib/unicodeEmojis';

export type ProcessTextResult = {
	blocked: boolean;
	text: string;
	reason?: string;
};

export interface ProcessTextOptions {
	writeUpperCaseEnabled: boolean;
	unicodeEmojisEnabled: boolean;
	emojis: Emoji[];
}

export function processOutgoingText(rawText: string, opts: ProcessTextOptions): ProcessTextResult {
	const aliasExpanded = expandInputWithChatAlias(rawText);
	const filtered = applyChatFilter(aliasExpanded, 'outgoing');

	if (filtered.hidden) {
		const terms = filtered.matchedTerms.join(', ');
		return {
			blocked: true,
			text: '',
			reason: terms ? `Message blocked by Chat Filter: ${terms}` : 'Message blocked by Chat Filter.'
		};
	}

	const finalText = filtered.text.trim();
	if (!finalText) {
		if (aliasExpanded.trim()) {
			return { blocked: true, text: '', reason: 'Message is empty after Chat Filter processing.' };
		}
		return { blocked: false, text: '' };
	}

	const uppercased = applyWriteUpperCase(finalText, opts.writeUpperCaseEnabled);
	const normalized = replaceEmojiShortcodesWithUnicode(uppercased, opts.emojis, opts.unicodeEmojisEnabled);
	return { blocked: false, text: normalized };
}

export interface MessageKind {
	type: 'text' | 'emoji';
	emojiUrl?: string;
	emojiName?: string;
}

export function detectMessageKind(text: string, emojis: Emoji[]): MessageKind {
	const emojiOnlyPattern = /^(?::[a-zA-Z0-9_+-]+:)+$/;
	if (!emojiOnlyPattern.test(text)) return { type: 'text' };

	const names = text.match(/:[a-zA-Z0-9_+-]+:/g)?.map((e) => e.slice(1, -1)) || [];
	const firstName = names[0];
	const firstEmoji = emojis.find((e) => e.name === firstName);
	return { type: 'emoji', emojiUrl: firstEmoji?.url, emojiName: firstName };
}

export interface BurstCheckResult {
	allowed: boolean;
	updatedTimestamps: number[];
}

export function checkSendBurst(
	timestamps: number[],
	now: number,
	limit: number,
	windowMs: number
): BurstCheckResult {
	const fresh = timestamps.filter((t) => now - t < windowMs);
	if (fresh.length >= limit) {
		return { allowed: false, updatedTimestamps: fresh };
	}
	return { allowed: true, updatedTimestamps: [...fresh, now] };
}

export interface CaptionOptions {
	maxLength: number;
	writeUpperCaseEnabled: boolean;
	unicodeEmojisEnabled: boolean;
	emojis: Emoji[];
}

// Returns the processed caption string, empty string for no-caption, or null if blocked/invalid.
export function processAttachmentCaption(rawCaption: string, opts: CaptionOptions): string | null {
	const trimmed = rawCaption.trim();
	if (!trimmed) return '';

	if (trimmed.length > opts.maxLength) {
		alert(`GIF caption cannot exceed ${opts.maxLength} characters.`);
		return null;
	}

	const result = processOutgoingText(trimmed, {
		writeUpperCaseEnabled: opts.writeUpperCaseEnabled,
		unicodeEmojisEnabled: opts.unicodeEmojisEnabled,
		emojis: opts.emojis
	});

	if (result.blocked) {
		alert(result.reason);
		return null;
	}

	if (result.text.length > opts.maxLength) {
		alert(`GIF caption cannot exceed ${opts.maxLength} characters.`);
		return null;
	}

	return result.text;
}
