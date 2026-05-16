import type { MessageEntity, User } from '$lib/socket';
import type { PlaceRecord } from '$lib/placeRegistry';
import {
	buildPlaceMessageEntity,
	buildPlaceSuggestionDetail,
	reconcileMessageEntities,
	searchPlaceMentionSuggestions
} from '$lib/placeRegistry';
import type { MentionSuggestion } from './types';

export type MentionUpdateResult =
	| { show: false }
	| { show: true; tokenStart: number; suggestions: MentionSuggestion[] };

export function computeMentionSuggestions(
	input: string,
	caretPos: number,
	users: User[],
	currentUserId: string | undefined,
	placeRegistry: PlaceRecord[]
): MentionUpdateResult {
	const beforeCaret = input.slice(0, caretPos);
	const atIndex = beforeCaret.lastIndexOf('@');
	if (atIndex < 0) return { show: false };

	const prefixChar = atIndex > 0 ? beforeCaret[atIndex - 1] : '';
	if (prefixChar && !/[\s(]/.test(prefixChar)) return { show: false };

	const query = beforeCaret.slice(atIndex + 1);
	if (/\s/.test(query)) return { show: false };

	const normalizedQuery = query.toLowerCase();

	const specials: MentionSuggestion[] = [
		{ key: 'special-all', label: '@all', value: 'all', kind: 'special' as const },
		{ key: 'special-here', label: '@here', value: 'here', kind: 'special' as const },
		{ key: 'special-everyone', label: '@everyone', value: 'everyone', kind: 'special' as const }
	].filter((e) => e.value.startsWith(normalizedQuery));

	const userEntries: MentionSuggestion[] = users
		.filter((u) => u.id !== currentUserId)
		.sort((a, b) => a.username.localeCompare(b.username))
		.map((u) => ({ key: `user-${u.id}`, label: `@${u.username}`, value: u.username, kind: 'user' as const }))
		.filter((e) => e.value.toLowerCase().startsWith(normalizedQuery));

	const placeEntries: MentionSuggestion[] = searchPlaceMentionSuggestions(normalizedQuery, 8).map((e) => ({
		key: e.key,
		label: e.label,
		value: e.value,
		kind: 'place' as const,
		detail: e.detail || buildPlaceSuggestionDetail(e.place),
		place: e.place,
		poi: e.poi
	}));

	const suggestions = [...specials, ...userEntries, ...placeEntries].slice(0, 8);
	if (suggestions.length === 0) return { show: false };

	return { show: true, tokenStart: atIndex, suggestions };
}

export interface ApplyMentionResult {
	input: string;
	cursor: number;
	entities: MessageEntity[];
}

export function applyMentionToInput(
	input: string,
	entities: MessageEntity[],
	suggestion: MentionSuggestion,
	tokenStart: number,
	caretPos: number
): ApplyMentionResult {
	const before = input.slice(0, tokenStart);
	const after = input.slice(caretPos);
	const mentionText = `@${suggestion.value}`;
	const needsSpace = after.length === 0 || !/^[\s.,!?;:)]/.test(after);
	const insertion = needsSpace ? `${mentionText} ` : mentionText;
	const nextInput = before + insertion + after;

	let nextEntities = reconcileMessageEntities(input, nextInput, entities);

	if (suggestion.kind === 'place' && suggestion.place) {
		const start = before.length;
		const end = start + mentionText.length;
		nextEntities = [
			...nextEntities,
			buildPlaceMessageEntity(suggestion.place, start, end, {
				poi: suggestion.poi,
				displayText: mentionText
			})
		].sort((a, b) => a.start - b.start || a.end - b.end);
	}

	return { input: nextInput, cursor: (before + insertion).length, entities: nextEntities };
}
