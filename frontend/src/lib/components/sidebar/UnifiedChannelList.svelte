<script lang="ts">
	import { onMount } from 'svelte';
	import { slide, fly } from 'svelte/transition';
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
	export let dropTargetClass: (channelId: string) => string = () => '';
	export let isChannelDragging: (channelId: string) => boolean = () => false;
	export let onChannelDragStart: (e: DragEvent, channelId: string) => void = () => {};
	export let onChannelDragOver: (e: DragEvent, channelId: string) => void = () => {};
	export let onChannelDragLeave: (channelId: string) => void = () => {};
	export let onChannelDrop: (e: DragEvent, channelId: string) => void = () => {};
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

	// ---- voice helpers (ported from VoiceChannelList) ----
	function getVoiceMembers(channelId: string) {
		return $voiceChannelMembers[channelId] || [];
	}

	function isConnectedToVoice(channelId: string): boolean {
		return connectedVoiceChannelIds.has(channelId);
	}

	function isPrimaryVoiceChannel(channelId: string): boolean {
		return runtimeActiveVoiceChannelId === channelId;
	}

	function isSelfSpeakingInChannel(channelId: string): boolean {
		const isLocallySpeaking = $isLocalSpeaking && !$callMuted && !$callDeafened;
		if (!isLocallySpeaking) return false;
		if ($voiceTransmitMode === 'all-listening') {
			return isConnectedToVoice(channelId);
		}
		return isPrimaryVoiceChannel(channelId);
	}

	function isMemberSpeaking(member: { userId: string }, channelId: string): boolean {
		if (member.userId === $currentUser?.id) {
			return isSelfSpeakingInChannel(channelId);
		}
		return $speakingUsers.has(member.userId);
	}

	function getSelfStableVoiceUserId(): string | null {
		if ($currentUser?.dbUserId) {
			return `user-${$currentUser.dbUserId}`;
		}
		return $currentUser?.id || null;
	}

	function getRecordingParticipantsForChannel(channelId: string) {
		return $voiceCallRecordingParticipants[channelId] || [];
	}

	function isVoiceChannelBeingRecorded(channelId: string): boolean {
		return getRecordingParticipantsForChannel(channelId).length > 0;
	}

	function getVoiceChannelRecordingCount(channelId: string): number {
		return getRecordingParticipantsForChannel(channelId).length;
	}

	function isSelfRecordingInChannel(channelId: string): boolean {
		const selfStableId = getSelfStableVoiceUserId();
		if (!selfStableId) return false;
		return getRecordingParticipantsForChannel(channelId).some((participant) => participant.userId === selfStableId);
	}

	function isMemberRecording(member: { userId: string }, channelId: string): boolean {
		return getRecordingParticipantsForChannel(channelId).some((participant) => participant.userId === member.userId);
	}

	function showVoiceMembers(channelId: string): boolean {
		return isConnectedToVoice(channelId) || getVoiceMembers(channelId).length > 0;
	}

	function visibleVoiceMembers(channelId: string): Array<{ userId: string; socketId?: string; username?: string; profilePicture?: string }> {
		const members = getVoiceMembers(channelId);
		if (!$currentUser) return members;
		return members.filter((member) => {
			if (member.userId === $currentUser?.id) return false;
			if ($currentUser?.dbUserId && member.userId === `user-${$currentUser.dbUserId}`) return false;
			return true;
		});
	}

	function getVoicePresenceStart(channelId: string, userId: string): number | null {
		return voicePresenceSince.get(`${channelId}::${userId}`) ?? null;
	}

	function getSelfVoicePresenceStart(channelId: string): number | null {
		const stableId = getSelfStableVoiceUserId();
		if (!stableId) return null;
		return getVoicePresenceStart(channelId, stableId);
	}

	function formatVoiceDuration(startMs: number | null): string {
		return formatVoiceDurationLabel(startMs, nowMs);
	}

	function showSelfVoiceDuration(): boolean {
		return voiceDurationMode === 'all';
	}

	function showOtherVoiceDuration(): boolean {
		return voiceDurationMode === 'all' || voiceDurationMode === 'others';
	}
</script>

{#each channels as channel (channel.id)}
	{@const isVoice = isVoiceLike(channel)}
	{@const members = isVoice ? getVoiceMembers(channel.id) : []}
	{@const channelIsConnected = isVoice && isConnectedToVoice(channel.id)}
	<div
		class="channel-item unified-channel-item"
		class:voice-channel-item={isVoice}
		class:active={isVoice ? channelIsConnected : $currentChannel === channel.id}
		class:connected={isVoice && channelIsConnected}
		class:followed={followedChannelIds.has(channel.id)}
		class:bookmarked={!isVoice && isChannelBookmarked(channel)}
		class:has-timer={channel.autoDeleteAfter}
		class:voice-drop-target={isVoice && voiceDropTargetChannelId === channel.id}
		class:drop-before={dropTargetClass(channel.id) === 'drop-before'}
		class:drop-after={dropTargetClass(channel.id) === 'drop-after'}
		class:is-dragging={isChannelDragging(channel.id)}
		role="group"
		draggable="true"
		on:contextmenu={(e) => onChannelRightClick(e, channel)}
		use:longpress={{ onLongPress: (e) => onChannelLongPress(e, channel) }}
		on:dragstart|stopPropagation={(e) => onChannelDragStart(e, channel.id)}
		on:dragover|stopPropagation={(e) => (isVoice ? onVoiceChannelDragOver(e, channel.id) : onChannelDragOver(e, channel.id))}
		on:dragleave|stopPropagation={() => (isVoice ? onVoiceChannelDragLeave(channel.id) : onChannelDragLeave(channel.id))}
		on:drop|stopPropagation={(e) => (isVoice ? onVoiceChannelDrop(e, channel.id) : onChannelDrop(e, channel.id))}
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
				{#if isVoice && isVoiceChannelBeingRecorded(channel.id)}
					<span class="voice-recording-tag" title={`${getVoiceChannelRecordingCount(channel.id)} participant(s) recording in this call`}>
						REC {getVoiceChannelRecordingCount(channel.id)}
					</span>
				{/if}
			</button>
			{#if isVoice}
				<div class="voice-channel-actions">
					<span class="voice-inline-count voice-action-count" title={getVoiceOccupancyTitle(channel, members.length)}>
						<svg class="voice-count-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
						{formatVoiceOccupancy(channel, members.length)}
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
	{#if isVoice && showVoiceMembers(channel.id)}
		<div class="voice-member-list" transition:slide={reducedMotion ? undefined : { duration: 180, easing: cubicOut }}>
			{#if channelIsConnected && $currentUser}
				{@const channelId = channel.id}
				<div class="voice-member-item" in:fly={reducedMotion ? undefined : { x: -18, duration: 180, opacity: 0.2, easing: cubicOut }} out:fly={reducedMotion ? undefined : { x: -24, duration: 150, opacity: 0.1 }}>
					{#if $currentUser.profilePicture}
						<img class="voice-member-avatar" class:speaking={isSelfSpeakingInChannel(channelId)} src={$currentUser.profilePicture} alt={$currentUser.username} />
					{:else}
						<span class="voice-member-avatar voice-avatar-fallback" class:speaking={isSelfSpeakingInChannel(channelId)}>{($currentUser.username || '?').charAt(0).toUpperCase()}</span>
					{/if}
					<span class="voice-member-name">{$currentUser.username}</span>
					{#if isSelfRecordingInChannel(channelId)}
						<span class="voice-recording-tag member">REC</span>
					{/if}
					{#if showSelfVoiceDuration()}
						<span class="voice-member-duration">{formatVoiceDuration(getSelfVoicePresenceStart(channelId))}</span>
					{/if}
				</div>
			{/if}
			{#each visibleVoiceMembers(channel.id) as member (member.userId)}
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
						<img class="voice-member-avatar" class:speaking={isMemberSpeaking(member, channel.id)} src={member.profilePicture} alt={member.username || member.userId} />
					{:else}
						<span class="voice-member-avatar voice-avatar-fallback" class:speaking={isMemberSpeaking(member, channel.id)}>{(member.username || '?').charAt(0).toUpperCase()}</span>
					{/if}
					<span class="voice-member-name">{member.username || member.userId}</span>
					{#if isMemberRecording(member, channel.id)}
						<span class="voice-recording-tag member">REC</span>
					{/if}
					{#if showOtherVoiceDuration()}
						<span class="voice-member-duration">{formatVoiceDuration(getVoicePresenceStart(channel.id, member.userId))}</span>
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
		{@const breakoutMembers = getVoiceMembers(breakout.id)}
		{@const breakoutIsConnected = isConnectedToVoice(breakout.id)}
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
				{#if isVoiceChannelBeingRecorded(breakout.id)}
					<span class="voice-recording-tag" title={`${getVoiceChannelRecordingCount(breakout.id)} participant(s) recording in this call`}>
						REC {getVoiceChannelRecordingCount(breakout.id)}
					</span>
				{/if}
			</button>
			<div class="voice-channel-actions">
				<span class="voice-inline-count voice-action-count" title={getVoiceOccupancyTitle(breakout, breakoutMembers.length)}>
					<svg class="voice-count-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
					{formatVoiceOccupancy(breakout, breakoutMembers.length)}
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
		{#if showVoiceMembers(breakout.id)}
			<div class="voice-member-list breakout-member-list" transition:slide={reducedMotion ? undefined : { duration: 180, easing: cubicOut }}>
				{#if breakoutIsConnected && $currentUser}
					<div class="voice-member-item" in:fly={reducedMotion ? undefined : { x: -18, duration: 180, opacity: 0.2, easing: cubicOut }} out:fly={reducedMotion ? undefined : { x: -24, duration: 150, opacity: 0.1 }}>
						{#if $currentUser.profilePicture}
							<img class="voice-member-avatar" class:speaking={isSelfSpeakingInChannel(breakout.id)} src={$currentUser.profilePicture} alt={$currentUser.username} />
						{:else}
							<span class="voice-member-avatar voice-avatar-fallback" class:speaking={isSelfSpeakingInChannel(breakout.id)}>{($currentUser.username || '?').charAt(0).toUpperCase()}</span>
						{/if}
						<span class="voice-member-name">{$currentUser.username}</span>
						{#if isSelfRecordingInChannel(breakout.id)}
							<span class="voice-recording-tag member">REC</span>
						{/if}
						{#if showSelfVoiceDuration()}
							<span class="voice-member-duration">{formatVoiceDuration(getSelfVoicePresenceStart(breakout.id))}</span>
						{/if}
					</div>
				{/if}
				{#each visibleVoiceMembers(breakout.id) as member (member.userId)}
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
							<img class="voice-member-avatar" class:speaking={isMemberSpeaking(member, breakout.id)} src={member.profilePicture} alt={member.username || member.userId} />
						{:else}
							<span class="voice-member-avatar voice-avatar-fallback" class:speaking={isMemberSpeaking(member, breakout.id)}>{(member.username || '?').charAt(0).toUpperCase()}</span>
						{/if}
						<span class="voice-member-name">{member.username || member.userId}</span>
						{#if isMemberRecording(member, breakout.id)}
							<span class="voice-recording-tag member">REC</span>
						{/if}
						{#if showOtherVoiceDuration()}
							<span class="voice-member-duration">{formatVoiceDuration(getVoicePresenceStart(breakout.id, member.userId))}</span>
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
{/each}
