<!--
	"Scan to join" (design contract §7.13): a BaseModal sm with the server's join link as a QR code,
	an optional room name and the link itself in mono. The code is drawn dark on a light square in
	every theme so phone cameras can read it.
-->
<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
	import QRCode from 'qrcode';
	import { _ } from '$lib/i18n';
	import BaseModal from '../BaseModal.svelte';

	export let serverUrl: string;
	export let customRoom = '';

	const dispatch = createEventDispatcher<{ close: void }>();
	let qrCanvas: HTMLCanvasElement;
	let regenerateTimer: ReturnType<typeof setTimeout> | null = null;

	$: joinUrl = customRoom.trim() ? `${serverUrl}?room=${encodeURIComponent(customRoom.trim())}` : serverUrl;

	function generateQR() {
		if (!qrCanvas) return;
		// A QR code needs a dark-on-light square to scan reliably; it is a functional image, not chrome.
		void QRCode.toCanvas(qrCanvas, joinUrl, {
			width: 240,
			margin: 2,
			color: { dark: '#000000', light: '#ffffff' }
		});
	}

	function scheduleGenerate() {
		if (regenerateTimer) clearTimeout(regenerateTimer);
		regenerateTimer = setTimeout(generateQR, 300);
	}

	onMount(() => {
		const timer = setTimeout(generateQR, 50);
		return () => {
			clearTimeout(timer);
			if (regenerateTimer) clearTimeout(regenerateTimer);
		};
	});

	const close = () => dispatch('close');
</script>

<BaseModal isOpen={true} onClose={close} size="sm" padded title={$_('login.qr.title')} ariaLabel={$_('login.qr.dialog_aria')} panelClass="login-qr">
	<div class="qr-body">
		<canvas class="qr-code" bind:this={qrCanvas} aria-hidden="true"></canvas>
		<p class="qr-url">{joinUrl}</p>
		<label class="w-label qr-label" for="login-qr-room">Room name <span class="qr-optional">optional</span></label>
		<input id="login-qr-room" class="w-field" type="text" bind:value={customRoom} on:input={scheduleGenerate} autocomplete="off" />
	</div>
	<div slot="footer" class="w-dialog__foot">
		<button type="button" class="w-btn w-btn--quiet" on:click={generateQR}>{$_('common.regenerate')}</button>
		<button type="button" class="w-btn w-btn--primary" on:click={close}>{$_('common.close')}</button>
	</div>
</BaseModal>

<style>
	.qr-body {
		display: grid;
		justify-items: center;
		gap: 12px;
	}
	.qr-code {
		display: block;
		width: 240px;
		max-width: 100%;
		height: auto;
		border: var(--w-bw) solid var(--w-line);
		border-radius: var(--radius-md);
	}
	.qr-url {
		max-width: 100%;
		margin: 0;
		color: var(--w-faint);
		font: var(--w-t-mono);
		overflow-wrap: anywhere;
		text-align: center;
	}
	.qr-label {
		justify-self: stretch;
		margin: 8px 0 -6px;
	}
	.qr-optional {
		color: var(--w-faint);
		font: var(--w-t-small);
	}
</style>
