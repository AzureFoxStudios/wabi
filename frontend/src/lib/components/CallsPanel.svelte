<script lang="ts">
	/**
	 * Phase 4 — the right-panel calls controller (figure 2): one compact card
	 * per connected call with status badge, transport, participant avatars,
	 * per-call controls and volume. Available from anywhere via the panel
	 * system, exactly like People/Messages.
	 */
	import { callSessions } from '$lib/callSessionManager';
	import { sessionBadge } from '$lib/callSessionTypes';
	import { channels } from '$lib/channelStore';
	import { activeCalls } from '$lib/calling';
	import {
		leaveCall,
		focusCall,
		setCallVolume,
		toggleCallSpeaker
	} from '$lib/callSurfaces';

	let sessions = $derived([...$callSessions.values()].sort((a, b) => {
		if (a.focus === 'focused') return -1;
		if (b.focus === 'focused') return 1;
		return b.joinedAt - a.joinedAt;
	}));

	function initial(username: string): string {
		return (username || '?').trim().charAt(0).toUpperCase();
	}

	// Sessions register with `name: channelId` as a placeholder — resolve the
	// real channel name reactively at render time.
	function displayName(session: { id: string; name?: string | null; channelId?: string | null }): string {
		return (
			(session.channelId ? $channels.find((c) => c.id === session.channelId)?.name : undefined) ??
			session.name ??
			session.id
		);
	}

	// DM/group sessions have no channel roster — their participants live in
	// the p2p call list (review F4).
	function avatarPeople(session: { kind: string; participants: Array<{ userId: string; username: string }> }): Array<{ userId: string; username: string }> {
		if (session.kind !== 'channel' && session.participants.length === 0) {
			return $activeCalls.map((call) => ({ userId: call.userId, username: call.username ?? call.userId }));
		}
		return session.participants;
	}
</script>

<div class="cpanel">
	<header class="cpanel-head">
		<span class="cpanel-title">Calls</span>
		<span class="cpanel-count">
			{sessions.length === 0 ? 'no active calls' : `${sessions.length} active call${sessions.length === 1 ? '' : 's'}`}
		</span>
	</header>

	{#if sessions.length === 0}
		<div class="cpanel-empty">Not connected to any call.</div>
	{:else}
		{#each sessions as session (session.id)}
			{@const badge = sessionBadge(session)}
			<section class="cpanel-card" data-badge={badge}>
				<header class="cpanel-card-head">
					<span class="cpanel-name">{displayName(session)}</span>
					{#if badge !== 'focused'}
						<span class="vv-badge" data-badge={badge}>{badge}</span>
					{/if}
				</header>
				<div class="cpanel-meta">
					<span class="cpanel-transport" title={`Transport: ${session.transport ?? session.lifecycle}`}>
						{session.transport ? session.transport.toUpperCase() : session.lifecycle}
					</span>
					<span class="cpanel-participants">
						{#each avatarPeople(session).slice(0, 5) as p (p.userId)}
							<span class="vv-avatar small" title={p.username || p.userId}>{initial(p.username || p.userId)}</span>
						{/each}
						{#if avatarPeople(session).length > 5}
							<span class="vv-avatar small overflow">+{avatarPeople(session).length - 5}</span>
						{/if}
					</span>
				</div>
				<div class="cpanel-controls">
					<button type="button" class:active={session.muted} onclick={() => toggleCallSpeaker(session.id)} title="Mute this call's audio" aria-label="Mute this call's audio">
						{#if session.muted}
							<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
						{:else}
							<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
						{/if}
					</button>
					{#if badge !== 'focused'}
						<button type="button" onclick={() => focusCall(session.id)} title="Focus this call" aria-label="Focus this call">
							<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
						</button>
					{/if}
					<button type="button" class="danger" onclick={() => leaveCall(session)} title="Hang up" aria-label="Hang up">
						<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07C9.44 17.28 8.17 16 7.05 14.68A19.79 19.79 0 0 1 4 6.05 2 2 0 0 1 5.99 4h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L10.68 11.68"/><line x1="23" y1="1" x2="1" y2="23"/></svg>
					</button>
					<label class="cpanel-volume">
						<span>You</span>
						<input
							type="range"
							min="0"
							max="100"
							step="5"
							value={session.volume}
							oninput={(e) => setCallVolume(session.id, Number((e.currentTarget as HTMLInputElement).value))}
							aria-label={`Volume for ${displayName(session)}`}
						/>
						<span class="cpanel-volume-value">{session.volume}%</span>
					</label>
				</div>
			</section>
		{/each}
	{/if}
</div>
