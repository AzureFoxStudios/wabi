<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
	import QRCode from 'qrcode';
	import { _ } from '$lib/i18n';

	export let serverUrl: string;
	export let customRoom = '';

	const dispatch = createEventDispatcher<{ close: void }>();
	let qrCanvas: HTMLCanvasElement;

	function generateQR() {
		if (!qrCanvas) return;
		const finalUrl = customRoom.trim()
			? `${serverUrl}?room=${encodeURIComponent(customRoom.trim())}`
			: serverUrl;
		QRCode.toCanvas(qrCanvas, finalUrl, {
			width: 300,
			margin: 2,
			color: { dark: '#ffffff', light: '#00000000' }
		});
	}

	onMount(() => { setTimeout(generateQR, 50); });
</script>

<div
	class="qr-overlay"
	role="button"
	tabindex="0"
	aria-label={$_('login.qr.close_modal_aria')}
	on:click={() => dispatch('close')}
	on:keydown={(e) => (e.key === 'Escape' || e.key === ' ') && dispatch('close')}
>
	<div
		class="qr-modal"
		role="dialog"
		aria-modal="true"
		aria-label={$_('login.qr.dialog_aria')}
		tabindex="-1"
		on:click|stopPropagation
		on:keydown|stopPropagation
	>
		<h2>{$_('login.qr.title')}</h2>
		<canvas bind:this={qrCanvas}></canvas>
		<p class="url">{serverUrl}</p>
		<div class="room-input">
			<input
				type="text"
				bind:value={customRoom}
				placeholder={$_('login.qr.url_placeholder')}
				on:input={() => setTimeout(generateQR, 300)}
			/>
		</div>
		<div class="qr-actions">
			<button on:click={generateQR}>{$_('common.regenerate')}</button>
			<button on:click={() => dispatch('close')}>{$_('common.close')}</button>
		</div>
	</div>
</div>

<style>
	.qr-overlay {
		position: fixed;
		inset: 0;
		background: var(--surface-modal-overlay, rgba(0, 0, 0, 0.92));
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: var(--z-modal-nested, 1300);
		backdrop-filter: blur(8px);
	}

	.qr-modal {
		background: color-mix(in srgb, var(--surface-modal) 30%, transparent);
		backdrop-filter: blur(16px);
		-webkit-backdrop-filter: blur(16px);
		padding: 2rem;
		border-radius: var(--radius-2xl);
		text-align: center;
		max-width: 90%;
		border: 1px solid var(--surface-hover, rgba(255, 255, 255, 0.1));
		box-shadow: var(--shadow-xl);
	}

	.qr-modal h2 {
		margin: 0 0 1.5rem 0;
		color: var(--launch-accent, var(--accent-secondary-color));
		font-size: var(--font-size-2xl);
	}

	.url {
		font-family: var(--font-mono);
		font-size: var(--font-size-sm);
		word-break: break-all;
		margin: 1rem 0;
		color: var(--text-secondary);
		background: var(--surface-raised);
		padding: 0.5rem;
		border-radius: var(--radius-md);
	}

	.room-input input {
		width: 100%;
		padding: 0.9rem;
		border-radius: var(--radius-lg);
		border: none;
		background: var(--surface-raised);
		color: var(--text-heading);
		margin: 1rem 0;
		font-size: 1rem;
	}

	.qr-actions button {
		padding: 0.75rem 1.5rem;
		margin: 0.5rem;
		border: none;
		border-radius: var(--radius-lg);
		cursor: pointer;
		font-weight: var(--font-weight-semibold);
	}

	.qr-actions button:first-child {
		background: var(--launch-accent, var(--accent-primary-color));
		color: white;
	}

	.qr-actions button:last-child {
		background: var(--surface-raised);
		color: var(--text-heading);
	}
</style>
