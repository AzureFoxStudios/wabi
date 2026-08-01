<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$app/environment';
	import { connectionState, type ConnectionState } from '$lib/socketConnectionState';

	/** Finding 21: badge reflects Wabi socket health + browser network, not navigator.onLine alone. */
	type BadgeStatus = 'online' | 'offline' | 'connecting' | 'reconnecting' | 'unreachable';

	let browserOnline = true;
	let socketState: ConnectionState = 'disconnected';
	let status: BadgeStatus = 'offline';
	let unsubSocket: (() => void) | null = null;

	function recompute() {
		if (!browserOnline) {
			status = 'offline';
			return;
		}
		switch (socketState) {
			case 'connected':
				status = 'online';
				break;
			case 'connecting':
				status = 'connecting';
				break;
			case 'reconnecting':
				status = 'reconnecting';
				break;
			case 'failed':
				status = 'unreachable';
				break;
			case 'disconnected':
			default:
				// Browser online but no live socket — treat as server-unreachable, not "Online"
				status = 'unreachable';
				break;
		}
	}

	function onBrowserOnline() {
		browserOnline = true;
		recompute();
	}

	function onBrowserOffline() {
		browserOnline = false;
		recompute();
	}

	function onWorkOffline() {
		browserOnline = false;
		status = 'offline';
	}

	const labels: Record<BadgeStatus, string> = {
		online: 'Online',
		offline: 'Offline',
		connecting: 'Connecting…',
		reconnecting: 'Reconnecting…',
		unreachable: 'Server unreachable'
	};

	onMount(() => {
		if (!browser) return;
		browserOnline = navigator.onLine;
		unsubSocket = connectionState.subscribe((s) => {
			socketState = s;
			recompute();
		});
		window.addEventListener('online', onBrowserOnline);
		window.addEventListener('offline', onBrowserOffline);
		// Finding 32: named handler so destroy can remove it
		window.addEventListener('wabi:work-offline', onWorkOffline);
		recompute();
	});

	onDestroy(() => {
		if (!browser) return;
		unsubSocket?.();
		window.removeEventListener('online', onBrowserOnline);
		window.removeEventListener('offline', onBrowserOffline);
		window.removeEventListener('wabi:work-offline', onWorkOffline);
	});
</script>

<div
	class="badge"
	class:badge--online={status === 'online'}
	class:badge--offline={status === 'offline'}
	class:badge--connecting={status === 'connecting' || status === 'reconnecting'}
	class:badge--unreachable={status === 'unreachable'}
	aria-live="polite"
	role="status"
>
	<span class="badge__dot" aria-hidden="true"></span>
	<span class="badge__label">{labels[status]}</span>
</div>

<style>
	.badge {
		position: fixed;
		bottom: 10px;
		right: 10px;
		z-index: 100;
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 3px 9px;
		border-radius: 9999px;
		font-size: 10px;
		font-weight: 500;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
		letter-spacing: 0.3px;
		pointer-events: none;
		user-select: none;
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
		transition: opacity 200ms ease;
	}

	.badge--online {
		background: rgba(34, 197, 94, 0.08);
		border: 1px solid rgba(34, 197, 94, 0.12);
		color: rgba(34, 197, 94, 0.5);
		opacity: 0.35;
	}

	.badge--offline {
		background: rgba(250, 204, 21, 0.1);
		border: 1px solid rgba(250, 204, 21, 0.2);
		color: rgba(250, 204, 21, 0.8);
		opacity: 0.7;
	}

	.badge--connecting {
		background: rgba(96, 165, 250, 0.1);
		border: 1px solid rgba(96, 165, 250, 0.22);
		color: rgba(147, 197, 253, 0.9);
		opacity: 0.75;
	}

	.badge--unreachable {
		background: rgba(248, 113, 113, 0.1);
		border: 1px solid rgba(248, 113, 113, 0.22);
		color: rgba(252, 165, 165, 0.9);
		opacity: 0.8;
	}

	.badge__dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.badge--online .badge__dot {
		background: rgba(34, 197, 94, 0.6);
		box-shadow: 0 0 3px rgba(34, 197, 94, 0.3);
	}

	.badge--offline .badge__dot {
		background: rgba(250, 204, 21, 0.9);
		box-shadow: 0 0 4px rgba(250, 204, 21, 0.4);
	}

	.badge--connecting .badge__dot {
		background: rgba(96, 165, 250, 0.95);
		box-shadow: 0 0 4px rgba(96, 165, 250, 0.45);
		animation: pulse 1.2s ease-in-out infinite;
	}

	.badge--unreachable .badge__dot {
		background: rgba(248, 113, 113, 0.95);
		box-shadow: 0 0 4px rgba(248, 113, 113, 0.4);
	}

	.badge__label {
		line-height: 1;
	}

	@keyframes pulse {
		0%,
		100% {
			opacity: 0.45;
		}
		50% {
			opacity: 1;
		}
	}
</style>
