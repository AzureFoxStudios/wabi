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
	import { isMuted, isDeafened } from '$lib/calling';
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
		return (session?.participants ?? []).map((p) => ({ userId: p.userId, username: p.username, picture: null }));
	}

	function sessionVideos(sessionId: string): Array<[string, MediaStream]> {
		const session = $callSessions.get(sessionId);
		if (!session) return [];
		const ids = new Set(session.participants.map((p) => p.userId));
		return [...$wabidbRemoteVideoStreams.entries()].filter(([key]) => {
			const owner = key.replace(/:(camera|screen)$/, '');
			return ids.has(owner);
		});
	}

	function initial(username: string): string {
		return (username || '?').trim().charAt(0).toUpperCase();
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
						<span class="vv-card-name">{session.name || session.id}</span>
						<span class="vv-badge" data-badge={badge}>{badge}</span>
						<span class="vv-transport" title={`Transport: ${session.transport ?? session.lifecycle}`}>
							{session.transport ? session.transport.toUpperCase() : session.lifecycle}
						</span>
					</div>

					{#if videos.length > 0}
						<div class="vv-card-videos">
							{#each videos.slice(0, 4) as [key, stream] (key)}
								{@const owner = key.replace(/:(camera|screen)$/, '')}
								<div class="vv-card-video" class:screen={key.endsWith(':screen')}>
									<VideoSink {stream} />
									<span class="vv-video-label">{key.endsWith(':screen') ? '📺' : '🎥'} {owner}</span>
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
							<span>🔊</span>
							<input
								type="range"
								min="0"
								max="100"
								step="5"
								value={session.volume}
								oninput={(e) => setCallVolume(session.id, Number((e.currentTarget as HTMLInputElement).value))}
								aria-label={`Volume for ${session.name || session.id}`}
							/>
							<span class="vv-volume-value">{session.volume}%</span>
						</label>
						<div class="vv-buttons">
							<button type="button" class:active={session.muted} onclick={() => toggleCallSpeaker(session.id)} title="Mute this call's audio">
								{session.muted ? '🔇' : '🔈'}
							</button>
							{#if badge !== 'focused'}
								<button type="button" onclick={() => focusCall(session.id)} title="Focus this call">🎯 Focus</button>
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
					<span class="vv-channel-icon">🔊</span>
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
		<button type="button" class="danger" onclick={leaveAllCalls} disabled={sessions.length === 0}>Leave All</button>
	</footer>
</div>
