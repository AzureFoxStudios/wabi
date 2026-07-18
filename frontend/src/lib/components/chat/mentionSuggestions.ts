import type { User } from '$lib/socket';
import { channels } from '$lib/channelStore';
import { get } from 'svelte/store';
import { searchObjectRefs } from '$lib/objectRefRegistry';

export interface MentionSuggestion {
	id: string;
	label: string;
	user?: User;
	// Extended kinds for chat object refs (chatref-03).
	kind?: 'special' | 'user' | 'place' | 'channel' | 'forum_post' | 'wiki_page' | 'gallery_work';
	targetId?: string;
	detail?: string;
}

export interface MentionResult {
	show: boolean;
	tokenStart: number;
	suggestions: MentionSuggestion[];
}

const OBJECT_KIND_BY_NS: Record<string, MentionSuggestion['kind']> = {
	f: 'forum_post',
	w: 'wiki_page',
	g: 'gallery_work',
	m: 'place',
};

function channelSuggestions(query: string, limit: number): MentionSuggestion[] {
	const q = query.toLowerCase();
	return get(channels)
		.filter((c) => c.name.toLowerCase().includes(q))
		.slice(0, limit)
		.map((c) => ({
			id: c.id,
			label: c.name,
			kind: 'channel' as const,
			targetId: c.id,
			detail: c.type ?? '',
		}));
}

function objectSuggestions(query: string, limit: number): MentionSuggestion[] {
	return searchObjectRefs(query, limit).map((rec) => ({
		id: rec.id,
		label: rec.slug,
		kind: rec.kind as MentionSuggestion['kind'],
		targetId: rec.id,
		detail: rec.title,
	}));
}

export function computeMentionSuggestions(
	input: string,
	caret: number,
	users: User[],
	currentUserId: string | undefined,
	placeRegistry?: Array<{ id: string; name: string }>
): MentionResult {
	const beforeCaret = input.slice(0, caret);

	// Detect the last trigger char: @ (user) # (channel) ^ (object).
	const lastAt = beforeCaret.lastIndexOf('@');
	const lastHash = beforeCaret.lastIndexOf('#');
	const lastCaret = beforeCaret.lastIndexOf('^');
	const triggers = [
		{ ch: '@', idx: lastAt, mode: 'user' as const },
		{ ch: '#', idx: lastHash, mode: 'channel' as const },
		{ ch: '^', idx: lastCaret, mode: 'object' as const },
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
			.map((u) => ({ id: u.id, label: u.username, user: u, kind: 'user' as const, targetId: u.id }));
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

export function applyMentionToInput(
	input: string,
	entities: Array<{ kind: string; start: number; end: number; targetId?: string; label?: string }>,
	suggestion: MentionSuggestion,
	tokenStart: number,
	caret: number
): { input: string; entities: Array<{ kind: string; start: number; end: number; targetId?: string; label?: string }>; cursor: number } {
	const before = input.slice(0, tokenStart);
	const after = input.slice(caret);
	const mentionText = `${suggestion.kind === 'channel' ? '#' : suggestion.kind && suggestion.kind !== 'user' ? '^' : '@'}${suggestion.label} `;
	const newInput = before + mentionText + after;
	const cursor = before.length + mentionText.length;
	const mentionEntity = {
		kind: suggestion.kind ?? 'user',
		start: tokenStart,
		end: tokenStart + mentionText.length - 1,
		targetId: suggestion.targetId ?? suggestion.label,
		label: suggestion.label,
	};
	const newEntities = entities
		.filter((e) => e.start < tokenStart || e.start >= caret)
		.map((e) => {
			if (e.start >= caret) {
				return { ...e, start: e.start + (mentionText.length - (caret - tokenStart)) };
			}
			return e;
		});
	newEntities.push(mentionEntity as any);
	return { input: newInput, entities: newEntities, cursor };
}
