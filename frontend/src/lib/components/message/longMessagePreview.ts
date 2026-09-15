export const LONG_MESSAGE_READER_THRESHOLD = 2000;
export const LONG_MESSAGE_PREVIEW_LENGTH = 640;

export interface LongMessageStats {
	characterCount: number;
	wordCount: number;
	readMinutes: number;
}

export function shouldPromoteLongMessage(messageType: string, text: string): boolean {
	if (messageType !== 'text') return false;
	return Array.from(text.trim()).length > LONG_MESSAGE_READER_THRESHOLD;
}

export function createLongMessageExcerpt(
	text: string,
	maxLength = LONG_MESSAGE_PREVIEW_LENGTH
): string {
	const normalized = text.replace(/\r\n?/g, '\n').trim();
	const characters = Array.from(normalized);
	if (characters.length <= maxLength) return normalized;

	const head = characters.slice(0, maxLength).join('');
	const minimumNaturalBreak = Math.floor(maxLength * 0.65);
	const newlineBreak = head.lastIndexOf('\n');
	const spaceBreak = head.lastIndexOf(' ');
	const naturalBreak = Math.max(newlineBreak, spaceBreak);
	const end = naturalBreak >= minimumNaturalBreak ? naturalBreak : head.length;

	return `${head.slice(0, end).trimEnd()}…`;
}

export function getLongMessageStats(text: string): LongMessageStats {
	const normalized = text.trim();
	const characterCount = Array.from(normalized).length;
	const words = normalized ? normalized.split(/\s+/).filter(Boolean) : [];
	const wordCount = words.length;
	const readMinutes = Math.max(1, Math.ceil(wordCount / 220));

	return { characterCount, wordCount, readMinutes };
}
