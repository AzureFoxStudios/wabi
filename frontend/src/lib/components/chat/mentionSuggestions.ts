import type { User } from '$lib/socket';
import type { MessageEntity } from '$lib/socket-types';
import { channels } from '$lib/channelStore';
import { get } from 'svelte/store';
import { searchObjectRefs } from '$lib/objectRefRegistry';
import type { MentionSuggestion } from './types';

export type { MentionSuggestion } from './types';

export interface MentionResult {
	show: boolean;
	tokenStart: number;
	suggestions: MentionSuggestion[];
}

const OBJECT_KIND_BY_NS: Record<string, MentionSuggestion['kind']> = {
	f: 'forum_post',
	w: 'wiki_page',
	g: 'gallery_work',
	m: 'place'
};

function channelSuggestions(query: string, limit: number): MentionSuggestion[] {
	const q = query.toLowerCase();
	return get(channels)
		.filter((c) => c.name.toLowerCase().includes(q))
		.slice(0, limit)
		.map((c) => ({
			key: `channel-${c.id}`,
			label: c.name,
			value: c.name,
			kind: 'channel' as const,
			detail: c.type ?? ''
		}));
}

function objectSuggestions(query: string, limit: number): MentionSuggestion[] {
	return searchObjectRefs(query, limit).map((rec) => {
		const kind = (rec.kind as MentionSuggestion['kind']) ?? 'forum_post';
		return {
			key: `${kind}-${rec.id}`,
			label: rec.slug,
			value: rec.slug,
			kind,
			detail: rec.title
		};
	});
}

export function computeMentionSuggestions(
	input: string,
	caret: number,
	users: User[],
	currentUserId: string | undefined,
	_placeRegistry?: Array<{ id: string; name: string }>
): MentionResult {
	const beforeCaret = input.slice(0, caret);

	// Detect the last trigger char: @ (user) # (channel) ^ (object).
	const lastAt = beforeCaret.lastIndexOf('@');
	const lastHash = beforeCaret.lastIndexOf('#');
	const lastCaret = beforeCaret.lastIndexOf('^');
	const triggers = [
		{ ch: '@', idx: lastAt, mode: 'user' as const },
		{ ch: '#', idx: lastHash, mode: 'channel' as const },
		{ ch: '^', idx: lastCaret, mode: 'object' as const }
	];
	// Only consider the nearest trigger before the caret.
	triggers.sort((a, b) => b.idx - a.idx);
	const trigger = triggers[0];
	if (!trigger || trigger.idx < 0) {
		return { show: false, tokenStart: -1, suggestions: [] };
	}
	const after = beforeCaret.slice(trigger.idx + 1);
	if (/\s/.test(after)) {
		return { show: false, tokenStart: -1, suggestions: [] };
	}
	const query = after.toLowerCase();

	if (trigger.mode === 'user') {
		const suggestions: MentionSuggestion[] = users
			.filter((u) => u.id !== currentUserId)
			.filter((u) => u.username.toLowerCase().includes(query))
			.slice(0, 8)
			.map((u) => ({
				key: `user-${u.id}`,
				label: u.username,
				value: u.username,
				kind: 'user' as const,
				detail: u.handle ? `@${u.handle}` : undefined
			}));
		return { show: suggestions.length > 0, tokenStart: trigger.idx, suggestions };
	}

	if (trigger.mode === 'channel') {
		const suggestions = channelSuggestions(query, 8);
		return { show: suggestions.length > 0, tokenStart: trigger.idx, suggestions };
	}

	// object mode: support optional namespace prefix f/ w/ g/ m/
	let nsKind: MentionSuggestion['kind'] | undefined;
	let q = query;
	const ns = query.match(/^([fwgm])\/(.*)$/);
	if (ns) {
		nsKind = OBJECT_KIND_BY_NS[ns[1]];
		q = ns[2].toLowerCase();
	}
	let suggestions = objectSuggestions(q, 8);
	if (nsKind) {
		suggestions = suggestions.filter((s) => s.kind === nsKind);
	}
	return { show: suggestions.length > 0, tokenStart: trigger.idx, suggestions };
}

function mentionPrefix(kind: MentionSuggestion['kind']): string {
	if (kind === 'channel') return '#';
	if (kind === 'user' || kind === 'special' || kind === 'place') return '@';
	// forum_post / wiki_page / gallery_work use caret object refs
	return '^';
}

function toMessageEntityKind(
	kind: MentionSuggestion['kind']
): MessageEntity['kind'] {
	// Protocol MessageEntityKind has no "special"; treat as user mention.
	if (kind === 'special') return 'user';
	return kind;
}

export function applyMentionToInput(
	input: string,
	entities: MessageEntity[],
	suggestion: MentionSuggestion,
	tokenStart: number,
	caret: number
): { input: string; entities: MessageEntity[]; cursor: number } {
	const before = input.slice(0, tokenStart);
	const after = input.slice(caret);
	const mentionText = `${mentionPrefix(suggestion.kind)}${suggestion.value} `;
	const newInput = before + mentionText + after;
	const cursor = before.length + mentionText.length;
	const mentionEntity: MessageEntity = {
		kind: toMessageEntityKind(suggestion.kind),
		start: tokenStart,
		end: tokenStart + mentionText.length - 1,
		// Prefer place/object id when present; else value/label for users/channels.
		targetId: suggestion.place?.id ?? suggestion.value ?? suggestion.label,
		label: suggestion.label,
		displayText: mentionText.trimEnd(),
		layerId: suggestion.poi?.layerId ?? null,
		poiId: suggestion.poi?.id ?? null
	};
	const delta = mentionText.length - (caret - tokenStart);
	const newEntities: MessageEntity[] = entities
		.filter((e) => e.start < tokenStart || e.start >= caret)
		.map((e): MessageEntity => {
			if (e.start >= caret) {
				return { ...e, start: e.start + delta, end: e.end + delta };
			}
			return e;
		});
	newEntities.push(mentionEntity);
	newEntities.sort((a, b) => a.start - b.start || a.end - b.end);
	return { input: newInput, entities: newEntities, cursor };
}
