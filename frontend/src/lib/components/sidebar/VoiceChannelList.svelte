<script lang="ts">
	import { onMount } from 'svelte';
	import { slide, fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { longpress } from '$lib/actions/longpress';
	import type { Channel } from '$lib/socket';
	import { currentUser, voiceChannelMembers, channelUnreadCounts, socket, getSocket } from '$lib/socket';
	import { isMuted as callMuted, isDeafened as callDeafened, isLocalSpeaking, speakingUsers, voiceTransmitMode, listeningVoiceChannels, toggleMute, toggleDeafen, endCall } from '$lib/calling';
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

	export let onVoiceChannelClick: (channelId: string, event?: MouseEvent) => void;
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

	// ============================================================================
	// SVELTE 5 REACTIVITY CONTRACT (do not regress)
	// ============================================================================
	// In Svelte 5 legacy mode, template expressions that CALL script functions
	// compile to `$.untrack(() => fn(args))`: arguments stay tracked, but every
	// store/prop read INSIDE the function body registers NO dependency. Helpers
	// like `getVoiceMembers(id)` reading `$voiceChannelMembers` therefore made
	// the roster UI blind to join/leave events until an unrelated signal fired
	// (the "must move channels to see updates" bug, proven via compiler probe
	// 2026-08-24). Rules enforced here:
	//   1. All store/prop reads happen in top-level `$:` derivations (tracked).
	//   2. The template consumes precomputed values via member/method access
	//      (`row.members.length`, `row.speakingIds.has(id)` — tracked) or passes
	//      them as ARGUMENTS into pure helpers.
	//   3. Never reintroduce a helper that closes over a store/prop and is
	//      called from the template. tests/svelte5-reactivity-tripwire.test.ts
	//      fails the build if `$.untrack` wraps roster reads again.

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
		isPrimary: boolean;
		isSelfSpeaking: boolean;
		selfRecording: boolean;
		selfPresenceStart: number | null;
		speakingIds: Set<string>;
		recordingIds: Set<string>;
		recordingCount: number;
		memberPresence: Map<string, number | null>;
	}

	function buildVoiceRow(
		channelId: string,
		ctx: {
			membersMap: Record<string, RowMember[]>;
			connectedIds: Set<string>;
			primaryId: string | null;
			transmitMode: string;
			speaking: Set<string>;
			recordingByChannel: Record<string, RowMember[]>;
			currentUserId: string | null;
			currentDbUserId: number | null;
			selfLocallySpeaking: boolean;
			presenceSince: Map<string, number>;
		}
	): VoiceRow {
		const members = ctx.membersMap[channelId] || [];
		const isConnected = ctx.connectedIds.has(channelId);
		const isPrimary = ctx.primaryId === channelId;
		const isSelfSpeaking =
			ctx.selfLocallySpeaking &&
			(ctx.transmitMode === 'all-listening' ? isConnected : isPrimary);

		const selfMatches = (userId: string): boolean =>
			userId === ctx.currentUserId ||
			(ctx.currentDbUserId != null && userId === `user-${ctx.currentDbUserId}`);

		const recordingParticipants = ctx.recordingByChannel[channelId] || [];
		const recordingIds = new Set(recordingParticipants.map((p) => p.userId));
		const selfStableId =
			ctx.currentDbUserId != null ? `user-${ctx.currentDbUserId}` : ctx.currentUserId;
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
		const selfCandidates = [
			ctx.currentDbUserId != null ? `user-${ctx.currentDbUserId}` : null,
			ctx.currentUserId
		].filter((id): id is string => id != null);
		let selfPresenceStart: number | null = null;
		for (const candidate of selfCandidates) {
			const start = ctx.presenceSince.get(`${channelId}::${candidate}`);
			if (start) { selfPresenceStart = start; break; }
		}

		return {
			members,
			visibleMembers,
			isConnected,
			isPrimary,
			isSelfSpeaking,
			selfRecording,
			selfPresenceStart,
			speakingIds,
			recordingIds,
			recordingCount: recordingParticipants.length,
			memberPresence
		};
	}

	function collectRowChannels(): Channel[] {
		const seen = new Set<string>();
		const out: Channel[] = [];
		const push = (list: Channel[]) => {
			for (const channel of list) {
				if (!seen.has(channel.id)) { seen.add(channel.id); out.push(channel); }
			}
		};
		push(voiceChannels);
		push(allVoiceChannels);
		for (const children of Object.values(breakoutChannelsByParent)) push(children);
		return out;
	}

	$: selfLocallySpeaking = $isLocalSpeaking && !$callMuted && !$callDeafened;

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
			selfLocallySpeaking,
			presenceSince: voicePresenceSince
		};
		for (const channel of collectRowChannels()) {
			map.set(channel.id, buildVoiceRow(channel.id, ctx));
		}
		return map;
	})();

	function handleSelfToggleMute(event: MouseEvent) {
		event.stopPropagation();
		toggleMute();
	}

	function handleSelfToggleDeafen(event: MouseEvent) {
		event.stopPropagation();
		toggleDeafen($socket || getSocket() || undefined);
	}

	function handleSelfDisconnect(event: MouseEvent) {
		event.stopPropagation();
		const sock = $socket || getSocket();
		if (sock) endCall(sock);
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

	/** Finding 32: only self is draggable here; parent may still cancel unauthorized moves. */
	export let canDragVoiceMember: (memberUserId: string) => boolean = (memberUserId) => {
		if (!$currentUser) return false;
		if (memberUserId === $currentUser.id) return true;
		if ($currentUser.dbUserId && memberUserId === `user-${$currentUser.dbUserId}`) return true;
		return false;
	};

	export let onVoiceMemberDragStart: (event: DragEvent, channelId: string, memberUserId: string) => void;
	export let onVoiceMemberDragEnd: () => void;
	export let onVoiceChannelDragOver: (event: DragEvent, channelId: string) => void;
	export let onVoiceChannelDragLeave: (channelId: string) => void;
	export let onVoiceChannelDrop: (event: DragEvent, channelId: string) => void;
</script>

{#each voiceChannels as channel (channel.id)}
	{@const row = voiceRowsById.get(channel.id)}
	<div
		class="channel-item voice-channel-item"
		class:active={row?.isConnected}
		class:connected={row?.isConnected}
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
			<button class="channel-btn" data-abbrev={channel.name.charAt(0).toUpperCase()} on:click={(e) => onVoiceChannelClick(channel.id, e)}>
				<span class="hash voice-icon" aria-hidden="true">
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
				</span>
				<span class="voice-channel-name">{channel.name}</span>
				{#if row && row.recordingCount > 0}
					<span class="voice-recording-tag" title={`${row.recordingCount} participant(s) recording in this call`}>
						REC {row.recordingCount}
					</span>
				{/if}
			</button>
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
		</div>
	</div>
	{#if row && (row.isConnected || row.members.length > 0)}
		<div class="voice-member-list" transition:slide={reducedMotion ? undefined : { duration: 180, easing: cubicOut }}>
			{#if row.isConnected && $currentUser}
				<div class="voice-member-item" in:fly={reducedMotion ? undefined : { x: -18, duration: 180, opacity: 0.2, easing: cubicOut }} out:fly={reducedMotion ? undefined : { x: -24, duration: 150, opacity: 0.1 }}>
					{#if $currentUser.profilePicture}
						<img class="voice-member-avatar" class:speaking={row.isSelfSpeaking} src={$currentUser.profilePicture} alt={$currentUser.username} />
					{:else}
						<span class="voice-member-avatar voice-avatar-fallback" class:speaking={row.isSelfSpeaking}>{($currentUser.username || '?').charAt(0).toUpperCase()}</span>
					{/if}
					<span class="voice-member-name">{$currentUser.username}</span>
					{#if row.selfRecording}
						<span class="voice-recording-tag member">REC</span>
					{/if}
					{#if showSelfVoiceDuration()}
						<span class="voice-member-duration">{formatVoiceDuration(row.selfPresenceStart)}</span>
					{/if}
				</div>
				<div class="voice-self-controls" role="group" aria-label="Voice controls">
					<button
						type="button"
						class="voice-self-btn"
						class:active={$callMuted}
						on:click={handleSelfToggleMute}
						title={$callMuted ? 'Unmute' : 'Mute'}
						aria-label={$callMuted ? 'Unmute microphone' : 'Mute microphone'}
					>
						{#if $callMuted}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
						{:else}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
						{/if}
					</button>
					<button
						type="button"
						class="voice-self-btn"
						class:active={$callDeafened}
						on:click={handleSelfToggleDeafen}
						title={$callDeafened ? 'Undeafen' : 'Deafen'}
						aria-label={$callDeafened ? 'Undeafen' : 'Deafen'}
					>
						{#if $callDeafened}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M19.07 4.93a10 10 0 0 1 1.4 12.6M15.54 8.46a5 5 0 0 1 .78 5.4"/><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/></svg>
						{:else}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
						{/if}
					</button>
					<button
						type="button"
						class="voice-self-btn voice-self-disconnect"
						on:click={handleSelfDisconnect}
						title="Disconnect"
						aria-label="Disconnect from voice channel"
					>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07C9.44 17.28 8.17 16 7.05 14.68A19.79 19.79 0 0 1 4 6.05 2 2 0 0 1 5.99 4h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L10.68 11.68"/><line x1="23" y1="1" x2="1" y2="23"/></svg>
					</button>
				</div>
			{/if}
			{#each row.visibleMembers as member (member.userId)}
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
						<img class="voice-member-avatar" class:speaking={row.speakingIds.has(member.userId)} src={member.profilePicture} alt={member.username || member.userId} />
					{:else}
						<span class="voice-member-avatar voice-avatar-fallback" class:speaking={row.speakingIds.has(member.userId)}>{(member.username || '?').charAt(0).toUpperCase()}</span>
					{/if}
					<span class="voice-member-name">{member.username || member.userId}</span>
					{#if row.recordingIds.has(member.userId)}
						<span class="voice-recording-tag member">REC</span>
					{/if}
					{#if showOtherVoiceDuration()}
						<span class="voice-member-duration">{formatVoiceDuration(row.memberPresence.get(member.userId) ?? null)}</span>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
	{#each breakoutChannelsByParent[channel.id] || [] as breakout (breakout.id)}
		{@const brow = voiceRowsById.get(breakout.id)}
		<div
			class="channel-item voice-channel-item breakout-channel-item"
			class:active={brow?.isConnected}
			class:connected={brow?.isConnected}
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
				{#if brow && brow.recordingCount > 0}
					<span class="voice-recording-tag" title={`${brow.recordingCount} participant(s) recording in this call`}>
						REC {brow.recordingCount}
					</span>
				{/if}
			</button>
			<div class="voice-channel-actions">
				<span class="voice-inline-count voice-action-count" title={getVoiceOccupancyTitle(breakout, brow ? brow.members.length : 0)}>
					<svg class="voice-count-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
					{formatVoiceOccupancy(breakout, brow ? brow.members.length : 0)}
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
		{#if brow && (brow.isConnected || brow.members.length > 0)}
			<div class="voice-member-list breakout-member-list" transition:slide={reducedMotion ? undefined : { duration: 180, easing: cubicOut }}>
				{#if brow.isConnected && $currentUser}
				<div class="voice-member-item" in:fly={reducedMotion ? undefined : { x: -18, duration: 180, opacity: 0.2, easing: cubicOut }} out:fly={reducedMotion ? undefined : { x: -24, duration: 150, opacity: 0.1 }}>
					{#if $currentUser.profilePicture}
						<img class="voice-member-avatar" class:speaking={brow.isSelfSpeaking} src={$currentUser.profilePicture} alt={$currentUser.username} />
					{:else}
						<span class="voice-member-avatar voice-avatar-fallback" class:speaking={brow.isSelfSpeaking}>{($currentUser.username || '?').charAt(0).toUpperCase()}</span>
					{/if}
					<span class="voice-member-name">{$currentUser.username}</span>
					{#if brow.selfRecording}
						<span class="voice-recording-tag member">REC</span>
					{/if}
					{#if showSelfVoiceDuration()}
						<span class="voice-member-duration">{formatVoiceDuration(brow.selfPresenceStart)}</span>
					{/if}
				</div>
				{/if}
				{#each brow.visibleMembers as member (member.userId)}
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
							<img class="voice-member-avatar" class:speaking={brow.speakingIds.has(member.userId)} src={member.profilePicture} alt={member.username || member.userId} />
						{:else}
							<span class="voice-member-avatar voice-avatar-fallback" class:speaking={brow.speakingIds.has(member.userId)}>{(member.username || '?').charAt(0).toUpperCase()}</span>
						{/if}
						<span class="voice-member-name">{member.username || member.userId}</span>
						{#if brow.recordingIds.has(member.userId)}
							<span class="voice-recording-tag member">REC</span>
						{/if}
						{#if showOtherVoiceDuration()}
							<span class="voice-member-duration">{formatVoiceDuration(brow.memberPresence.get(member.userId) ?? null)}</span>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	{/each}
{/each}
