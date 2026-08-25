<script lang="ts">
	/**
	 * Phase 4 — the right-panel calls controller (figure 2): one compact card
	 * per connected call with status badge, transport, participant avatars,
	 * per-call controls and volume. Available from anywhere via the panel
	 * system, exactly like People/Messages.
	 */
	import { callSessions } from '$lib/callSessionManager';
	import { sessionBadge } from '$lib/callSessionTypes';
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
					<span class="cpanel-name">{session.name || session.id}</span>
					<span class="vv-badge" data-badge={badge}>{badge}</span>
				</header>
				<div class="cpanel-meta">
					<span class="cpanel-transport" title={`Transport: ${session.transport ?? session.lifecycle}`}>
						{session.transport ? session.transport.toUpperCase() : session.lifecycle}
					</span>
					<span class="cpanel-participants">
						{#each session.participants.slice(0, 5) as p (p.userId)}
							<span class="vv-avatar small" title={p.username || p.userId}>{initial(p.username || p.userId)}</span>
						{/each}
						{#if session.participants.length > 5}
							<span class="vv-avatar small overflow">+{session.participants.length - 5}</span>
						{/if}
					</span>
				</div>
				<div class="cpanel-controls">
					<button type="button" class:active={session.muted} onclick={() => toggleCallSpeaker(session.id)} title="Mute this call's audio">🔈</button>
					{#if badge !== 'focused'}
						<button type="button" onclick={() => focusCall(session.id)} title="Focus this call">🎯</button>
					{/if}
					<button type="button" class="danger" onclick={() => leaveCall(session)} title="Hang up">✕</button>
					<label class="cpanel-volume">
						<span>You</span>
						<input
							type="range"
							min="0"
							max="100"
							step="5"
							value={session.volume}
							oninput={(e) => setCallVolume(session.id, Number((e.currentTarget as HTMLInputElement).value))}
							aria-label={`Volume for ${session.name || session.id}`}
						/>
						<span class="cpanel-volume-value">{session.volume}%</span>
					</label>
				</div>
			</section>
		{/each}
	{/if}
</div>
