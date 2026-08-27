<!-- frontend/src/lib/components/CallDebugPanel.svelte
	Shareable calling-diagnostics panel. Shows the metrics captured by
	callingDiagnostics.ts (ping/jitter/loss/bitrate/packet totals) plus the
	active transport and participant count. Works on BOTH transports: samples
	come from WebRTC getStats() or the wabidb relay counters + socket RTT
	echo, tagged via the `source` row. Pure read-only view of the call
	stores — safe to embed anywhere; used as a floating overlay in MainLayout
	(shown while a call is active, not just in dev builds).
-->
<script lang="ts">
	import { activeCalls, callConnectionDiagnostics, callTransportState, connectionState } from '$lib/calling';
	import { formatDiag } from '$lib/components/sidebar/channelSidebarHelpers';

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
			{ label: 'Ping', value: formatDiag(d.pingMs, 'ms') },
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
			items.push({ label: 'Participants', value: String(1 + $activeCalls.length) });
		}
		return items;
	});
</script>

{#if open}
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
		min-width: 240px;
		max-width: 320px;
		border-radius: var(--radius-md, 8px);
		border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
		background: var(--surface-raised, #302b63);
		color: var(--text-heading, #e0e0ff);
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
		overflow: hidden;
	}

	.call-debug-panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.5rem 0.6rem;
		font-size: 0.78rem;
		background: var(--surface-base, #24243e);
		border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
	}

	.call-debug-state {
		padding: 0.1rem 0.45rem;
		border-radius: 999px;
		font-size: 0.65rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted, #9999ff);
		background: rgba(var(--text-inverse-rgb, 255, 255, 255), 0.06);
	}

	.call-debug-state.connected {
		color: var(--color-success, #22c55e);
		background: rgba(var(--color-success-rgb, 34, 197, 94), 0.15);
	}

	.call-debug-state.degraded {
		color: var(--color-warning, #f59e0b);
		background: rgba(var(--color-warning-rgb, 245, 158, 11), 0.15);
	}

	.call-debug-state.failed {
		color: var(--color-danger, #ef4444);
		background: rgba(var(--color-danger-rgb, 239, 68, 68), 0.15);
	}

	.call-debug-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.45rem 0.7rem;
		padding: 0.55rem 0.6rem;
	}

	.call-debug-item {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 0.5rem;
		font-size: 0.72rem;
	}

	.call-debug-item span {
		color: var(--text-secondary, #b3b3ff);
	}

	.call-debug-item strong {
		color: var(--text-heading, #e0e0ff);
		font-size: 0.74rem;
		font-family: var(--font-mono, ui-monospace, monospace);
	}

	@media (max-width: 768px) {
		.call-debug-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
