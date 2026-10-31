/**
 * Words and small decisions for the Channel settings dialog (design contract §7.13, §8.9, §9).
 * Kept out of the component so the copy and the save rules can be tested without a DOM.
 */
import { retentionLabel } from '$lib/privacy/privacyState';
import type { SelectOption } from '$lib/components/ui/Select.svelte';
import {
	LIVE_RETENTION,
	MESSAGE_RETENTION_PRESETS,
	type MessageRetentionDuration
} from '../../../../../shared/messageRetention.js';

export type ChannelSettingsTab = 'general' | 'permissions' | 'retention';

/** A retention choice as the server stores it: a preset, null (keep forever) or 'live'. */
export type RetentionChoice = MessageRetentionDuration | null | typeof LIVE_RETENTION;

/** The select's value for "keep forever" (null cannot be an option value). */
export const FOREVER_VALUE = 'forever';

/** Kinds that have a chat stream, and so a message lifetime, spoilers and history to clear. */
export function isChatLikeKind(kind: string | null | undefined): boolean {
	return !['wiki', 'forum', 'gallery', 'voice', 'category'].includes(kind || 'text');
}

/** Dialog title in sentence case, named by kind ("Channel settings", "Voice room settings"). */
export function channelSettingsTitle(kind: string | null | undefined): string {
	switch (kind) {
		case 'wiki':
			return 'Wiki settings';
		case 'forum':
			return 'Forum settings';
		case 'gallery':
			return 'Gallery settings';
		case 'voice':
			return 'Voice room settings';
		case 'category':
			return 'Folder settings';
		default:
			return 'Channel settings';
	}
}

/** The scope note beside the title: the place itself, `#name` for chat rooms. */
export function channelSettingsNote(kind: string | null | undefined, name: string): string {
	return isChatLikeKind(kind) ? `#${name}` : name;
}

/** The sections this kind of channel has; Retention only where messages are kept. */
export function channelSettingsTabs(kind: string | null | undefined): { id: ChannelSettingsTab; label: string }[] {
	const tabs: { id: ChannelSettingsTab; label: string }[] = [
		{ id: 'general', label: 'General' },
		{ id: 'permissions', label: 'Permissions' }
	];
	if (isChatLikeKind(kind)) tabs.push({ id: 'retention', label: 'Retention' });
	return tabs;
}

/** Select value for a stored retention ('live' | preset | 'forever'). */
export function retentionValue(choice: RetentionChoice | undefined): string {
	if (choice === undefined) return '';
	return choice === null ? FOREVER_VALUE : choice;
}

/** Stored retention for a select value. */
export function retentionChoiceFor(value: string): RetentionChoice {
	return value === FOREVER_VALUE ? null : (value as RetentionChoice);
}

/** One option per lifetime, worded like the colophon's retention chip (§9.2). */
export function retentionOptions(): SelectOption[] {
	return [
		{ value: LIVE_RETENTION, label: retentionLabel(LIVE_RETENTION) ?? 'Live only · not saved' },
		{ value: FOREVER_VALUE, label: retentionLabel(FOREVER_VALUE) ?? 'Kept until someone deletes them' },
		...MESSAGE_RETENTION_PRESETS.map((preset) => ({
			value: preset,
			label: retentionLabel(preset) ?? preset,
			group: 'Timed'
		}))
	];
}

/** Who manages a room, in the same words as the gate's top option and Admin › Channels. */
export const MANAGERS_LABEL = 'Admins and owner';

/** The hint a read-only row adds for members who cannot change it. */
export const MANAGERS_ONLY_HINT = 'Only admins and the owner can change it.';

/** Who may open an ordinary room (the server's channel gate). Same words as Admin › Channels. */
export const GATE_OPTIONS: SelectOption[] = [
	{ value: '', label: 'All signed-in accounts' },
	{ value: 'member', label: 'Registered members' },
	{ value: 'moderator', label: 'Moderators and admins' },
	{ value: 'admin', label: MANAGERS_LABEL }
];

/**
 * Where the "Offline copies and older history" switch lives for a kind, or null where it means
 * nothing. Chat streams keep it with the other retention rows; voice rooms, forums, wikis and
 * galleries have no Retention section, so it sits in General (their message lists still use it
 * for Load more and full-history search). Direct messages never had it, and a folder holds no
 * messages of its own.
 */
export function persistToggleTab(kind: string | null | undefined): ChannelSettingsTab | null {
	const k = kind || 'text';
	if (k === 'dm' || k === 'category') return null;
	return isChatLikeKind(k) ? 'retention' : 'general';
}

/** Rooms the gate applies to: not conversations, folders or the Welcome room. */
export function hasChannelGate(kind: string | null | undefined): boolean {
	return !['dm', 'group', 'category', 'reception'].includes(kind || 'text');
}

/** Only owners and admins may change a room's settings (the server checks the same). */
export function canManageChannel(role: string | null | undefined): boolean {
	return role === 'owner' || role === 'admin';
}

export interface ChannelDraftBaseline {
	name: string;
	description: string;
	forceSpoiler: boolean;
	watchQueueEnabled: boolean;
	persistMessages: boolean;
	voiceUserLimit: string;
	voiceForceSolo: boolean;
	renderWindow: number;
	gate: string | null;
	/** Live rooms: post a line when someone goes away or comes back. The client default is on. */
	afkAnnounce: boolean;
}

export type ChannelDraft = ChannelDraftBaseline & {
	/** Unsaved lifetime choice; undefined when unchanged. */
	retention: RetentionChoice | undefined;
	/** Any of the Live room fields typed in. */
	liveFields: string[];
};

/** True when Save would change something. Unloaded gates (null) never count as a change. */
export function channelDraftDirty(draft: ChannelDraft, base: ChannelDraftBaseline): boolean {
	if (draft.retention !== undefined) return true;
	if (draft.liveFields.some((value) => value.trim() !== '')) return true;
	if ((draft.name.trim() || base.name) !== base.name) return true;
	if (draft.gate !== null && base.gate !== null && draft.gate !== base.gate) return true;
	return (
		draft.description !== base.description ||
		draft.forceSpoiler !== base.forceSpoiler ||
		draft.watchQueueEnabled !== base.watchQueueEnabled ||
		draft.persistMessages !== base.persistMessages ||
		draft.voiceUserLimit.trim() !== base.voiceUserLimit ||
		draft.voiceForceSolo !== base.voiceForceSolo ||
		draft.renderWindow !== base.renderWindow ||
		draft.afkAnnounce !== base.afkAnnounce
	);
}

/** Next tab for a key in a vertical tablist (↑/↓, Home/End); null when the key does nothing. */
export function nextTab<T>(tabs: T[], current: T, key: string): T | null {
	const index = tabs.indexOf(current);
	if (index < 0 || !tabs.length) return null;
	if (key === 'ArrowDown' || key === 'ArrowRight') return tabs[(index + 1) % tabs.length];
	if (key === 'ArrowUp' || key === 'ArrowLeft') return tabs[(index - 1 + tabs.length) % tabs.length];
	if (key === 'Home') return tabs[0];
	if (key === 'End') return tabs[tabs.length - 1];
	return null;
}
