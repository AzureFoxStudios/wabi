<!-- frontend/src/lib/components/CallDebugPanel.svelte
	Shareable calling-diagnostics panel. Shows the metrics captured by
	callingDiagnostics.ts (ping/jitter/loss/bitrate/packet totals) plus the
	active transport and participant count. Works on BOTH transports: samples
	come from WebRTC getStats() or the wabidb relay counters + socket RTT
	echo, tagged via the `source` row. Pure read-only view of the call
	stores — safe to embed anywhere; MainLayout floats it over the stage.
	A developer instrument (design contract §9.4): it renders only in dev builds, so members
	never see raw transport names or lifecycle enums.
-->
<script lang="ts">
	import { activeCalls, activeVoiceChannel, callConnectionDiagnostics, callTransportState, connectionState } from '$lib/calling';
	import { voiceChannelMembers } from '$lib/presenceStore';
	import { callParticipantCount, formatDiag } from '$lib/components/sidebar/channelSidebarHelpers';

	const isDevBuild = import.meta.env.DEV;

	let {
		open = false,
		title = 'Calling Diagnostics',
		showConnectionState = true,
		showTransport = true,
		showParticipants = true
	}: {
		open?: boolean;
		title?: string;
		showConnectionState?: boolean;
		showTransport?: boolean;
		showParticipants?: boolean;
	} = $props();

	const rows = $derived.by(() => {
		const d = $callConnectionDiagnostics;
		const items: Array<{ label: string; value: string }> = [
			{ label: d.source === 'wabidb' ? 'Signaling round trip' : 'WebRTC round trip', value: formatDiag(d.pingMs, 'ms') },
			{ label: 'Jitter', value: formatDiag(d.jitterMs, 'ms') },
			{ label: 'Inbound Loss', value: formatDiag(d.inboundPacketLossPct, '%') },
			{ label: 'Outbound Loss', value: formatDiag(d.outboundPacketLossPct, '%') },
			{ label: 'Inbound Rate', value: formatDiag(d.inboundKbps, 'kbps') },
			{ label: 'Outbound Rate', value: formatDiag(d.outboundKbps, 'kbps') },
			{ label: 'Packets ↑', value: formatDiag(d.packetsSent ?? null, '') },
			{ label: 'Packets ↓', value: formatDiag(d.packetsReceived ?? null, '') }
		];
		if (showTransport) {
			items.push({
				label: 'Transport',
				value: `${$callTransportState.activeTransport.toUpperCase()}${d.source ? ` (${d.source === 'webrtc' ? 'WebRTC stats' : 'wabidb relay'})` : ''}`
			});
		}
		if (showParticipants) {
			// activeCalls is a WebRTC/SFU-only store — the roster is the
			// truthful count on the relay AND on an idle p2p tail. See
			// callParticipantCount.
			const rosterLength = $activeVoiceChannel
				? ($voiceChannelMembers[$activeVoiceChannel.id]?.length ?? null)
				: null;
			items.push({
				label: 'Participants',
				value: String(
					callParticipantCount($callTransportState.activeTransport, $activeCalls.length, rosterLength)
				)
			});
		}
		return items;
	});
</script>

{#if open && isDevBuild}
	<section class="call-debug-panel" role="status" aria-live="polite">
		<header class="call-debug-panel-header">
			<strong>{title}</strong>
			{#if showConnectionState}
				<span
					class="call-debug-state"
					class:connected={$connectionState === 'connected'}
					class:degraded={$connectionState === 'connecting' ||
						$connectionState === 'signaling' ||
						$connectionState === 'reconnecting'}
					class:failed={$connectionState === 'failed' || $connectionState === 'disconnected'}
				>
					{$connectionState}
				</span>
			{/if}
		</header>
		<p class="call-debug-scope">This device’s observations. Round-trip time does not measure microphone-to-speaker delay.</p>
		<div class="call-debug-grid">
			{#each rows as row (row.label)}
				<div class="call-debug-item">
					<span>{row.label}</span>
					<strong>{row.value}</strong>
				</div>
			{/each}
		</div>
	</section>
{/if}

<style>
	.call-debug-panel {
		box-sizing: border-box;
		min-width: 240px;
		max-width: 320px;
		overflow: hidden;
		border: var(--w-bw) solid var(--w-line-strong);
		border-radius: var(--radius-lg);
		background: var(--w-bg2);
		box-shadow: var(--w-shadow);
		color: var(--w-text);
		font: var(--w-t-small);
	}

	.call-debug-panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 10px 12px;
		border-bottom: var(--w-bw) solid var(--w-line);
		font: var(--w-t-label);
	}

	.call-debug-scope {
		max-width: 28rem;
		margin: 0;
		padding: 8px 12px 0;
		color: var(--w-mute);
		font: var(--w-t-small);
	}

	/* Status is a mark plus a word (§5.3). */
	.call-debug-state {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--w-mute);
		font: var(--w-t-micro);
	}

	.call-debug-state::before {
		content: '';
		width: 6px;
		height: 6px;
		border-radius: var(--w-avr);
		background: var(--w-faint);
	}

	.call-debug-state.connected::before {
		background: var(--w-online);
	}

	.call-debug-state.degraded::before {
		background: var(--w-warn);
	}

	.call-debug-state.failed::before {
		background: var(--w-danger);
	}

	.call-debug-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 6px 12px;
		padding: 10px 12px 12px;
	}

	.call-debug-item {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
		font: var(--w-t-caption);
	}

	.call-debug-item span {
		color: var(--w-faint);
	}

	.call-debug-item strong {
		color: var(--w-text);
		font: var(--w-t-mono);
		font-feature-settings: 'tnum';
	}

	@media (max-width: 768px) {
		.call-debug-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
