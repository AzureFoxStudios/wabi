<script lang="ts">
	import type { Channel } from '$lib/socket';
	import {
		callMode,
		connectionState as callConnectionState,
		callConnectionDiagnostics,
		callTransportState,
		listeningVoiceChannels,
		voiceTransmitMode,
		isVideoOff,
		isSharing,
		canScreenShare,
		isMuted as callMuted,
		isDeafened as callDeafened,
		toggleVideo,
		startScreenShare,
		stopScreenShare,
		activeCalls
	} from '$lib/calling';
	import { formatDiag } from './channelSidebarHelpers';
	import { getSocket } from '$lib/socketConnection';
	import { callRecordingState, startCallRecording, stopCallRecording } from '$lib/callRecording';
	import { callSessions } from '$lib/callSessionManager';

	export let runtimeActiveVoiceChannelId: string | null;
	export let voiceChannels: Channel[];
	export let voiceDurationMode: 'off' | 'others' | 'all';

	export let onToggleListenChannel: (channelId: string) => void;
	export let onTransmitModeChange: (event: Event) => void;
	export let onSetVoiceDurationMode: (mode: 'off' | 'others' | 'all') => void;
	export let onLeaveVoice: () => Promise<void>;

	let showVoiceDebugDetails = false;

	// ============================================================================
	// SVELTE 5 REACTIVITY CONTRACT (do not regress)
	// ============================================================================
	// Template expressions that call script functions compile to
	// `$.untrack(() => fn(args))` in Svelte 5 legacy mode: args stay tracked but
	// store/prop reads INSIDE the body register no dependency. The old
	// `getCurrentVoiceChannelName()` helper made this card's header show a STALE
	// channel name when switching primary / joining multiple channels (proven via
	// compiler probe 2026-08-24). All reactivity flows through top-level `$:`
	// derivations below; the template only references the derived values.

	$: activeListenChips = voiceChannels.filter(ch =>
		$listeningVoiceChannels.includes(ch.id) || ch.id === runtimeActiveVoiceChannelId
	);
	$: isBroadcasting = $voiceTransmitMode === 'all-listening' && activeListenChips.length > 1 && !$callMuted;

	function resolveChannelName(channelId: string | null): string {
		if (!channelId) return '';
		const match = voiceChannels.find((channel) => channel.id === channelId);
		return match?.name || channelId;
	}

	// Primary channel first, then every additional listened channel, deduped.
	$: connectedChannelEntries = (() => {
		const entries: Array<{ id: string; name: string; isPrimary: boolean }> = [];
		const seen = new Set<string>();
		if (runtimeActiveVoiceChannelId) {
			entries.push({ id: runtimeActiveVoiceChannelId, name: resolveChannelName(runtimeActiveVoiceChannelId), isPrimary: true });
			seen.add(runtimeActiveVoiceChannelId);
		}
		for (const id of $listeningVoiceChannels) {
			if (seen.has(id)) continue;
			seen.add(id);
			entries.push({ id, name: resolveChannelName(id), isPrimary: false });
		}
		return entries;
	})();

	// Chip visual state derived up here so the template each-body never reads a
	// store inside an untracked attribute expression (stale tooltips bug).
	$: listenChipStates = (() => {
		const map = new Map<string, { active: boolean; locked: boolean; title: string }>();
		for (const channel of activeListenChips) {
			const isPrimary = channel.id === runtimeActiveVoiceChannelId;
			const isListening = $listeningVoiceChannels.includes(channel.id);
			map.set(channel.id, {
				active: isPrimary || isListening,
				locked: isPrimary,
				title: isPrimary ? 'Primary voice channel' : isListening ? 'Stop listening' : 'Start listening'
			});
		}
		return map;
	})();

	$: currentVoiceChannelName =
		runtimeActiveVoiceChannelId
			? resolveChannelName(runtimeActiveVoiceChannelId)
			: '';

	// Phase 5: connecting→connected badge from the session model (inline
	// store reads in the $: derivation — the card's reactivity contract).
	$: sessionConnectionLabel = (() => {
		const sessions = [...$callSessions.values()];
		const pending = sessions.filter((s) => s.lifecycle === 'joining' || s.lifecycle === 'reconnecting');
		if (sessions.length > 0 && pending.length === sessions.length) return 'Connecting…';
		if (pending.length > 0) return `Connecting… (${pending.length}/${sessions.length})`;
		const failed = sessions.filter((s) => s.lifecycle === 'failed');
		if (failed.length > 0) return 'Connection trouble';
		return '';
	})();

	async function handleToggleVideo() {
		await toggleVideo(getSocket() || undefined);
	}

	async function handleToggleScreenShare() {
		const sock = getSocket();
		if (!sock) return;
		if ($isSharing) {
			stopScreenShare(sock);
		} else {
			try {
				await startScreenShare(sock);
			} catch {
				// swallow
			}
		}
	}

	// Ported from the removed channel docked bar so recording capability is
	// preserved after the bar's removal (calling-audit P2.1).
	async function handleToggleRecording() {
		if ($callRecordingState.status === 'recording' || $callRecordingState.status === 'saving') {
			await stopCallRecording();
			return;
		}
		await startCallRecording();
	}
</script>

{#if $callMode === 'channel' && runtimeActiveVoiceChannelId}
	<div class="voice-usercard">
		<button
			type="button"
			class="voice-usercard-header"
			on:click={() => (showVoiceDebugDetails = !showVoiceDebugDetails)}
			aria-expanded={showVoiceDebugDetails}
		>
				<div class="voice-usercard-title">
					<span class="voice-online-dot"></span>
					<div>
						<strong>Voice Connected</strong>
						{#if sessionConnectionLabel}
							<small class="voice-connection-badge">{sessionConnectionLabel}</small>
						{/if}
						<small>{currentVoiceChannelName} / {$callConnectionState}</small>
					{#if connectedChannelEntries.length > 1}
						<small class="voice-listen-summary">Listening: {connectedChannelEntries.filter(e => !e.isPrimary).map(e => e.name).join(', ')}</small>
					{/if}
					{#if isBroadcasting}
						<small class="voice-broadcast-badge">Broadcasting to {activeListenChips.length} channels</small>
					{/if}
				</div>
			</div>
			<span class="voice-chevron">{showVoiceDebugDetails ? 'v' : '>'}</span>
		</button>

		{#if showVoiceDebugDetails}
			<div class="voice-usercard-debug">
				<div><span>Ping</span><strong>{formatDiag($callConnectionDiagnostics.pingMs, 'ms')}</strong></div>
				<div><span>Jitter</span><strong>{formatDiag($callConnectionDiagnostics.jitterMs, 'ms')}</strong></div>
				<div><span>In Loss</span><strong>{formatDiag($callConnectionDiagnostics.inboundPacketLossPct, '%')}</strong></div>
				<div><span>Out Loss</span><strong>{formatDiag($callConnectionDiagnostics.outboundPacketLossPct, '%')}</strong></div>
				<div><span>In Rate</span><strong>{formatDiag($callConnectionDiagnostics.inboundKbps, 'kbps')}</strong></div>
				<div><span>Out Rate</span><strong>{formatDiag($callConnectionDiagnostics.outboundKbps, 'kbps')}</strong></div>
				<div><span>Transport</span><strong>{$callTransportState.activeTransport.toUpperCase()}</strong></div>
				<div><span>Participants</span><strong>{1 + $activeCalls.length}</strong></div>
			</div>
		{/if}

		<div class="voice-route-controls">
			<label for="voice-transmit-mode">Transmit</label>
			<select id="voice-transmit-mode" on:change={onTransmitModeChange} value={$voiceTransmitMode}>
				<option value="primary">Primary channel</option>
				<option value="all-listening">All listening channels</option>
			</select>
		</div>

		<div class="voice-route-controls">
			<label for="voice-duration-mode">Timers</label>
			<select
				id="voice-duration-mode"
				value={voiceDurationMode}
				on:change={(event) => onSetVoiceDurationMode((event.currentTarget as HTMLSelectElement).value as 'off' | 'others' | 'all')}
			>
				<option value="off">Off</option>
				<option value="others">Others</option>
				<option value="all">All</option>
			</select>
		</div>

		{#if $listeningVoiceChannels.length > 0}
		<div class="voice-listen-controls">
			<div class="voice-listen-title">Listen In</div>
			<div class="voice-listen-list">
				{#each activeListenChips as voiceChannel (voiceChannel.id)}
					{@const chip = listenChipStates.get(voiceChannel.id)}
					<button
						type="button"
						class="voice-listen-chip"
						class:active={chip?.active}
						class:locked={chip?.locked}
						on:click={() => onToggleListenChannel(voiceChannel.id)}
						title={chip?.title ?? ''}
					>
						{voiceChannel.name}
					</button>
				{/each}
			</div>
		</div>
		{/if}

		<div class="voice-usercard-actions">
			<button class:active={!$isVideoOff} on:click={handleToggleVideo} title={$isVideoOff ? 'Turn on camera' : 'Turn off camera'}>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
			</button>
			{#if canScreenShare()}
			<button class:active={$isSharing} on:click={handleToggleScreenShare} title={$isSharing ? 'Stop sharing' : 'Share screen'}>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
			</button>
			{/if}
			<button
				class="record-btn"
				class:active={$callRecordingState.status === 'recording'}
				on:click={handleToggleRecording}
				title={$callRecordingState.status === 'recording' ? 'Stop recording' : 'Start recording'}
				disabled={$callRecordingState.status === 'saving'}
			>
				{$callRecordingState.status === 'saving' ? 'Saving' : $callRecordingState.status === 'recording' ? 'REC' : 'Record'}
			</button>
			<button class="leave-btn" on:click={onLeaveVoice} title="Leave voice channel">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07C9.44 17.28 8.17 16 7.05 14.68A19.79 19.79 0 0 1 4 6.05 2 2 0 0 1 5.99 4h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L10.68 11.68"/><line x1="23" y1="1" x2="1" y2="23"/></svg>
			</button>
		</div>
	</div>
{/if}

<style>
	.voice-broadcast-badge {
		display: inline-block;
		margin-top: 2px;
		padding: 1px 6px;
		border-radius: 999px;
		background: rgba(152, 216, 200, 0.18);
		color: var(--accent, #98d8c8);
		font-size: 0.7rem;
		font-weight: 600;
		letter-spacing: 0.02em;
	}

	.voice-listen-summary {
		display: block;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		opacity: 0.75;
	}
</style>
