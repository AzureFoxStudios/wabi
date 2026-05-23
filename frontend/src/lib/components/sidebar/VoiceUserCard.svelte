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

	export let runtimeActiveVoiceChannelId: string | null;
	export let voiceChannels: Channel[];
	export let voiceDurationMode: 'off' | 'others' | 'all';

	export let onToggleListenChannel: (channelId: string) => void;
	export let onTransmitModeChange: (event: Event) => void;
	export let onSetVoiceDurationMode: (mode: 'off' | 'others' | 'all') => void;
	export let onLeaveVoice: () => Promise<void>;

	let showVoiceDebugDetails = false;

	$: activeListenChips = voiceChannels.filter(ch =>
		$listeningVoiceChannels.includes(ch.id) || ch.id === runtimeActiveVoiceChannelId
	);

	function getCurrentVoiceChannelName(): string {
		if (!runtimeActiveVoiceChannelId) return '';
		const match = voiceChannels.find((channel) => channel.id === runtimeActiveVoiceChannelId);
		return match?.name || runtimeActiveVoiceChannelId;
	}

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
					<small>{getCurrentVoiceChannelName()} / {$callConnectionState}</small>
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
					<button
						type="button"
						class="voice-listen-chip"
						class:active={$listeningVoiceChannels.includes(voiceChannel.id) || voiceChannel.id === runtimeActiveVoiceChannelId}
						class:locked={voiceChannel.id === runtimeActiveVoiceChannelId}
						on:click={() => onToggleListenChannel(voiceChannel.id)}
						title={voiceChannel.id === runtimeActiveVoiceChannelId ? 'Primary voice channel' : $listeningVoiceChannels.includes(voiceChannel.id) ? 'Stop listening' : 'Start listening'}
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
			<button class="leave-btn" on:click={onLeaveVoice} title="Leave voice channel">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07C9.44 17.28 8.17 16 7.05 14.68A19.79 19.79 0 0 1 4 6.05 2 2 0 0 1 5.99 4h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L10.68 11.68"/><line x1="23" y1="1" x2="1" y2="23"/></svg>
			</button>
		</div>
	</div>
{/if}
