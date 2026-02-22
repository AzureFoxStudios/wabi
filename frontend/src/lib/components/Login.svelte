<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
	import QRCode from 'qrcode';
	import { register, login, upgradeToRegistered } from '$lib/api';
	import { initE2E } from '$lib/e2eManager';

	const dispatch = createEventDispatcher<{
		login: { username: string; token?: string; authMethod: 'guest' | 'registered' };
	}>();

	let tab: 'guest' | 'login' | 'register' = 'guest';
	let username = '';
	let handle = '';
	let password = '';
	let passwordConfirm = '';
	let error = '';
	let loading = false;

	let qrCanvas: HTMLCanvasElement;
	let showQR = false;
	let customRoom = '';

	// Auto-detect current origin
	$: serverUrl = typeof window !== 'undefined'
		? `${window.location.origin}${import.meta.env.BASE_URL || ''}`
		: '';

	// Tab switching helpers
	// Auto-suggest handle from username
	$: if (tab === 'register' && !handleManuallyEdited) {
		handle = username.replace(/\s+/g, '').toLowerCase();
	}
	let handleManuallyEdited = false;

	function switchTab(newTab: 'guest' | 'login' | 'register') {
		tab = newTab;
		error = '';
		username = '';
		handle = '';
		handleManuallyEdited = false;
		password = '';
		passwordConfirm = '';
	}

	// Guest login
	function handleGuestLogin() {
		if (username.trim()) {
			localStorage.removeItem('authToken');
			dispatch('login', { username: username.trim(), authMethod: 'guest' });
		}
	}

	// Register
	async function handleRegister() {
		error = '';

		// Validation
		if (username.length < 2) {
			error = 'Username must be at least 2 characters';
			return;
		}
		const cleanHandle = handle.replace(/^@/, '').toLowerCase();
		if (!/^[a-z][a-z0-9_]{1,31}$/.test(cleanHandle)) {
			error = 'Handle must start with a letter, be 2-32 chars, lowercase letters/numbers/underscores only';
			return;
		}
		if (password.length < 8) {
			error = 'Password must be at least 8 characters';
			return;
		}
		if (password !== passwordConfirm) {
			error = 'Passwords do not match';
			return;
		}

		loading = true;

		try {
			const result = await register(username, password, cleanHandle);
			localStorage.setItem('authToken', result.token);
			if (result.user.id) {
				localStorage.setItem('dbUserId', String(result.user.id));
				initE2E(result.user.id, result.token, true);
			}
			dispatch('login', { username: result.user.username, token: result.token, authMethod: 'registered' });
		} catch (err) {
			error = err instanceof Error ? err.message : 'Registration failed';
		} finally {
			loading = false;
		}
	}

	// Login
	async function handleLogin() {
		error = '';

		if (!username || !password) {
			error = 'Username and password required';
			return;
		}

		loading = true;

		try {
			const result = await login(username, password);
			localStorage.setItem('authToken', result.token);
			if (result.user.id) {
				localStorage.setItem('dbUserId', String(result.user.id));
				initE2E(result.user.id, result.token, false);
			}
			dispatch('login', { username: result.user.username, token: result.token, authMethod: 'registered' });
		} catch (err) {
			error = err instanceof Error ? err.message : 'Login failed';
		} finally {
			loading = false;
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
				color: { dark: '#ffffff', light: '#00000000' }
			});
		}, 50);
	}

	function focusOnMount(node: HTMLInputElement) { node.focus(); return {}; }

	onMount(() => {
		const urlParams = new URLSearchParams(window.location.search);
		const room = urlParams.get('room');
		if (room) customRoom = room;
	});
</script>

<div class="login-container">
	<div class="login-box">
		<img src="/wabi-logo.webp" alt="Wabi" class="logo" />

		<!-- Tab Navigation -->
		<div class="tabs">
			<button
				class="tab-btn"
				class:active={tab === 'guest'}
				on:click={() => switchTab('guest')}
			>
				Guest
			</button>
			<button
				class="tab-btn"
				class:active={tab === 'login'}
				on:click={() => switchTab('login')}
			>
				Login
			</button>
			<button
				class="tab-btn"
				class:active={tab === 'register'}
				on:click={() => switchTab('register')}
			>
				Register
			</button>
		</div>

		<!-- Error Message -->
		{#if error}
			<div class="error-message">{error}</div>
		{/if}

		<!-- GUEST TAB -->
		{#if tab === 'guest'}
			<form on:submit|preventDefault={handleGuestLogin}>
				<input
					type="text"
					bind:value={username}
					placeholder="Enter your name"
					maxlength="20"
					required
					use:focusOnMount
					disabled={loading}
				/>
				<button type="submit" class="join-btn" disabled={loading}>
					{loading ? 'Joining...' : 'Join as Guest'}
				</button>
			</form>

			<button type="button" on:click={generateQR} class="qr-btn" disabled={loading}>
				Join via QR Code
			</button>

			<a href="/business" class="hub-btn">Business Hub</a>
		{/if}

		<!-- LOGIN TAB -->
		{#if tab === 'login'}
			<form on:submit|preventDefault={handleLogin}>
				<input
					type="text"
					bind:value={username}
					placeholder="Username or @handle"
					required
					use:focusOnMount
					disabled={loading}
				/>
				<input
					type="password"
					bind:value={password}
					placeholder="Password"
					required
					disabled={loading}
				/>
				<button type="submit" class="join-btn" disabled={loading}>
					{loading ? 'Logging in...' : 'Login'}
				</button>
			</form>
		{/if}

		<!-- REGISTER TAB -->
		{#if tab === 'register'}
			<form on:submit|preventDefault={handleRegister}>
				<input
					type="text"
					bind:value={username}
					placeholder="Choose display name"
					minlength="2"
					maxlength="32"
					required
					use:focusOnMount
					disabled={loading}
				/>
				<div class="handle-input-wrapper">
					<span class="handle-prefix">@</span>
					<input
						type="text"
						bind:value={handle}
						on:input={() => { handleManuallyEdited = true; }}
						placeholder="yourhandle"
						minlength="2"
						maxlength="32"
						required
						disabled={loading}
						class="handle-input"
					/>
				</div>
				<input
					type="password"
					bind:value={password}
					placeholder="Password (8+ characters)"
					minlength="8"
					required
					disabled={loading}
				/>
				<input
					type="password"
					bind:value={passwordConfirm}
					placeholder="Confirm password"
					minlength="8"
					required
					disabled={loading}
				/>
				<button type="submit" class="join-btn" disabled={loading}>
					{loading ? 'Creating account...' : 'Create Account'}
				</button>
			</form>
		{/if}
	</div>

	<!-- QR MODAL -->
	{#if showQR}
		<div
			class="qr-overlay"
			role="button"
			tabindex="0"
			aria-label="Close QR code modal"
			on:click={() => (showQR = false)}
			on:keydown={(e) => (e.key === 'Escape' || e.key === ' ') && (showQR = false)}
		>
			<div
				class="qr-modal"
				role="dialog"
				aria-modal="true"
				aria-label="QR code to join chat"
				tabindex="-1"
				on:click|stopPropagation
				on:keydown|stopPropagation
			>
				<h2>Scan to Join</h2>
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
					<button on:click={() => (showQR = false)}>Close</button>
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
		overflow-y: auto;
		background: linear-gradient(135deg, var(--dark-bg-primary) 0%, var(--dark-bg-secondary) 100%);
		padding: 1rem;
	}

	.login-box {
		background: rgba(20, 20, 30, 0.25);
		backdrop-filter: blur(16px);
		-webkit-backdrop-filter: blur(16px);
		padding: 2.5rem;
		border-radius: 16px;
		width: 100%;
		max-width: 420px;
		text-align: center;
		border: 1px solid rgba(255, 255, 255, 0.1);
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
	}

	.logo {
		height: min(320px, 25vh);
		margin-bottom: 2rem;
		filter: invert(1) drop-shadow(0 4px 12px rgba(0, 0, 0, 0.4));
		animation: logoFadeIn 0.6s ease-out;
	}

	@keyframes logoFadeIn {
		from {
			opacity: 0;
			transform: scale(0.95);
		}
		to {
			opacity: 1;
			transform: scale(1);
		}
	}

	/* Tabs */
	.tabs {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 1.5rem;
		border-bottom: 2px solid var(--border);
	}

	.tab-btn {
		flex: 1;
		padding: 0.75rem 1rem;
		background: transparent;
		color: var(--text-secondary);
		border: none;
		cursor: pointer;
		font-weight: 600;
		border-bottom: 3px solid transparent;
		transition: all 0.3s;
		margin-bottom: -2px;
	}

	.tab-btn:hover {
		color: var(--accent);
	}

	.tab-btn.active {
		color: var(--accent);
		border-bottom-color: var(--accent);
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

	input:disabled {
		opacity: 0.6;
		cursor: not-allowed;
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
		transition: all 0.3s;
	}

	.join-btn:hover:not(:disabled) {
		background: var(--accent-hover, #4752c4);
		transform: translateY(-2px);
		box-shadow: 0 8px 20px rgba(88, 101, 242, 0.3);
	}

	.join-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
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

	.hub-btn {
		background: transparent;
		color: var(--text-secondary);
		border: 2px dashed var(--border);
		padding: 0.9rem 1.5rem;
		border-radius: 12px;
		font-size: 0.95rem;
		cursor: pointer;
		transition: all 0.3s;
		width: 100%;
		display: block;
		margin-top: 1rem;
		text-decoration: none;
	}
	.hub-btn:hover {
		border-color: var(--accent);
		color: var(--accent);
		background: rgba(88, 101, 242, 0.1);
	}

	/* Handle input */
	.handle-input-wrapper {
		display: flex;
		align-items: center;
		background: var(--bg-tertiary);
		border-radius: 12px;
		margin-bottom: 1rem;
		overflow: hidden;
	}

	.handle-prefix {
		padding: 0 0 0 1rem;
		font-size: 1.1rem;
		color: var(--text-secondary);
		font-weight: 600;
		user-select: none;
	}

	.handle-input {
		flex: 1;
		margin-bottom: 0 !important;
		border-radius: 0 !important;
		padding-left: 0.25rem !important;
	}

	/* Error message */
	.error-message {
		background: rgba(239, 68, 68, 0.1);
		border: 1px solid rgb(239, 68, 68);
		color: #fca5a5;
		padding: 0.75rem 1rem;
		border-radius: 8px;
		margin-bottom: 1rem;
		font-size: 0.9rem;
	}

	/* QR Modal */
	.qr-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.92);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 9999;
		backdrop-filter: blur(8px);
	}

	.qr-modal {
		background: rgba(20, 20, 30, 0.3);
		backdrop-filter: blur(16px);
		-webkit-backdrop-filter: blur(16px);
		padding: 2rem;
		border-radius: 20px;
		text-align: center;
		max-width: 90%;
		border: 1px solid rgba(255, 255, 255, 0.1);
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
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

	@media (max-height: 700px) {
		.logo { height: 100px; margin-bottom: 0.5rem; }
		.login-box { padding: 1.25rem; }
		input { padding: 0.75rem; font-size: 1rem; margin-bottom: 0.75rem; }
		.join-btn { padding: 0.75rem; font-size: 1rem; margin-bottom: 1rem; }
		.tabs { margin-bottom: 1rem; }
	}

	/* Mobile styles */
	@media (max-width: 768px) {
		.login-container {
			padding: 1rem;
		}

		.login-box {
			padding: 1.5rem;
			border-radius: 12px;
		}

		.logo {
			height: min(180px, 20vh);
			margin-bottom: 1rem;
		}

		input {
			padding: 0.875rem;
			font-size: 16px;
			border-radius: 10px;
			min-height: 48px;
		}

		.join-btn {
			padding: 0.875rem;
			font-size: 1.1rem;
			min-height: 48px;
		}

		.tabs {
			gap: 0.25rem;
		}

		.tab-btn {
			padding: 0.5rem 0.75rem;
			font-size: 0.85rem;
		}
	}
</style>
