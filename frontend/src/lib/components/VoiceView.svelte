<script lang="ts">
	/**
	 * Phase 4 — the voice view (figure 1): every call as a card. Connected
	 * calls show focus badges, participants, per-call volume and controls;
	 * every other voice channel is joinable in one click. Global bar:
	 * Mute All / Deafen All / Camera Off / Leave All.
	 */
	import { callSessions, focusedCallSessionId, callSessionManager } from '$lib/callSessionManager';
	import { sessionBadge } from '$lib/callSessionTypes';
	import { voiceChannelMembers } from '$lib/presenceStore';
	import { channels } from '$lib/channelStore';
	import { wabidbRemoteVideoStreams } from '$lib/wabidbVideoLane';
	import {
		joinVoice,
		leaveCall,
		focusCall,
		setCallVolume,
		toggleCallSpeaker,
		muteAllMic,
		unmuteAllMic,
		deafenAll,
		undeafenAll,
		cameraOff,
		leaveAllCalls
	} from '$lib/callSurfaces';
	import { isMuted, isDeafened, activeCalls, callTransportState, switchCallTransport, localScreenStream, screenShares } from '$lib/calling';
	import { callRecordingState, startCallRecording, stopCallRecording, formatRecordingElapsedForUi } from '$lib/callRecording';
	import { getSocket } from '$lib/socketConnection';

	let transportSwapBusy = false;
	let recordBusy = false;
	const currentTransport = $derived($callTransportState.activeTransport);
	const recording = $derived($callRecordingState.status === 'recording');
	const recordElapsedLabel = $derived(
		recording ? formatRecordingElapsedForUi($callRecordingState.elapsedMs) : ''
	);
	/** Own screen preview: the wabidb lane self-filters our stream, so without
	 * an explicit local tile you can never confirm your own share is live
	 * (2026-08-27 report: "no confirming self-seeing-of your own screen"). */
	const ownScreenStream = $derived(
		($localScreenStream?.getVideoTracks().length ?? 0) > 0 ? $localScreenStream : null
	);

	async function handleToggleRecord(): Promise<void> {
		if (recordBusy) return;
		recordBusy = true;
		try {
			if ($callRecordingState.status === 'recording' || $callRecordingState.status === 'saving') {
				await stopCallRecording();
				return;
			}
			await startCallRecording();
		} catch (err) {
			console.error('[VoiceView] recording toggle failed:', err);
		} finally {
			recordBusy = false;
		}
	}
	async function handleTransportSwap(): Promise<void> {
		if (transportSwapBusy) return;
		transportSwapBusy = true;
		try {
			const socket = getSocket();
			if (!socket || !socket.connected) {
				pushVoiceNotice('Not connected to server — cannot swap transport');
				return;
			}
			await switchCallTransport(socket, currentTransport === 'wabidb' ? 'p2p' : 'wabidb');
		} catch (err) {
			console.error('[VoiceView] transport swap failed:', err);
		} finally {
			transportSwapBusy = false;
		}
	}
	function pushVoiceNotice(text: string): void {
		console.warn(`[VoiceView] ${text}`);
	}
	import VideoSink from './VideoSink.svelte';

	let sessions = $derived([...$callSessions.values()].sort((a, b) => {
		if (a.focus === 'focused') return -1;
		if (b.focus === 'focused') return 1;
		return b.joinedAt - a.joinedAt;
	}));

	let voiceChannels = $derived(
		[...$channels]
			.filter((ch) => ch.type === 'voice')
			.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))
	);

	function occupancy(channelId: string): number {
		return $voiceChannelMembers[channelId]?.length ?? 0;
	}

	function rosterAvatars(sessionId: string, channelId: string | null): Array<{ userId: string; username: string; picture: string | null }> {
		const roster = channelId ? ($voiceChannelMembers[channelId] ?? null) : null;
		if (roster && roster.length > 0) {
			return roster.map((m: any) => ({ userId: m.userId, username: m.username ?? '', picture: m.profilePicture ?? null }));
		}
		const session = $callSessions.get(sessionId);
		if (session && session.kind !== 'channel' && session.participants.length === 0) {
			// DM/group sessions have no channel roster — fall back to the
			// live p2p call list (review F4).
			return $activeCalls.map((call) => ({ userId: call.userId, username: call.username ?? call.userId, picture: null }));
		}
		return (session?.participants ?? []).map((p) => ({ userId: p.userId, username: p.username, picture: null }));
	}

	function sessionVideos(sessionId: string): Array<[string, MediaStream]> {
		const session = $callSessions.get(sessionId);
		if (!session) return [];
		const ids = new Set(session.participants.map((p) => p.userId));
		const entries = [...$wabidbRemoteVideoStreams.entries()].filter(([key]) => {
			const owner = key.replace(/:(camera|screen)$/, '');
			return ids.has(owner);
		});
		// P2P screenshares (round 5): after a transport swap these live in the
		// screenShares store, not the wabidb lane — fold them in by owner. The
		// wabidb entry wins on dedupe, so keys never collide.
		for (const share of $screenShares) {
			const owner = /^\d+$/.test(share.userId) ? `user-${share.userId}` : share.userId;
			if (!ids.has(owner)) continue;
			if (entries.some(([key]) => key === `${owner}:screen`)) continue;
			entries.push([`${owner}:screen`, share.stream]);
		}
		return entries;
	}

	function initial(username: string): string {
		return (username || '?').trim().charAt(0).toUpperCase();
	}

	// Sessions register with `name: channelId` as a placeholder (channels load
	// async) — resolve the real channel name reactively at render time.
	function displayName(session: { id: string; name?: string | null; channelId?: string | null }): string {
		return (
			(session.channelId ? $channels.find((c) => c.id === session.channelId)?.name : undefined) ??
			session.name ??
			session.id
		);
	}
</script>

<div class="vv">
	<header class="vv-header">
		<h2>Voice</h2>
		<span class="vv-sub">
			{sessions.length === 0
				? 'No active calls'
				: `${sessions.length} active call${sessions.length === 1 ? '' : 's'}`}
		</span>
	</header>

	{#if sessions.length > 0}
		<section class="vv-cards" aria-label="Connected calls">
			{#each sessions as session (session.id)}
				{@const badge = sessionBadge(session)}
				{@const avatars = rosterAvatars(session.id, session.channelId)}
				{@const videos = sessionVideos(session.id)}
				<article class="vv-card" class:focused={badge === 'focused'} class:silenced={badge === 'silenced'}>
					<div class="vv-card-head">
						<span class="vv-card-name">{displayName(session)}</span>
						{#if badge !== 'focused'}
							<span class="vv-badge" data-badge={badge}>{badge}</span>
						{/if}
						<span class="vv-transport" title={`Transport: ${session.transport ?? session.lifecycle}`}>
							{session.transport ? session.transport.toUpperCase() : session.lifecycle}
						</span>
					</div>

					{#if videos.length > 0 || ownScreenStream}
					<div class="vv-card-videos">
						{#if ownScreenStream}
							<div class="vv-card-video screen own">
								<VideoSink stream={ownScreenStream} />
								<span class="vv-video-label">
									<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
									Your screen
								</span>
							</div>
						{/if}
						{#each videos.slice(0, 4) as [key, stream] (key)}
								{@const owner = key.replace(/:(camera|screen)$/, '')}
								<div class="vv-card-video" class:screen={key.endsWith(':screen')}>
									<VideoSink {stream} />
									<span class="vv-video-label">
										{#if key.endsWith(':screen')}
											<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
										{:else}
											<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
										{/if}
										{owner}
									</span>
								</div>
							{/each}
						</div>
					{/if}

					<div class="vv-card-people">
						{#each avatars.slice(0, 6) as person (person.userId)}
							<span class="vv-avatar" title={person.username || person.userId}>
								{#if person.picture}
									<img src={person.picture} alt={person.username || person.userId} />
								{:else}
									{initial(person.username || person.userId)}
								{/if}
							</span>
						{/each}
						{#if avatars.length > 6}<span class="vv-avatar overflow">+{avatars.length - 6}</span>{/if}
						<span class="vv-count">{avatars.length} in call</span>
					</div>

					<div class="vv-card-controls">
						<label class="vv-volume">
							<span class="vv-volume-icon" aria-hidden="true">
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
							</span>
							<input
								type="range"
								min="0"
								max="100"
								step="5"
								value={session.volume}
								oninput={(e) => setCallVolume(session.id, Number((e.currentTarget as HTMLInputElement).value))}
								aria-label={`Volume for ${displayName(session)}`}
							/>
							<span class="vv-volume-value">{session.volume}%</span>
						</label>
						<div class="vv-buttons">
							<button type="button" class:active={session.muted} onclick={() => toggleCallSpeaker(session.id)} title="Mute this call's audio" aria-label="Mute this call's audio">
								{#if session.muted}
									<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
								{:else}
									<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
								{/if}
							</button>
							{#if badge !== 'focused'}
								<button type="button" onclick={() => focusCall(session.id)} title="Focus this call">
									<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
									Focus
								</button>
							{/if}
							<button type="button" class="danger" onclick={() => leaveCall(session)} title="Leave this call">Hang up</button>
						</div>
					</div>
				</article>
			{/each}
		</section>
	{:else}
		<div class="vv-empty">Join a channel below to start a call — audio stays docked while you work anywhere.</div>
	{/if}

	<section class="vv-channels" aria-label="Voice channels">
		<h3>Channels</h3>
		<div class="vv-channel-list">
			{#each voiceChannels as ch (ch.id)}
				{@const connected = $callSessions.has(ch.id)}
				{@const count = occupancy(ch.id)}
				<div class="vv-channel" class:connected>
					<span class="vv-channel-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
					</span>
					<span class="vv-channel-name">{ch.name ?? ch.id}</span>
					{#if count > 0}
						<span class="vv-channel-occupants">
							{#each ($voiceChannelMembers[ch.id] ?? []).slice(0, 5) as m (m.userId)}
								<span class="vv-avatar small" title={m.username ?? m.userId}>
									{#if m.profilePicture}
										<img src={m.profilePicture} alt={m.username ?? m.userId} />
									{:else}
										{initial(m.username ?? m.userId)}
									{/if}
								</span>
							{/each}
							<span class="vv-count">{count}</span>
						</span>
					{/if}
					<button type="button" onclick={() => joinVoice(ch.id)}>
						{connected ? 'Connected' : count > 0 ? 'Listen / Join' : 'Join'}
					</button>
				</div>
			{/each}
		</div>
	</section>

	<footer class="vv-global" aria-label="Global call controls">
		<button type="button" class:active={$isMuted} onclick={() => ($isMuted ? unmuteAllMic() : muteAllMic())}>
			{$isMuted ? 'Unmic All' : 'Mute All'}
		</button>
		<button type="button" class:active={$isDeafened} onclick={() => ($isDeafened ? undeafenAll() : deafenAll())}>
			{$isDeafened ? 'Undeafen All' : 'Deafen All'}
		</button>
		<button type="button" onclick={cameraOff}>Camera Off</button>
	<button
		type="button"
		class="record"
		class:active={recording}
		onclick={handleToggleRecord}
		disabled={sessions.length === 0 || recordBusy || $callRecordingState.status === 'saving'}
		title={recording ? 'Stop recording and save' : 'Record this call (mixed audio)'}
	>
		{recording ? `⏺ ${recordElapsedLabel} — Stop` : '⏺ Record'}
	</button>
		<button
			type="button"
			class="swap"
			onclick={handleTransportSwap}
			disabled={sessions.length === 0 || transportSwapBusy}
			title="Swap every live call between the wabidb relay and direct peer-to-peer without leaving"
		>
			{transportSwapBusy ? 'Swapping…' : currentTransport === 'wabidb' ? 'Swap to P2P' : 'Swap to WabiDB'}
		</button>
		<button type="button" class="danger" onclick={leaveAllCalls} disabled={sessions.length === 0}>Leave All</button>
	</footer>
</div>
