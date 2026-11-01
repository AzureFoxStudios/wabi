<script lang="ts">
	import ScreenSharePreview from './ScreenSharePreview.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import type { IconName } from '$lib/components/ui/icons';
	import { onMount } from 'svelte';
	import { slide, fly } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { cubicOut } from 'svelte/easing';
	import { longpress } from '$lib/actions/longpress';
	import type { Channel } from '$lib/socket';
	import { currentUser, channelUnreadCounts, currentChannel, voiceChannelMembers, users, serverMembers } from '$lib/socket';
	import { isMuted as callMuted, isDeafened as callDeafened, isLocalSpeaking, speakingUsers, voiceTransmitMode, listeningVoiceChannels } from '$lib/calling';
	import { voiceCallRecordingParticipants } from '$lib/callRecordingPresence';
	import { displayEnhancementSettingsStore } from '$lib/displayEnhancements';
	import { isLikelyNsfwChannel } from '$lib/displayEnhancements';
	import { isLiveRetention } from '../../../../../shared/messageRetention.js';
	import { retentionLabel } from '$lib/privacy/privacyState';
	import { activeServerSettings } from '$lib/serverSettings';
	import { inkFor } from '$lib/theme/identity';
	import { _ } from '$lib/i18n';
	import {
		formatBadge,
		formatVoiceDuration as formatVoiceDurationLabel,
		formatVoiceOccupancy,
		getVoiceOccupancyTitle,
		splitVoiceParticipants,
		unreadLabel,
		voiceMemberState,
		type SidebarPlace,
		type VoiceMemberState
	} from './channelSidebarHelpers';

	export let channels: Channel[];
	export let threadChannelsByParent: Record<string, Channel[]> = {};
	export let followedChannelIds: Set<string> = new Set();
	export let liveWhiteboardChannelIds: Set<string> = new Set();
	export let breakoutChannelsByParent: Record<string, Channel[]> = {};
	export let connectedVoiceChannelIds: Set<string> = new Set();
	export let runtimeActiveVoiceChannelId: string | null = null;
	export let voiceDropTargetChannelId: string | null = null;
	export let voicePresenceSince: Map<string, number> = new Map();
	export let voiceDurationMode: 'off' | 'others' | 'all' = 'off';
	export let nowMs: number = 0;
	/**
	 * What the current channel's row is (spec §5.2, §7.11): 'channel' = the current page (raise
	 * fill, sig glyph, aria-current="page"); 'context' = another workspace owns center stage, so
	 * the row keeps only its sig glyph; anything else = Server home or DMs is current instead.
	 */
	export let currentPlace: SidebarPlace = 'channel';
	/** The 60px rail: glyph tiles, names in tooltips, no tray, no rosters (spec §8.1). */
	export let compact = false;

	/**
	 * DnD contract (single-coordinator model): rows only START drags and act
	 * as geometry anchors (data-drop-anchor). All dragover/drop targeting is
	 * owned by the .channel-list coordinator in ChannelSidebar.svelte.
	 */
	export let reorderEnabled: boolean = false;
	/** True while the sidebar search filter is active — flips suppressed. */
	export let suppressFlip: boolean = false;

	export let onChannelClick: (channelId: string) => void;
	export let onChannelButtonClick: (channelId: string, event: MouseEvent) => void;
	export let onVoiceChannelClick: (channelId: string, event?: MouseEvent) => void;
	export let onChannelRightClick: (event: MouseEvent, channel: Channel) => void;
	export let onChannelLongPress: (event: TouchEvent, channel: Channel) => void;
	export let onToggleChannelFollow: (channelId: string, event?: Event) => void;
	export let onOpenChannelSettings: (channel: Channel) => void;
	export let onShowPinnedMessages: (channelId: string) => void;
	export let onToggleListenChannel: (channelId: string) => void;
	export let onOpenVoiceChannelWhiteboard: (channelId: string, event?: Event) => void;
	export let canDragVoiceMember: (memberUserId: string) => boolean = () => false;
	export let canKickVoiceMember: (memberUserId: string) => boolean = () => false;
	export let onVoiceMemberDragStart: (event: DragEvent, channelId: string, memberUserId: string) => void = () => {};
	export let onVoiceMemberDragEnd: () => void = () => {};
	export let onKickVoiceMember: (channelId: string, memberUserId: string) => void = () => {};
	export let onVoiceChannelDragOver: (event: DragEvent, channelId: string) => void = () => {};
	export let onVoiceChannelDragLeave: (channelId: string) => void = () => {};
	export let onVoiceChannelDrop: (event: DragEvent, channelId: string) => void = () => {};
	export let isChannelDragging: (channelId: string) => boolean = () => false;
	export let onChannelDragStart: (e: DragEvent, channelId: string) => void = () => {};
	export let onChannelDragEnd: () => void = () => {};

	// onToggleListenChannel stays part of the list's contract (VoiceUserCard owns the listen
	// chips today); referencing it keeps the prop live for callers that pass it.
	void onToggleListenChannel;

	let reducedMotion = false;
	onMount(() => {
		if (typeof window === 'undefined' || !window.matchMedia) return;
		const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
		const read = () => {
			reducedMotion = mq.matches || document.documentElement.dataset.motion === 'reduce';
		};
		read();
		mq.addEventListener('change', read);
		return () => mq.removeEventListener('change', read);
	});

	/** Settle animation after a commit; instant under reduced motion / search. */
	$: rowFlipParams =
		reducedMotion || suppressFlip ? { duration: 0 } : { duration: 220, easing: cubicOut };
	/** Entrances: opacity plus at most an 8px translate (spec §4.7). */
	$: memberIn = reducedMotion ? { duration: 0 } : { x: -8, duration: 180, opacity: 0, easing: cubicOut };
	$: memberOut = reducedMotion ? { duration: 0 } : { x: -8, duration: 135, opacity: 0 };
	$: rosterSlide = reducedMotion ? { duration: 0 } : { duration: 180, easing: cubicOut };

	function channelType(ch: Channel): string {
		return (ch.type as string | undefined) || 'text';
	}

	function isVoiceLike(ch: Channel): boolean {
		return channelType(ch) === 'voice';
	}

	function isNsfwTaggedChannel(channel: Channel): boolean {
		return isLikelyNsfwChannel(channel.name, channel.description);
	}

	/** Leading glyph per kind (spec §6): text channels typeset '#', every other kind an icon. */
	function channelGlyph(ch: Channel): IconName | null {
		switch (channelType(ch)) {
			case 'voice': return 'voice';
			case 'gallery': return 'image';
			case 'forum': return 'forum';
			case 'wiki': return 'book';
			case 'lore': return 'box';
			case 'planning': return 'columns';
			case 'group': return 'users';
			// Welcome (the arrival page) is not a text channel: it gets its own glyph, not '#'.
			case 'reception': return 'home';
			default: return null;
		}
	}

	/**
	 * Row state (Svelte 5 reactivity contract — do not regress): every store read happens in a
	 * top-level `$:` derivation; the template only reads the precomputed values (map lookups),
	 * so join/leave/unread/speaking events always re-render.
	 */
	$: bookmarkedIds = (() => {
		const userId = $currentUser?.id;
		const ids = new Set<string>();
		if (!userId) return ids;
		for (const channel of channels) if (channel.pinnedBy?.includes(userId)) ids.add(channel.id);
		return ids;
	})();
	// Read the store itself: isServerChannelMuted() indexes the store object, not its value, so it
	// never sees a mute (see the package handoff).
	$: mutedIds = new Set($activeServerSettings.mutedChannelIds ?? []);
	$: nsfwTagsOn = $displayEnhancementSettingsStore.betterNsfwTagEnabled;
	$: selectedChannelId = $currentChannel;

	// ---- voice rows (Svelte 5 reactivity contract — do not regress) ----
	// In Svelte 5 legacy mode, template expressions that CALL script functions
	// compile to `$.untrack(() => fn(args))`: arguments stay tracked, but every
	// store/prop read INSIDE the function body registers NO dependency. The
	// helpers this list used to call from the template (getVoiceMembers,
	// visibleVoiceMembers, isMemberSpeaking, isConnectedToVoice, ...) made the
	// roster chips blind to join/leave/speaking events until an unrelated
	// signal fired — the "no live chip sync" field report (2026-08-27; the
	// sibling VoiceChannelList had the same bug class, fixed 2026-08-24).
	// Contract (mirrors VoiceChannelList, enforced by
	// svelte5ReactivityTripwire.test.ts):
	//   1. All store/prop reads happen in the top-level `$:` derivation below.
	//   2. The template consumes precomputed row values via member access.
	//   3. Pure helpers receive every reactive input as an ARGUMENT.

	interface RowMember {
		userId: string;
		socketId?: string;
		username?: string;
		profilePicture?: string;
		screenShareEnabled?: boolean;
		isMuted?: boolean;
		isDeafened?: boolean;
		isListenOnly?: boolean;
	}

	/** One person under a voice room: you first (when connected), then everyone else. */
	interface VoicePerson {
		key: string;
		userId: string;
		name: string;
		initial: string;
		picture: string | null;
		inkStyle: string;
		self: boolean;
		speaking: boolean;
		recording: boolean;
		presenceStart: number | null;
		screenShareEnabled: boolean;
		state: VoiceMemberState;
	}

	interface VoiceRow {
		members: RowMember[];
		people: VoicePerson[];
		isConnected: boolean;
		recordingCount: number;
		showMembers: boolean;
	}

	function buildVoiceRow(
		channelId: string,
		ctx: {
			membersMap: Record<string, RowMember[]>;
			connectedIds: Set<string>;
			primaryId: string | null;
			listeningIds: string[];
			transmitMode: string;
			speaking: Set<string>;
			recordingByChannel: Record<string, Array<{ userId: string }>>;
			currentUserId: string | null;
			currentDbUserId: number | null;
			self: { username: string; profilePicture: string | null; color: string | null } | null;
			selfMuted: boolean;
			selfDeafened: boolean;
			selfLocallySpeaking: boolean;
			presenceSince: Map<string, number>;
			colors: Map<string, string>;
			ink: (color: string | null | undefined) => string;
		}
	): VoiceRow {
		const members = ctx.membersMap[channelId] || [];
		const isConnected = ctx.connectedIds.has(channelId);

		const selfMatches = (userId: string): boolean =>
			userId === ctx.currentUserId ||
			(ctx.currentDbUserId != null && userId === `user-${ctx.currentDbUserId}`);
		const selfStableId =
			ctx.currentDbUserId != null ? `user-${ctx.currentDbUserId}` : ctx.currentUserId;

		// 'all-listening' broadcast: self speaks into every connected channel;
		// otherwise only the runtime-active (primary) channel shows self speaking.
		const isSelfSpeaking =
			ctx.selfLocallySpeaking &&
			(ctx.transmitMode === 'all-listening' ? isConnected : ctx.primaryId === channelId);

		const recordingParticipants = ctx.recordingByChannel[channelId] || [];
		const recordingIds = new Set(recordingParticipants.map((p) => p.userId));

		const people: VoicePerson[] = [];
		if (isConnected && ctx.self) {
			let selfPresenceStart: number | null = null;
			for (const candidate of [selfStableId, ctx.currentUserId]) {
				const start = candidate ? ctx.presenceSince.get(`${channelId}::${candidate}`) : undefined;
				if (start) { selfPresenceStart = start; break; }
			}
			const name = ctx.self.username || 'You';
			people.push({
				key: `self:${ctx.currentUserId ?? 'me'}`,
				userId: ctx.currentUserId ?? '',
				name,
				initial: (name.charAt(0) || '?').toUpperCase(),
				picture: ctx.self.profilePicture,
				inkStyle: ctx.ink(ctx.self.color),
				self: true,
				speaking: isSelfSpeaking,
				recording: selfStableId != null && recordingIds.has(selfStableId),
				presenceStart: selfPresenceStart,
				screenShareEnabled: false,
				state: voiceMemberState({
					speaking: isSelfSpeaking,
					isMuted: ctx.selfMuted,
					isDeafened: ctx.selfDeafened,
					// Listening in on a room that is not your mic room.
					isListenOnly: ctx.primaryId !== channelId && ctx.listeningIds.includes(channelId)
				})
			});
		}
		for (const member of members) {
			if (selfMatches(member.userId)) continue;
			const speaking = ctx.speaking.has(member.userId);
			const name = member.username || member.userId;
			people.push({
				key: member.userId,
				userId: member.userId,
				name,
				initial: (name.charAt(0) || '?').toUpperCase(),
				picture: member.profilePicture || null,
				inkStyle: ctx.ink(ctx.colors.get(member.userId)),
				self: false,
				speaking,
				recording: recordingIds.has(member.userId),
				presenceStart: ctx.presenceSince.get(`${channelId}::${member.userId}`) ?? null,
				screenShareEnabled: member.screenShareEnabled || false,
				state: voiceMemberState({
					speaking,
					isMuted: member.isMuted,
					isDeafened: member.isDeafened,
					isListenOnly: member.isListenOnly
				})
			});
		}

		return {
			members,
			people,
			isConnected,
			recordingCount: recordingParticipants.length,
			showMembers: isConnected || members.length > 0
		};
	}

	/** Every channel that renders a voice row: list channels + breakout children. */
	function collectRowChannels(list: Channel[], breakouts: Record<string, Channel[]>): Channel[] {
		const seen = new Set<string>();
		const out: Channel[] = [];
		const push = (group: Channel[] | undefined) => {
			for (const channel of group ?? []) {
				if (!seen.has(channel.id)) { seen.add(channel.id); out.push(channel); }
			}
		};
		push(list);
		for (const children of Object.values(breakouts)) push(children);
		return out;
	}

	$: selfLocallySpeakingRow = $isLocalSpeaking && !$callMuted && !$callDeafened;

	/** Identity colors by every id a voice roster may use for a person (socket id, user-<db id>). */
	$: memberColors = (() => {
		const map = new Map<string, string>();
		for (const person of [...$serverMembers, ...$users]) {
			if (!person?.color) continue;
			if (person.id) map.set(person.id, person.color);
			if (person.dbUserId != null) map.set(`user-${person.dbUserId}`, person.color);
		}
		return map;
	})();

	$: voiceRowsById = (() => {
		const map = new Map<string, VoiceRow>();
		const ctx = {
			membersMap: $voiceChannelMembers as Record<string, RowMember[]>,
			connectedIds: connectedVoiceChannelIds,
			primaryId: runtimeActiveVoiceChannelId,
			listeningIds: $listeningVoiceChannels,
			transmitMode: $voiceTransmitMode,
			speaking: $speakingUsers,
			recordingByChannel: $voiceCallRecordingParticipants,
			currentUserId: $currentUser?.id ?? null,
			currentDbUserId: $currentUser?.dbUserId ?? null,
			self: $currentUser
				? {
						username: $currentUser.username,
						profilePicture: $currentUser.profilePicture || null,
						color: $currentUser.color || null
					}
				: null,
			selfMuted: $callMuted,
			selfDeafened: $callDeafened,
			selfLocallySpeaking: selfLocallySpeakingRow,
			presenceSince: voicePresenceSince,
			colors: memberColors,
			ink: $inkFor
		};
		for (const channel of collectRowChannels(channels, breakoutChannelsByParent)) {
			map.set(channel.id, buildVoiceRow(channel.id, ctx));
		}
		return map;
	})();

	/** Rooms whose "and N more" was opened (local view state only); the same toggle folds back. */
	let expandedRooms = new Set<string>();
	function toggleRoom(channelId: string) {
		if (expandedRooms.has(channelId)) expandedRooms.delete(channelId);
		else expandedRooms.add(channelId);
		expandedRooms = expandedRooms;
	}

	type Roster = { shown: VoicePerson[]; hidden: number; collapsible: boolean };
	const EMPTY_ROSTER: Roster = { shown: [], hidden: 0, collapsible: false };

	/** Pure duration formatter — `nowMs` arrives as a tracked argument. */
	function formatVoiceDuration(startMs: number | null, now: number): string {
		return formatVoiceDurationLabel(startMs, now);
	}

	/** Unread count for a row that is not the selected one (the open channel is read). */
	function unreadFor(counts: Record<string, number>, channelId: string, selectedId: string | null): number {
		if (channelId === selectedId) return 0;
		const count = Number(counts[channelId]);
		return Number.isFinite(count) && count > 0 ? count : 0;
	}
</script>

<!--
	The voice roster under a room (spec §7.11 .w-vp): at most five people, then a toggle that reads
	"and N more" and, once opened, "Show less". The toggle sits after the list, not inside it.
-->
{#snippet voiceRoster(room: Channel, roster: Roster)}
	<div role="list" aria-label={`In ${room.name}`}>
		{#each roster.shown as person (person.key)}
			<div
				class="voice-member-item"
				class:speaking={person.speaking}
				class:voice-member-draggable={!person.self && canDragVoiceMember(person.userId)}
				role="listitem"
				draggable={!person.self && canDragVoiceMember(person.userId)}
				on:dragstart={(event) => onVoiceMemberDragStart(event, room.id, person.userId)}
				on:dragend={onVoiceMemberDragEnd}
				in:fly={memberIn}
				out:fly={memberOut}
			>
				{#if person.picture}
					<img class="voice-member-avatar" src={person.picture} alt="" />
				{:else}
					<span class="voice-member-avatar voice-avatar-fallback" style={person.inkStyle} aria-hidden="true">{person.initial}</span>
				{/if}
				<span class="voice-member-name">{person.name}{#if person.self}<span class="sr-only"> (you)</span>{/if}</span>
				<span class="voice-member-extra">
					{#if person.self}
						<ScreenSharePreview channelId={room.id} userId={person.userId} username={person.name} self />
					{:else}
						<ScreenSharePreview channelId={room.id} userId={person.userId} username={person.name} announced={person.screenShareEnabled} />
					{/if}
					{#if person.recording}
						<span class="row-tag row-tag--rec"><span class="w-dot w-dot--danger" aria-hidden="true"></span>Rec</span>
					{/if}
					{#if voiceDurationMode === 'all' || (voiceDurationMode === 'others' && !person.self)}
						<span class="w-count voice-member-duration">{formatVoiceDuration(person.presenceStart, nowMs)}</span>
					{/if}
					{#if !person.self && canKickVoiceMember(person.userId)}
						<button
							type="button"
							class="w-ibtn w-ibtn--sm voice-member-kick"
							on:click={(e) => { e.stopPropagation(); onKickVoiceMember(room.id, person.userId); }}
							title={`Remove ${person.name} from voice`}
							aria-label={`Remove ${person.name} from voice`}
						><Icon name="logout" size={14} /></button>
					{/if}
				</span>
				<span class="voice-member-state" title={person.state.label}>
					<Icon name={person.state.icon} size={14} />
					<span class="sr-only">{person.state.label}</span>
				</span>
			</div>
		{/each}
	</div>
	{#if roster.hidden > 0 || roster.collapsible}
		<button
			type="button"
			class="voice-member-more"
			aria-expanded={roster.collapsible}
			on:click={() => toggleRoom(room.id)}
		>{roster.collapsible ? $_('messages.show_less') : $_('sidebar.and_more', { values: { count: roster.hidden } })}</button>
	{/if}
{/snippet}

{#each channels as channel (channel.id)}
	{@const isVoice = isVoiceLike(channel)}
	{@const glyph = channelGlyph(channel)}
	{@const row = isVoice ? voiceRowsById.get(channel.id) : undefined}
	{@const channelIsConnected = isVoice && (row?.isConnected ?? false)}
	{@const isSelected = !isVoice && selectedChannelId === channel.id}
	{@const isPage = isSelected && currentPlace === 'channel'}
	{@const isContext = isSelected && currentPlace === 'context'}
	{@const unread = isVoice ? 0 : unreadFor($channelUnreadCounts, channel.id, selectedChannelId)}
	{@const occupancy = row ? row.members.length : 0}
	{@const roster = row ? splitVoiceParticipants(row.people, expandedRooms.has(channel.id)) : EMPTY_ROSTER}
	{@const followed = followedChannelIds.has(channel.id)}
	{@const bookmarked = !isVoice && bookmarkedIds.has(channel.id)}
	{@const whiteboardLive = liveWhiteboardChannelIds.has(channel.id)}
	<div class="unified-channel-wrap" animate:flip={rowFlipParams}>
	<div
		class="channel-item unified-channel-item"
		class:voice-channel-item={isVoice}
		class:active={isPage}
		class:context={isContext}
		class:unread={unread > 0}
		class:connected={channelIsConnected}
		class:live={isVoice && occupancy > 0}
		class:followed
		class:muted={mutedIds.has(channel.id)}
		class:voice-drop-target={isVoice && voiceDropTargetChannelId === channel.id}
		class:is-dragging={isChannelDragging(channel.id)}
		role="group"
		draggable={reorderEnabled}
		data-drop-anchor="channel"
		data-channel-id={channel.id}
		data-parent-folder={channel.parentId ?? ''}
		on:contextmenu={(e) => onChannelRightClick(e, channel)}
		use:longpress={{ onLongPress: (e) => onChannelLongPress(e, channel) }}
		on:dragstart|stopPropagation={(e) => onChannelDragStart(e, channel.id)}
		on:dragover={(e) => { if (isVoice) onVoiceChannelDragOver(e, channel.id); }}
		on:dragleave={() => { if (isVoice) onVoiceChannelDragLeave(channel.id); }}
		on:drop={(e) => { if (isVoice) onVoiceChannelDrop(e, channel.id); }}
		on:dragend={onChannelDragEnd}
	>
		{#snippet channelButton()}
			<button
				type="button"
				class="channel-btn"
				aria-current={isPage ? 'page' : isContext ? 'location' : undefined}
				on:click={(event) => (isVoice ? onVoiceChannelClick(channel.id, event) : onChannelButtonClick(channel.id, event))}
				on:auxclick={(event) => {
					if (!isVoice && event.button === 1 && event.altKey) {
						event.preventDefault();
						onChannelButtonClick(channel.id, event as unknown as MouseEvent);
					}
				}}
			>
				<span class="row-glyph" aria-hidden="true">
					{#if glyph}<Icon name={glyph} size={18} />{:else}<span class="row-hash">#</span>{/if}
				</span>
				<span class="row-name">{channel.name}</span>
				<span class="row-trail">
					{#if isLiveRetention(channel.autoDeleteAfter)}
						<!-- Retention words (§9.2), shortened: "Live" alone would read as a live voice room. -->
						<span class="row-tag" title={retentionLabel('live') ?? undefined} aria-hidden="true">Not saved</span>
					{/if}
					{#if nsfwTagsOn && isNsfwTaggedChannel(channel)}
						<span class="row-tag">NSFW</span>
					{/if}
					{#if mutedIds.has(channel.id)}
						<span class="row-tag">Muted</span>
					{/if}
					{#if bookmarked}
						<span class="row-mark" title="Bookmarked for the quick switcher" aria-hidden="true"><Icon name="star" size={14} /></span>
					{/if}
					{#if whiteboardLive}
						<span class="row-mark" title="Someone is on this whiteboard" aria-hidden="true"><Icon name="whiteboard" size={14} /></span>
					{/if}
					{#if isVoice && row && row.recordingCount > 0}
						<span class="row-tag row-tag--rec" title={`${row.recordingCount} recording in this call`}><span class="w-dot w-dot--danger" aria-hidden="true"></span>Rec</span>
					{/if}
					{#if unread > 0}
						<span class="w-badge" aria-hidden="true">{formatBadge(unread)}</span>
					{/if}
					{#if isVoice && (occupancy > 0 || channel.voiceSettings?.userLimit)}
						<span class="w-count" title={getVoiceOccupancyTitle(channel, occupancy)} aria-hidden="true">{formatVoiceOccupancy(channel, occupancy)}</span>
					{/if}
				</span>
				{#if isLiveRetention(channel.autoDeleteAfter)}<span class="sr-only">, {retentionLabel('live')}</span>{/if}
				{#if bookmarked}<span class="sr-only">, bookmarked</span>{/if}
				{#if whiteboardLive}<span class="sr-only">, whiteboard in use</span>{/if}
				{#if unread > 0}<span class="sr-only">, {unreadLabel(unread)}</span>{/if}
				{#if isVoice && occupancy > 0}<span class="sr-only">, {getVoiceOccupancyTitle(channel, occupancy)}</span>{/if}
				{#if channelIsConnected}<span class="sr-only">, connected</span>{/if}
			</button>
		{/snippet}
		<!-- The rail shows names in tooltips; the full column shows the names, so no tooltip is mounted. -->
		{#if compact}
			<Tooltip text={channel.name} placement="right" describe={false}>{@render channelButton()}</Tooltip>
		{:else}
			{@render channelButton()}
			<div class="row-tray">
				{#if isVoice}
					<!-- Voice rooms cannot be followed (the follow feed is about messages), so no bell. -->
					<button
						type="button"
						class="w-ibtn w-ibtn--sm"
						aria-label={`Open ${channel.name} whiteboard`}
						title="Whiteboard"
						on:click|stopPropagation={(event) => onOpenVoiceChannelWhiteboard(channel.id, event)}
					><Icon name="whiteboard" size={16} /></button>
				{:else}
					<button
						type="button"
						class="w-ibtn w-ibtn--sm"
						aria-pressed={followed}
						aria-label={`Follow ${channel.name}`}
						title="Follow"
						on:click|stopPropagation={(event) => onToggleChannelFollow(channel.id, event)}
					><Icon name="bell" size={16} /></button>
					<button
						type="button"
						class="w-ibtn w-ibtn--sm"
						aria-label={`Pinned messages in ${channel.name}`}
						title="Pinned messages"
						on:click|stopPropagation={() => onShowPinnedMessages(channel.id)}
					><Icon name="pin" size={16} /></button>
				{/if}
				<button
					type="button"
					class="w-ibtn w-ibtn--sm"
					aria-label={`${channel.name} settings`}
					title={isVoice ? 'Voice room settings' : 'Channel settings'}
					on:click|stopPropagation={() => onOpenChannelSettings(channel)}
				><Icon name="gear" size={16} /></button>
			</div>
		{/if}
	</div>
	{#if isVoice && row?.showMembers && !compact}
		<div class="voice-member-list" transition:slide={rosterSlide}>
			{@render voiceRoster(channel, roster)}
		</div>
	{/if}
	{#each breakoutChannelsByParent[channel.id] || [] as breakout (breakout.id)}
		{@const breakoutRow = voiceRowsById.get(breakout.id)}
		{@const breakoutIsConnected = breakoutRow?.isConnected ?? false}
		{@const breakoutOccupancy = breakoutRow ? breakoutRow.members.length : 0}
		{@const breakoutRoster = breakoutRow ? splitVoiceParticipants(breakoutRow.people, expandedRooms.has(breakout.id)) : EMPTY_ROSTER}
		<div
			class="channel-item voice-channel-item breakout-channel-item"
			class:connected={breakoutIsConnected}
			class:live={breakoutOccupancy > 0}
			class:voice-drop-target={voiceDropTargetChannelId === breakout.id}
			role="group"
			on:dragover={(event) => onVoiceChannelDragOver(event, breakout.id)}
			on:dragleave={() => onVoiceChannelDragLeave(breakout.id)}
			on:drop={(event) => onVoiceChannelDrop(event, breakout.id)}
			on:contextmenu={(e) => onChannelRightClick(e, breakout)}
			use:longpress={{ onLongPress: (e) => onChannelLongPress(e, breakout) }}
		>
			{#snippet breakoutButton()}
				<button type="button" class="channel-btn" on:click={(e) => onVoiceChannelClick(breakout.id, e)}>
					<span class="row-glyph" aria-hidden="true"><Icon name="voice" size={16} /></span>
					<span class="row-name">{breakout.name}</span>
					<span class="row-trail">
						{#if breakoutRow && breakoutRow.recordingCount > 0}
							<span class="row-tag row-tag--rec" title={`${breakoutRow.recordingCount} recording in this call`}><span class="w-dot w-dot--danger" aria-hidden="true"></span>Rec</span>
						{/if}
						{#if breakoutOccupancy > 0 || breakout.voiceSettings?.userLimit}
							<span class="w-count" title={getVoiceOccupancyTitle(breakout, breakoutOccupancy)} aria-hidden="true">{formatVoiceOccupancy(breakout, breakoutOccupancy)}</span>
						{/if}
					</span>
					<span class="sr-only">, breakout room{#if breakoutOccupancy > 0}, {getVoiceOccupancyTitle(breakout, breakoutOccupancy)}{/if}{#if breakoutIsConnected}, connected{/if}</span>
				</button>
			{/snippet}
			{#if compact}
				<Tooltip text={breakout.name} placement="right" describe={false}>{@render breakoutButton()}</Tooltip>
			{:else}
				{@render breakoutButton()}
				<div class="row-tray">
					<button
						type="button"
						class="w-ibtn w-ibtn--sm"
						aria-label={`Open ${breakout.name} whiteboard`}
						title="Whiteboard"
						on:click|stopPropagation={(event) => onOpenVoiceChannelWhiteboard(breakout.id, event)}
					><Icon name="whiteboard" size={16} /></button>
				</div>
			{/if}
		</div>
		{#if breakoutRow?.showMembers && !compact}
			<div class="voice-member-list breakout-member-list" transition:slide={rosterSlide}>
				{@render voiceRoster(breakout, breakoutRoster)}
			</div>
		{/if}
	{/each}
	{#if !isVoice && !compact && (threadChannelsByParent[channel.id] || []).length > 0}
		<div class="thread-list">
			{#each threadChannelsByParent[channel.id] as thread (thread.id)}
				{@const threadUnread = unreadFor($channelUnreadCounts, thread.id, selectedChannelId)}
				{@const threadPage = selectedChannelId === thread.id && currentPlace === 'channel'}
				<button
					type="button"
					class="thread-btn"
					class:active={threadPage}
					class:unread={threadUnread > 0}
					aria-current={threadPage ? 'page' : undefined}
					on:click={() => onChannelClick(thread.id)}
				>
					<span class="thread-name">{thread.name}</span>
					{#if thread.type === 'thread_private'}
						<span class="row-tag">Private</span>
					{/if}
					{#if threadUnread > 0}
						<span class="w-badge w-badge--sm" aria-hidden="true">{formatBadge(threadUnread)}</span>
						<span class="sr-only">, {unreadLabel(threadUnread)}</span>
					{/if}
				</button>
			{/each}
		</div>
	{/if}
	</div>
{/each}
