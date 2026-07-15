<script lang="ts">
	import { onMount } from 'svelte';
	import { slide, fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { longpress } from '$lib/actions/longpress';
	import type { Channel } from '$lib/socket';
	import { currentUser, voiceChannelMembers, channelUnreadCounts } from '$lib/socket';
	import { isMuted as callMuted, isDeafened as callDeafened, isLocalSpeaking, speakingUsers, voiceTransmitMode, listeningVoiceChannels } from '$lib/calling';
	import { voiceCallRecordingParticipants } from '$lib/callRecordingPresence';
	import { formatBadge, formatVoiceDuration as formatVoiceDurationLabel, formatVoiceOccupancy, getVoiceOccupancyTitle } from './channelSidebarHelpers';

	export let voiceChannels: Channel[];
	export let allVoiceChannels: Channel[];
	export let breakoutChannelsByParent: Record<string, Channel[]>;
	export let connectedVoiceChannelIds: Set<string>;
	export let runtimeActiveVoiceChannelId: string | null;
	export let voiceDropTargetChannelId: string | null;
	export let voicePresenceSince: Map<string, number>;
	export let voiceDurationMode: 'off' | 'others' | 'all';
	export let nowMs: number;
	export let followedChannelIds: Set<string>;

	export let onVoiceChannelClick: (channelId: string) => void;
	export let onChannelRightClick: (event: MouseEvent, channel: Channel) => void;
	export let onChannelLongPress: (event: TouchEvent, channel: Channel) => void;
	export let onToggleChannelFollow: (channelId: string, event?: Event) => void;
	export let onToggleListenChannel: (channelId: string) => void;
	export let onOpenVoiceChannelWhiteboard: (channelId: string, event?: Event) => void;

	let reducedMotion = false;
	onMount(() => {
		if (typeof window === 'undefined' || !window.matchMedia) return;
		const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
		reducedMotion = mq.matches;
		const onChange = (event: MediaQueryListEvent) => { reducedMotion = event.matches; };
		mq.addEventListener('change', onChange);
		return () => mq.removeEventListener('change', onChange);
	});

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

	function canDragVoiceMember(memberUserId: string): boolean {
		if (!$currentUser) return false;
		if (memberUserId === $currentUser.id) return true;
		if ($currentUser.dbUserId && memberUserId === `user-${$currentUser.dbUserId}`) return true;
		return true;
	}

	export let onVoiceMemberDragStart: (event: DragEvent, channelId: string, memberUserId: string) => void;
	export let onVoiceMemberDragEnd: () => void;
	export let onVoiceChannelDragOver: (event: DragEvent, channelId: string) => void;
	export let onVoiceChannelDragLeave: (channelId: string) => void;
	export let onVoiceChannelDrop: (event: DragEvent, channelId: string) => void;

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
		if (!$currentUser) return null;
		const stableId = $currentUser.dbUserId ? `user-${$currentUser.dbUserId}` : null;
		const candidates = stableId ? [stableId, $currentUser.id] : [$currentUser.id];
		for (const candidate of candidates) {
			const start = getVoicePresenceStart(channelId, candidate);
			if (start) return start;
		}
		return null;
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

{#each voiceChannels as channel (channel.id)}
	{@const members = getVoiceMembers(channel.id)}
	{@const channelIsConnected = isConnectedToVoice(channel.id)}
	<div
		class="channel-item voice-channel-item"
		class:active={channelIsConnected}
		class:connected={channelIsConnected}
		class:followed={followedChannelIds.has(channel.id)}
		class:voice-drop-target={voiceDropTargetChannelId === channel.id}
		role="group"
		on:dragover={(event) => onVoiceChannelDragOver(event, channel.id)}
		on:dragleave={() => onVoiceChannelDragLeave(channel.id)}
		on:drop={(event) => onVoiceChannelDrop(event, channel.id)}
		on:contextmenu={(e) => onChannelRightClick(e, channel)}
		use:longpress={{ onLongPress: (e) => onChannelLongPress(e, channel) }}
	>
		<div class="voice-channel-main">
			<button class="channel-btn" data-abbrev={channel.name.charAt(0).toUpperCase()} on:click={() => onVoiceChannelClick(channel.id)}>
				<span class="hash voice-icon" aria-hidden="true">
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
				</span>
				<span class="voice-channel-name">{channel.name}</span>
				{#if isVoiceChannelBeingRecorded(channel.id)}
					<span class="voice-recording-tag" title={`${getVoiceChannelRecordingCount(channel.id)} participant(s) recording in this call`}>
						REC {getVoiceChannelRecordingCount(channel.id)}
					</span>
				{/if}
			</button>
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
		</div>
	</div>
	{#if showVoiceMembers(channel.id)}
		<div class="voice-member-list" transition:slide={reducedMotion ? undefined : { duration: 180, easing: cubicOut }}>
			{#if channelIsConnected && $currentUser}
			<div class="voice-member-item" in:fly={reducedMotion ? undefined : { x: -18, duration: 180, opacity: 0.2, easing: cubicOut }} out:fly={reducedMotion ? undefined : { x: -24, duration: 150, opacity: 0.1 }}>
				{#if $currentUser.profilePicture}
					<img class="voice-member-avatar" class:speaking={isSelfSpeakingInChannel(channel.id)} src={$currentUser.profilePicture} alt={$currentUser.username} />
				{:else}
					<span class="voice-member-avatar voice-avatar-fallback" class:speaking={isSelfSpeakingInChannel(channel.id)}>{($currentUser.username || '?').charAt(0).toUpperCase()}</span>
				{/if}
				<span class="voice-member-name">{$currentUser.username}</span>
				{#if isSelfRecordingInChannel(channel.id)}
					<span class="voice-recording-tag member">REC</span>
				{/if}
				{#if showSelfVoiceDuration()}
					<span class="voice-member-duration">{formatVoiceDuration(getSelfVoicePresenceStart(channel.id))}</span>
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
			<button class="channel-btn" data-abbrev={breakout.name.charAt(0).toUpperCase()} on:click={() => onVoiceChannelClick(breakout.id)}>
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
					</div>
				{/each}
			</div>
		{/if}
	{/each}
{/each}
