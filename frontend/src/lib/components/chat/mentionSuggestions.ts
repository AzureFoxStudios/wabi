import type { User } from '$lib/socket';

export interface MentionSuggestion {
	id: string;
	label: string;
	user?: User;
}

export interface MentionResult {
	show: boolean;
	tokenStart: number;
	suggestions: MentionSuggestion[];
}

export function computeMentionSuggestions(
	input: string,
	caret: number,
	users: User[],
	currentUserId: string | undefined,
	placeRegistry: Array<{ id: string; name: string }>
): MentionResult {
	const beforeCaret = input.slice(0, caret);
	const atIndex = beforeCaret.lastIndexOf('@');
	if (atIndex < 0) return { show: false, tokenStart: -1, suggestions: [] };
	const afterAt = beforeCaret.slice(atIndex + 1);
	if (/\s/.test(afterAt)) return { show: false, tokenStart: -1, suggestions: [] };
	const query = afterAt.toLowerCase();
	const suggestions: MentionSuggestion[] = users
		.filter((u) => u.id !== currentUserId)
		.filter((u) => u.username.toLowerCase().includes(query))
		.slice(0, 8)
		.map((u) => ({ id: u.id, label: u.username, user: u }));
	return { show: suggestions.length > 0, tokenStart: atIndex, suggestions };
}

export function applyMentionToInput(
	input: string,
	entities: Array<{ type: string; offset: number; length: number }>,
	suggestion: MentionSuggestion,
	tokenStart: number,
	caret: number
): { input: string; entities: Array<{ type: string; offset: number; length: number }>; cursor: number } {
	const before = input.slice(0, tokenStart);
	const after = input.slice(caret);
	const mentionText = `@${suggestion.label} `;
	const newInput = before + mentionText + after;
	const cursor = before.length + mentionText.length;
	const mentionEntity = {
		type: 'mention',
		offset: tokenStart,
		length: mentionText.length - 1
	};
	const newEntities = entities
		.filter((e) => e.offset < tokenStart || e.offset >= caret)
		.map((e) => {
			if (e.offset >= caret) {
				return { ...e, offset: e.offset + (mentionText.length - (caret - tokenStart)) };
			}
			return e;
		});
	newEntities.push(mentionEntity);
	return { input: newInput, entities: newEntities, cursor };
}
