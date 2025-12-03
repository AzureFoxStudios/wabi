<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
	import QRCode from 'qrcode';

	const dispatch = createEventDispatcher<{ login: string }>();

	let username = '';
	let qrCanvas: HTMLCanvasElement;
	let showQR = false;
	let customRoom = '';

	// Auto-detect current origin (works on localhost, LAN, VPS, phone hotspot, etc.)
	$: serverUrl = typeof window !== 'undefined'
		? `${window.location.origin}${import.meta.env.BASE_URL || ''}`
		: '';

	function handleSubmit() {
		if (username.trim()) {
			localStorage.setItem('wabi-username', username.trim());
			dispatch('login', username.trim());
		}
	}

	function generateQR() {
		showQR = true;
		setTimeout(() => {
			const finalUrl = customRoom.trim()
				? `${serverUrl}?room=${encodeURIComponent(customRoom.trim())}`
				: serverUrl;

			QRCode.toCanvas(qrCanvas, finalUrl, {
				width: 300,
				margin: 2,
				color: { dark: '#ffffff', light: '#00000000' } // transparent bg
			});
		}, 50);
	}

	// Optional: auto-focus input on mobile
	onMount(() => {
		const urlParams = new URLSearchParams(window.location.search);
		const room = urlParams.get('room');
		if (room) customRoom = room;
	});
</script>

<div class="login-container">
	<div class="login-box">
		<img src="/wabi-logo.png" alt="Wabi" class="logo" />

		<form on:submit|preventDefault={handleSubmit}>
			<input
				type="text"
				bind:value={username}
				placeholder="Enter your name"
				maxlength="20"
				required
				autofocus
			/>
			<button type="submit" class="join-btn">Join the Fridge</button>
		</form>

		<!-- QR CODE BUTTON -->
		<button type="button" on:click={generateQR} class="qr-btn">
			Scan to Join This House
		</button>
	</div>

<!-- QR MODAL – fully a11y compliant, zero warnings -->
{#if showQR}
	<div
		class="qr-overlay"
		role="button"
		tabindex="0"
		aria-label="Close QR code modal"
		on:click={() => showQR = false}
		on:keydown={(e) => (e.key === 'Escape' || e.key === ' ') && (showQR = false)}
	>
		<div
			class="qr-modal"
			role="dialog"
			aria-modal="true"
			aria-label="QR code to join this Wabi house"
			on:click|stopPropagation
			on:keydown|stopPropagation
		>
			<h2>Join This Wabi House</h2>
			<canvas bind:this={qrCanvas}></canvas>

			<p class="url">{serverUrl}</p>

			<div class="room-input">
				<input
					type="text"
					bind:value={customRoom}
					placeholder="Optional room name (e.g. kitchen)"
					on:input={() => setTimeout(generateQR, 300)}
				/>
			</div>

			<div class="qr-actions">
				<button on:click={generateQR}>Regenerate</button>
				<button on:click={() => showQR = false}>Close</button>
			</div>
		</div>
	</div>
{/if}
</div>

<style>
	.login-container {
		min-height: 100dvh;
		display: flex;
		align-items: center;
		justify-content: center;
		background: linear-gradient(135deg, var(--dark-bg-primary) 0%, var(--dark-bg-secondary) 100%);
		padding: 1rem;
	}

	.login-box {
		background: var(--bg-secondary);
		padding: 2.5rem;
		border-radius: 16px;
		width: 100%;
		max-width: 420px;
		text-align: center;
		box-shadow: 0 20px 40px rgba(0,0,0,0.4);
	}

	.logo {
		height: 280px;
		margin-bottom: 1.5rem;
		filter: invert(1) drop-shadow(0 4px 8px rgba(0,0,0,0.3));
	}

	input {
		width: 100%;
		padding: 1rem;
		font-size: 1.1rem;
		border-radius: 12px;
		border: none;
		background: var(--bg-tertiary);
		color: white;
		margin-bottom: 1rem;
	}

	.join-btn {
		width: 100%;
		padding: 1rem;
		font-size: 1.2rem;
		font-weight: 700;
		background: var(--accent);
		color: white;
		border: none;
		border-radius: 12px;
		cursor: pointer;
		margin-bottom: 1.5rem;
	}

	.qr-btn {
		background: transparent;
		color: var(--text-secondary);
		border: 2px dashed var(--border);
		padding: 0.9rem 1.5rem;
		border-radius: 12px;
		font-size: 0.95rem;
		cursor: pointer;
		transition: all 0.3s;
		width: 100%;
	}
	.qr-btn:hover {
		border-color: var(--accent);
		color: var(--accent);
		background: rgba(88, 101, 242, 0.1);
	}

	/* QR Modal */
	.qr-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0,0,0,0.92);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 9999;
		backdrop-filter: blur(8px);
	}

	.qr-modal {
		background: var(--bg-secondary);
		padding: 2rem;
		border-radius: 20px;
		text-align: center;
		max-width: 90%;
		box-shadow: 0 30px 60px rgba(0,0,0,0.6);
	}

	.qr-modal h2 {
		margin: 0 0 1.5rem 0;
		color: var(--accent);
		font-size: 1.5rem;
	}

	.url {
		font-family: 'Consolas', monospace;
		font-size: 0.85rem;
		word-break: break-all;
		margin: 1rem 0;
		color: var(--text-secondary);
		background: var(--bg-tertiary);
		padding: 0.5rem;
		border-radius: 8px;
	}

	.room-input input {
		width: 100%;
		padding: 0.9rem;
		border-radius: 12px;
		border: none;
		background: var(--bg-tertiary);
		color: white;
		margin: 1rem 0;
		font-size: 1rem;
	}

	.qr-actions button {
		padding: 0.75rem 1.5rem;
		margin: 0.5rem;
		border: none;
		border-radius: 12px;
		cursor: pointer;
		font-weight: 600;
	}
	.qr-actions button:first-child {
		background: var(--accent);
		color: white;
	}
	.qr-actions button:last-child {
		background: var(--bg-tertiary);
		color: var(--text-primary);
	}
</style>