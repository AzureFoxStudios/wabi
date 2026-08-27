<script lang="ts">
	import { onMount } from 'svelte';
	import { slide, fly } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { cubicOut } from 'svelte/easing';
	import { longpress } from '$lib/actions/longpress';
	import type { Channel } from '$lib/socket';
	import { currentUser, channelUnreadCounts, currentChannel, voiceChannelMembers } from '$lib/socket';
	import { isMuted as callMuted, isDeafened as callDeafened, isLocalSpeaking, speakingUsers, voiceTransmitMode, listeningVoiceChannels } from '$lib/calling';
	import { voiceCallRecordingParticipants } from '$lib/callRecordingPresence';
	import { displayEnhancementSettingsStore } from '$lib/displayEnhancements';
	import { isLikelyNsfwChannel } from '$lib/displayEnhancements';
	import { isLiveRetention } from '../../../../../shared/messageRetention.js';
	import { isServerChannelMuted } from '$lib/serverSettings';
	import { formatBadge, formatVoiceDuration as formatVoiceDurationLabel, formatVoiceOccupancy, getVoiceOccupancyTitle } from './channelSidebarHelpers';

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

	let reducedMotion = false;
	onMount(() => {
		if (typeof window === 'undefined' || !window.matchMedia) return;
		const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
		reducedMotion = mq.matches;
		const onChange = (event: MediaQueryListEvent) => { reducedMotion = event.matches; };
		mq.addEventListener('change', onChange);
		return () => mq.removeEventListener('change', onChange);
	});

	/** Settle animation after a commit; instant under reduced motion / search. */
	$: rowFlipParams =
		reducedMotion || suppressFlip ? { duration: 0 } : { duration: 220, easing: cubicOut };

	function channelType(ch: Channel): string {
		return (ch.type as string | undefined) || 'text';
	}

	function isVoiceLike(ch: Channel): boolean {
		return channelType(ch) === 'voice';
	}

	function isTextLike(ch: Channel): boolean {
		const t = channelType(ch);
		return t === 'text' || t === 'public' || t === 'live' || t === 'group' || t === 'category';
	}

	function isChannelLocallyMuted(channelId: string): boolean {
		return isServerChannelMuted(channelId);
	}

	function isNsfwTaggedChannel(channel: Channel): boolean {
		return isLikelyNsfwChannel(channel.name, channel.description);
	}

	function isChannelBookmarked(channel: Channel): boolean {
		const userId = $currentUser?.id;
		if (!userId) return false;
		return channel.pinnedBy?.includes(userId) ?? false;
	}

	function channelIcon(ch: Channel): string {
		switch (channelType(ch)) {
			case 'voice': return 'voice';
			case 'gallery': return 'gallery';
			case 'forum': return 'forum';
			case 'wiki': return 'wiki';
			case 'lore': return 'lore';
			case 'planning': return 'planning';
			case 'group': return 'group';
			default: return 'text';
		}
	}

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
	}

	interface VoiceRow {
		members: RowMember[];
		visibleMembers: RowMember[];
		isConnected: boolean;
		isSelfSpeaking: boolean;
		selfRecording: boolean;
		speakingIds: Set<string>;
		recordingIds: Set<string>;
		recordingCount: number;
		memberPresence: Map<string, number | null>;
		selfPresenceStart: number | null;
		showMembers: boolean;
	}

	function buildVoiceRow(
		channelId: string,
		ctx: {
			membersMap: Record<string, RowMember[]>;
			connectedIds: Set<string>;
			primaryId: string | null;
			transmitMode: string;
			speaking: Set<string>;
			recordingByChannel: Record<string, Array<{ userId: string }>>;
			currentUserId: string | null;
			currentDbUserId: number | null;
			selfLocallySpeaking: boolean;
			presenceSince: Map<string, number>;
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
		const selfRecording = selfStableId != null && recordingIds.has(selfStableId);

		const speakingIds = new Set<string>();
		for (const member of members) {
			if (!selfMatches(member.userId) && ctx.speaking.has(member.userId)) {
				speakingIds.add(member.userId);
			}
		}

		const visibleMembers = members.filter((member) => !selfMatches(member.userId));

		const memberPresence = new Map<string, number | null>();
		for (const member of members) {
			memberPresence.set(member.userId, ctx.presenceSince.get(`${channelId}::${member.userId}`) ?? null);
		}
		let selfPresenceStart: number | null = null;
		const selfCandidates = [
			ctx.currentDbUserId != null ? `user-${ctx.currentDbUserId}` : null,
			ctx.currentUserId
		].filter((id): id is string => id != null);
		for (const candidate of selfCandidates) {
			const start = ctx.presenceSince.get(`${channelId}::${candidate}`);
			if (start) { selfPresenceStart = start; break; }
		}

		return {
			members,
			visibleMembers,
			isConnected,
			isSelfSpeaking,
			selfRecording,
			speakingIds,
			recordingIds,
			recordingCount: recordingParticipants.length,
			memberPresence,
			selfPresenceStart,
			showMembers: isConnected || members.length > 0
		};
	}

	/** Every channel that renders a voice row: list channels + breakout children. */
	function collectRowChannels(): Channel[] {
		const seen = new Set<string>();
		const out: Channel[] = [];
		const push = (list: Channel[] | undefined) => {
			for (const channel of list ?? []) {
				if (!seen.has(channel.id)) { seen.add(channel.id); out.push(channel); }
			}
		};
		push(channels);
		for (const children of Object.values(breakoutChannelsByParent)) push(children);
		return out;
	}

	$: selfLocallySpeakingRow = $isLocalSpeaking && !$callMuted && !$callDeafened;

	$: voiceRowsById = (() => {
		const map = new Map<string, VoiceRow>();
		const ctx = {
			membersMap: $voiceChannelMembers,
			connectedIds: connectedVoiceChannelIds,
			primaryId: runtimeActiveVoiceChannelId,
			transmitMode: $voiceTransmitMode,
			speaking: $speakingUsers,
			recordingByChannel: $voiceCallRecordingParticipants,
			currentUserId: $currentUser?.id ?? null,
			currentDbUserId: $currentUser?.dbUserId ?? null,
			selfLocallySpeaking: selfLocallySpeakingRow,
			presenceSince: voicePresenceSince
		};
		for (const channel of collectRowChannels()) {
			map.set(channel.id, buildVoiceRow(channel.id, ctx));
		}
		return map;
	})();

	/** Pure duration formatter — `nowMs` arrives as a tracked argument. */
	function formatVoiceDuration(startMs: number | null, now: number): string {
		return formatVoiceDurationLabel(startMs, now);
	}
</script>

{#each channels as channel (channel.id)}
	{@const isVoice = isVoiceLike(channel)}
	{@const row = isVoice ? voiceRowsById.get(channel.id) : undefined}
	{@const channelIsConnected = isVoice && (row?.isConnected ?? false)}
	<div class="unified-channel-wrap" animate:flip={rowFlipParams}>
	<div
		class="channel-item unified-channel-item"
		class:voice-channel-item={isVoice}
		class:active={isVoice ? channelIsConnected : $currentChannel === channel.id}
		class:connected={isVoice && channelIsConnected}
		class:followed={followedChannelIds.has(channel.id)}
		class:bookmarked={!isVoice && isChannelBookmarked(channel)}
		class:has-timer={channel.autoDeleteAfter}
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
		<div class={isVoice ? 'voice-channel-main' : 'channel-main'}>
			<button
				class="channel-btn"
				data-abbrev={channel.name.charAt(0).toUpperCase()}
				on:click={(event) => (isVoice ? onVoiceChannelClick(channel.id, event) : onChannelButtonClick(channel.id, event))}
			on:auxclick={(event) => {
				if (!isVoice && event.button === 1 && event.altKey) {
					event.preventDefault();
					onChannelButtonClick(channel.id, event as unknown as MouseEvent);
				}
			}}
				title={channel.autoDeleteAfter ? `Auto-delete: ${channel.autoDeleteAfter}` : 'Alt-click to glimpse'}
			>
				{#if isVoice}
					<span class="hash voice-icon" aria-hidden="true">
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
					</span>
				{:else if channelIcon(channel) === 'gallery'}
					<span class="hash gallery-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
					</span>
				{:else if channelIcon(channel) === 'forum'}
					<span class="hash forum-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
					</span>
				{:else if channelIcon(channel) === 'wiki'}
					<span class="hash wiki-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>
					</span>
				{:else if channelIcon(channel) === 'lore'}
					<span class="hash lore-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8V21H3V8"></path><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>
					</span>
				{:else if channelIcon(channel) === 'planning'}
					<span class="hash planning-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
					</span>
				{:else if channelIcon(channel) === 'group'}
					<svg class="group-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
				{:else}
					<span class="hash">#</span>
				{/if}
				<span class={isVoice ? 'voice-channel-name' : ''}>{channel.name}</span>
				{#if isLiveRetention(channel.autoDeleteAfter)}
					<span class="live-tag" title="Live room — messages are session only and not saved">LIVE</span>
				{/if}
				{#if $displayEnhancementSettingsStore.betterNsfwTagEnabled && isNsfwTaggedChannel(channel)}
					<span class="nsfw-tag">NSFW</span>
				{/if}
				{#if isChannelLocallyMuted(channel.id)}
					<span class="muted-tag">Muted</span>
				{/if}
				{#if !isVoice && isChannelBookmarked(channel)}
					<span class="bookmark-tag" title="Bookmarked for the quick switcher">Saved</span>
				{/if}
				{#if $channelUnreadCounts[channel.id] && $currentChannel !== channel.id}
					<span class="unread-badge">{formatBadge($channelUnreadCounts[channel.id])}</span>
				{/if}
				{#if liveWhiteboardChannelIds.has(channel.id)}
					<span class="live-pill" title="Someone is on this whiteboard"><span class="live-dot"></span>LIVE</span>
				{/if}
				{#if isVoice && row && row.recordingCount > 0}
					<span class="voice-recording-tag" title={`${row.recordingCount} participant(s) recording in this call`}>
						REC {row.recordingCount}
					</span>
				{/if}
			</button>
			{#if isVoice}
				<div class="voice-channel-actions">
					<span class="voice-inline-count voice-action-count" title={getVoiceOccupancyTitle(channel, row ? row.members.length : 0)}>
						<svg class="voice-count-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
						{formatVoiceOccupancy(channel, row ? row.members.length : 0)}
					</span>
					<button
						class="follow-btn voice-follow-btn"
						class:active={followedChannelIds.has(channel.id)}
						on:click|stopPropagation={(event) => onToggleChannelFollow(channel.id, event)}
						title={followedChannelIds.has(channel.id) ? 'Unfollow voice channel' : 'Follow voice channel'}
					>
						{followedChannelIds.has(channel.id) ? '★' : '☆'}
					</button>
					<button
						type="button"
						class="voice-whiteboard-btn"
						on:click|stopPropagation={(event) => onOpenVoiceChannelWhiteboard(channel.id, event)}
						title="Open voice whiteboard"
						aria-label={`Open ${channel.name} whiteboard`}
					>
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<rect x="3" y="4" width="18" height="14" rx="2"></rect>
							<path d="M7 8h10"></path>
							<path d="M7 12h6"></path>
							<path d="M8 20h8"></path>
						</svg>
					</button>
				</div>
			{:else}
				<div class="channel-actions text-channel-actions">
					<button
						class="follow-btn"
						class:active={followedChannelIds.has(channel.id)}
						on:click|stopPropagation={(event) => onToggleChannelFollow(channel.id, event)}
						title={followedChannelIds.has(channel.id) ? 'Unfollow channel' : 'Follow channel'}
					>
						{followedChannelIds.has(channel.id) ? '★' : '☆'}
					</button>
					<button class="pin-btn" on:click|stopPropagation={() => onShowPinnedMessages(channel.id)} title="View pinned messages">
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7" r="2"></circle><path d="M9 3h6l-1 6 3 3H7l3-3-1-6z"></path><line x1="12" y1="15" x2="12" y2="21"></line></svg>
					</button>
					<button class="settings-btn" on:click|stopPropagation={() => onOpenChannelSettings(channel)} title="Channel settings">
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path></svg>
					</button>
				</div>
			{/if}
		</div>
	</div>
	{#if isVoice && row?.showMembers}
		<div class="voice-member-list" transition:slide={reducedMotion ? undefined : { duration: 180, easing: cubicOut }}>
			{#if channelIsConnected && $currentUser}
				<div class="voice-member-item" in:fly={reducedMotion ? undefined : { x: -18, duration: 180, opacity: 0.2, easing: cubicOut }} out:fly={reducedMotion ? undefined : { x: -24, duration: 150, opacity: 0.1 }}>
					{#if $currentUser.profilePicture}
						<img class="voice-member-avatar" class:speaking={row?.isSelfSpeaking} src={$currentUser.profilePicture} alt={$currentUser.username} />
					{:else}
						<span class="voice-member-avatar voice-avatar-fallback" class:speaking={row?.isSelfSpeaking}>{($currentUser.username || '?').charAt(0).toUpperCase()}</span>
					{/if}
					<span class="voice-member-name">{$currentUser.username}</span>
					{#if row?.selfRecording}
						<span class="voice-recording-tag member">REC</span>
					{/if}
					{#if voiceDurationMode === 'all'}
						<span class="voice-member-duration">{formatVoiceDuration(row?.selfPresenceStart ?? null, nowMs)}</span>
					{/if}
				</div>
			{/if}
			{#each row?.visibleMembers ?? [] as member (member.userId)}
				<div
					class="voice-member-item"
					class:voice-member-draggable={canDragVoiceMember(member.userId)}
					role="listitem"
					draggable={canDragVoiceMember(member.userId)}
					on:dragstart={(event) => onVoiceMemberDragStart(event, channel.id, member.userId)}
					on:dragend={onVoiceMemberDragEnd}
					in:fly={reducedMotion ? undefined : { x: -18, duration: 180, opacity: 0.2, easing: cubicOut }}
					out:fly={reducedMotion ? undefined : { x: -24, duration: 150, opacity: 0.1 }}
				>
					{#if member.profilePicture}
						<img class="voice-member-avatar" class:speaking={row?.speakingIds.has(member.userId)} src={member.profilePicture} alt={member.username || member.userId} />
					{:else}
						<span class="voice-member-avatar voice-avatar-fallback" class:speaking={row?.speakingIds.has(member.userId)}>{(member.username || '?').charAt(0).toUpperCase()}</span>
					{/if}
					<span class="voice-member-name">{member.username || member.userId}</span>
					{#if row?.recordingIds.has(member.userId)}
						<span class="voice-recording-tag member">REC</span>
					{/if}
					{#if voiceDurationMode === 'all' || voiceDurationMode === 'others'}
						<span class="voice-member-duration">{formatVoiceDuration(row?.memberPresence.get(member.userId) ?? null, nowMs)}</span>
					{/if}
					{#if canKickVoiceMember(member.userId)}
						<button
							type="button"
							class="voice-member-kick"
							on:click={(e) => { e.stopPropagation(); onKickVoiceMember(channel.id, member.userId); }}
							title={`Remove ${member.username || member.userId} from voice`}
							aria-label={`Remove ${member.username || member.userId} from voice`}
						>
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
						</button>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
	{#each breakoutChannelsByParent[channel.id] || [] as breakout (breakout.id)}
		{@const breakoutRow = voiceRowsById.get(breakout.id)}
		{@const breakoutIsConnected = breakoutRow?.isConnected ?? false}
		<div
			class="channel-item voice-channel-item breakout-channel-item"
			class:active={breakoutIsConnected}
			class:connected={breakoutIsConnected}
			class:followed={followedChannelIds.has(breakout.id)}
			class:voice-drop-target={voiceDropTargetChannelId === breakout.id}
			role="group"
			on:dragover={(event) => onVoiceChannelDragOver(event, breakout.id)}
			on:dragleave={() => onVoiceChannelDragLeave(breakout.id)}
			on:drop={(event) => onVoiceChannelDrop(event, breakout.id)}
			on:contextmenu={(e) => onChannelRightClick(e, breakout)}
			use:longpress={{ onLongPress: (e) => onChannelLongPress(e, breakout) }}
		>
			<button class="channel-btn" data-abbrev={breakout.name.charAt(0).toUpperCase()} on:click={(e) => onVoiceChannelClick(breakout.id, e)}>
				<span class="breakout-prefix" aria-hidden="true">&gt;</span>
				<span class="voice-channel-name">{breakout.name}</span>
				{#if breakoutRow && breakoutRow.recordingCount > 0}
					<span class="voice-recording-tag" title={`${breakoutRow.recordingCount} participant(s) recording in this call`}>
						REC {breakoutRow.recordingCount}
					</span>
				{/if}
			</button>
			<div class="voice-channel-actions">
				<span class="voice-inline-count voice-action-count" title={getVoiceOccupancyTitle(breakout, breakoutRow ? breakoutRow.members.length : 0)}>
					<svg class="voice-count-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
					{formatVoiceOccupancy(breakout, breakoutRow ? breakoutRow.members.length : 0)}
				</span>
				<button
					class="follow-btn voice-follow-btn"
					class:active={followedChannelIds.has(breakout.id)}
					on:click|stopPropagation={(event) => onToggleChannelFollow(breakout.id, event)}
					title={followedChannelIds.has(breakout.id) ? 'Unfollow breakout voice channel' : 'Follow breakout voice channel'}
				>
					{followedChannelIds.has(breakout.id) ? '★' : '☆'}
				</button>
				<button
					type="button"
					class="voice-whiteboard-btn"
					on:click|stopPropagation={(event) => onOpenVoiceChannelWhiteboard(breakout.id, event)}
					title="Open breakout whiteboard"
					aria-label={`Open ${breakout.name} whiteboard`}
				>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<rect x="3" y="4" width="18" height="14" rx="2"></rect>
						<path d="M7 8h10"></path>
						<path d="M7 12h6"></path>
						<path d="M8 20h8"></path>
					</svg>
				</button>
			</div>
		</div>
		{#if breakoutRow?.showMembers}
			<div class="voice-member-list breakout-member-list" transition:slide={reducedMotion ? undefined : { duration: 180, easing: cubicOut }}>
				{#if breakoutIsConnected && $currentUser}
					<div class="voice-member-item" in:fly={reducedMotion ? undefined : { x: -18, duration: 180, opacity: 0.2, easing: cubicOut }} out:fly={reducedMotion ? undefined : { x: -24, duration: 150, opacity: 0.1 }}>
						{#if $currentUser.profilePicture}
							<img class="voice-member-avatar" class:speaking={breakoutRow?.isSelfSpeaking} src={$currentUser.profilePicture} alt={$currentUser.username} />
						{:else}
							<span class="voice-member-avatar voice-avatar-fallback" class:speaking={breakoutRow?.isSelfSpeaking}>{($currentUser.username || '?').charAt(0).toUpperCase()}</span>
						{/if}
						<span class="voice-member-name">{$currentUser.username}</span>
						{#if breakoutRow?.selfRecording}
							<span class="voice-recording-tag member">REC</span>
						{/if}
						{#if voiceDurationMode === 'all'}
							<span class="voice-member-duration">{formatVoiceDuration(breakoutRow?.selfPresenceStart ?? null, nowMs)}</span>
						{/if}
					</div>
				{/if}
				{#each breakoutRow?.visibleMembers ?? [] as member (member.userId)}
					<div
						class="voice-member-item"
						class:voice-member-draggable={canDragVoiceMember(member.userId)}
						role="listitem"
						draggable={canDragVoiceMember(member.userId)}
						on:dragstart={(event) => onVoiceMemberDragStart(event, breakout.id, member.userId)}
						on:dragend={onVoiceMemberDragEnd}
						in:fly={reducedMotion ? undefined : { x: -18, duration: 180, opacity: 0.2, easing: cubicOut }}
						out:fly={reducedMotion ? undefined : { x: -24, duration: 150, opacity: 0.1 }}
					>
						{#if member.profilePicture}
							<img class="voice-member-avatar" class:speaking={breakoutRow?.speakingIds.has(member.userId)} src={member.profilePicture} alt={member.username || member.userId} />
						{:else}
							<span class="voice-member-avatar voice-avatar-fallback" class:speaking={breakoutRow?.speakingIds.has(member.userId)}>{(member.username || '?').charAt(0).toUpperCase()}</span>
						{/if}
						<span class="voice-member-name">{member.username || member.userId}</span>
						{#if breakoutRow?.recordingIds.has(member.userId)}
							<span class="voice-recording-tag member">REC</span>
						{/if}
						{#if voiceDurationMode === 'all' || voiceDurationMode === 'others'}
							<span class="voice-member-duration">{formatVoiceDuration(breakoutRow?.memberPresence.get(member.userId) ?? null, nowMs)}</span>
						{/if}
						{#if canKickVoiceMember(member.userId)}
							<button
								type="button"
								class="voice-member-kick"
								on:click={(e) => { e.stopPropagation(); onKickVoiceMember(breakout.id, member.userId); }}
								title={`Remove ${member.username || member.userId} from voice`}
								aria-label={`Remove ${member.username || member.userId} from voice`}
							>
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
							</button>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	{/each}
	{#if !isVoice && (threadChannelsByParent[channel.id] || []).length > 0}
		<div class="thread-list">
			{#each threadChannelsByParent[channel.id] as thread (thread.id)}
				<button
					class="thread-btn"
					class:active={$currentChannel === thread.id}
					on:click={() => onChannelClick(thread.id)}
					title={thread.type === 'thread_private' ? 'Private thread' : 'Thread'}
				>
					<span class="thread-prefix">&gt;</span>
					<span class="thread-name">{thread.name}</span>
					{#if thread.type === 'thread_private'}
						<span class="thread-privacy">Private</span>
					{/if}
					{#if $channelUnreadCounts[thread.id] && $currentChannel !== thread.id}
						<span class="unread-badge">{formatBadge($channelUnreadCounts[thread.id])}</span>
					{/if}
				</button>
			{/each}
		</div>
	{/if}
	</div>
{/each}
