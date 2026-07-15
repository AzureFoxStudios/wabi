<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$app/environment';

	let status: 'online' | 'offline' | 'reconnecting' = 'online';

	function updateOnline() {
		status = navigator.onLine ? 'online' : 'offline';
	}

	onMount(() => {
		if (!browser) return;
		updateOnline();
		window.addEventListener('online', updateOnline);
		window.addEventListener('offline', updateOnline);

		window.addEventListener('wabi:work-offline', () => {
			status = 'offline';
		});
	});

	onDestroy(() => {
		if (!browser) return;
		window.removeEventListener('online', updateOnline);
		window.removeEventListener('offline', updateOnline);
	});
</script>

<div class="badge" class:badge--offline={status === 'offline'} class:badge--online={status === 'online'} aria-live="polite">
	<span class="badge__dot" />
	<span class="badge__label">{status === 'online' ? 'Online' : 'Offline'}</span>
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

	.badge__label {
		line-height: 1;
	}
</style>
