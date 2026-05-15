import type { User } from '$lib/socket';
import type { PlaceRecord } from '$lib/placeRegistry';
import { getAddressableUsers } from '$lib/components/DMMessageView.svelte'; // This would need to be adapted
import {
	searchPlaceMentionSuggestions,
	buildPlaceSuggestionDetail,
	buildPlaceMessageEntity,
	splitEntitiesForChunks,
	splitMessageForSending,
	reconcileMessageEntities,
	type PlaceRecord as PlaceRecordType
} from '$lib/placeRegistry';
import { replaceEmojiShortcodesWithUnicode, applyWriteUpperCase } from '$lib/composerEnhancements';
import { unicodeEmojiSettingsStore } from '$lib/unicodeEmojis';
import { get } from 'svelte/store';
import { tick } from 'svelte';

// Mention suggestion types
export type MentionSuggestion = {
	key: string;
	label: string;
	value: string;
	kind: 'user' | 'place';
	detail?: string;
	place?: PlaceRecordType;
	poi?: PlaceRecordType['pois'][number];
};

// State for mention handling
let mentionSuggestions: MentionSuggestion[] = [];
let mentionSelectedIndex = 0;
let mentionTokenStart = -1;
let showMentionSuggestions = false;
let mentionMenuContainer: HTMLElement | null = null;

/**
 * Update mention suggestions based on current textarea state
 * @param textareaElement - The textarea element
 * @param messageInput - Current message input
 * @param channelId - Current channel ID
 * @param currentUser - Current user
 * @param users - All users
 * @param channel - Current channel (for group chats)
 * @param placeRegistry - Place registry for place mentions
 * @param emojis - Emoji store
 */
export function updateMentionSuggestions(
	textareaElement: HTMLTextAreaElement | null,
	messageInput: string,
	channelId: string,
	currentUser: User | null,
	users: User[],
	channel: { type: string; members?: string[]; name?: string } | undefined,
	placeRegistry: PlaceRecordType[],
	emojis: Record<string, string>
): void {
	if (!textareaElement) {
		showMentionSuggestions = false;
		return;
	}

	const caret = textareaElement.selectionStart ?? messageInput.length;
	const beforeCaret = messageInput.slice(0, caret);
	const atIndex = beforeCaret.lastIndexOf('@');
	if (atIndex < 0) {
		showMentionSuggestions = false;
		return;
	}

	const prefixChar = atIndex > 0 ? beforeCaret[atIndex - 1] : '';
	if (prefixChar && !/\s|\(/.test(prefixChar)) {
		showMentionSuggestions = false;
		return;
	}

	const query = beforeCaret.slice(atIndex + 1);
	if (/\s/.test(query)) {
		showMentionSuggestions = false;
		return;
	}

	const normalizedQuery = query.toLowerCase();
	
	// Get addressable users (simplified - would need proper implementation)
	const userEntries = getAddressableUsers(
		{ type: channel?.type || 'direct', members: channel?.members, name: channel?.name },
		currentUser,
		users
	)
		.map((entry) => ({
			key: `user-${entry.id}`,
			label: `@${entry.username}`,
			value: entry.username,
			kind: 'user' as const,
			detail: entry.handle ? `@${entry.handle}` : undefined
		}))
		.filter((entry) => entry.value.toLowerCase().startsWith(normalizedQuery));

	// Load place registry if empty (simplified)
	if (!placeRegistry.length) {
		// In real implementation, this would be async
		// void loadPlaceRegistry();
	}

	const placeEntries = searchPlaceMentionSuggestions(normalizedQuery, 8).map((entry) => ({
		key: entry.key,
		label: entry.label,
		value: entry.value,
		kind: 'place' as const,
		detail: entry.detail || buildPlaceSuggestionDetail(entry.place),
		place: entry.place,
		poi: entry.poi
	}));

	const nextSuggestions = [...userEntries, ...placeEntries].slice(0, 8);
	if (nextSuggestions.length === 0) {
		showMentionSuggestions = false;
		return;
	}

	mentionTokenStart = atIndex;
	mentionSuggestions = nextSuggestions;
	mentionSelectedIndex = 0;
	showMentionSuggestions = true;
}

/**
 * Apply a mention suggestion at the given index
 * @param textareaElement - The textarea element
 * @param index - Index of the suggestion to apply
 * @param messageInput - Current message input
 * @param composerEntities - Current composer entities
 * @returns Updated message input and composer entities
 */
export async function applyMentionSuggestion(
	textareaElement: HTMLTextAreaElement | null,
	index: number,
	messageInput: string,
	composerEntities: any[]
): Promise<{ messageInput: string; composerEntities: any[] }> {
	if (!textareaElement || index < 0 || index >= mentionSuggestions.length || mentionTokenStart < 0) {
		return { messageInput, composerEntities };
	}

	const selected = mentionSuggestions[index];
	const caret = textareaElement.selectionStart ?? messageInput.length;
	const before = messageInput.slice(0, mentionTokenStart);
	const after = messageInput.slice(caret);
	const mentionText = `@${selected.value}`;
	const needsTrailingSpace = after.length === 0 || !/^[\\s.,!?;:)]/.test(after);
	const insertion = needsTrailingSpace ? `${mentionText} ` : mentionText;
	const nextMessageInput = before + insertion + after;
	const nextCursor = (before + insertion).length;

	let updatedEntities = reconcileMessageEntities(messageInput, nextMessageInput, composerEntities);
	if (selected.kind === 'place' && selected.place) {
		updatedEntities = [
			...updatedEntities,
			buildPlaceMessageEntity(selected.place, before.length, before.length + mentionText.length, {
				poi: selected.poi,
				displayText: mentionText
			})
		].sort((a, b) => a.start - b.start || a.end - b.end);
	}

	await tick();
	if (textareaElement) {
		textareaElement.focus();
		textareaElement.setSelectionRange(nextCursor, nextCursor);
	}

	return {
		messageInput: nextMessageInput,
		composerEntities: updatedEntities
	};
}

/**
 * Reset mention suggestion state
 */
export function resetMentionState(): void {
	mentionSuggestions = [];
	mentionSelectedIndex = 0;
	mentionTokenStart = -1;
	showMentionSuggestions = false;
	mentionMenuContainer = null;
}

/**
 * Getters for mention state (for use in component)
 */
export function getMentionSuggestions(): MentionSuggestion[] {
	return mentionSuggestions;
}

export function getMentionSelectedIndex(): number {
	return mentionSelectedIndex;
}

export function getShowMentionSuggestions(): boolean {
	return showMentionSuggestions;
}

export function getMentionMenuContainer(): HTMLElement | null {
	return mentionMenuContainer;
}

/**
 * Setters for mention state (for use in component)
 */
export function setMentionMenuContainer(container: HTMLElement | null): void {
	mentionMenuContainer = container;
}

export function setMentionSelectedIndex(index: number): void {
	mentionSelectedIndex = index;
}