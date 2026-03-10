<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
	import { get } from 'svelte/store';
	import QRCode from 'qrcode';
	import { register, login, saveUserSettings, upgradeToRegistered, getLaunchPageConfig, type LaunchPageConfig } from '$lib/api';
	import { clearAuthSession, setAuthToken } from '$lib/authSession';
	import { initE2E } from '$lib/e2eManager';
	import { retryDecryptLoadedDmMessages } from '$lib/socket';
	import { setStoredHomeExperienceMode, type HomeExperienceMode } from '$lib/homeExperience';
	import { _, availableLocales, currentLocale, setAppLocale } from '$lib/i18n';
	import { getConfiguredServerUrl, getServerUrl, resolveServerUrl, setConfiguredServerUrl } from '$lib/serverUrl';

	const dispatch = createEventDispatcher<{
		login: { username: string; token?: string; authMethod: 'guest' | 'registered'; homeExperience?: HomeExperienceMode };
	}>();

	let tab: 'guest' | 'login' | 'register' = 'guest';
	let username = '';
	let handle = '';
	let password = '';
	let passwordConfirm = '';
	let error = '';
	let loading = false;
	let connectionError = '';
	let showConnectionPrompt = true;
	let serverDomain = '';
	let rememberServer = true;

	let qrCanvas: HTMLCanvasElement;
	let showQR = false;
	let showHomeExperiencePrompt = false;
	let pendingRegisteredLogin: { username: string; token: string } | null = null;
	let customRoom = '';
	let selectedLocale = 'en';
	let launchPageConfig: LaunchPageConfig | null = null;
	$: selectedLocale = $currentLocale || 'en';
	$: activeLaunchPageConfig = launchPageConfig?.enabled ? launchPageConfig : null;
	$: launchContainerStyle = activeLaunchPageConfig
		? `--launch-bg-top: ${activeLaunchPageConfig.palette.backgroundTop}; --launch-bg-bottom: ${activeLaunchPageConfig.palette.backgroundBottom}; --launch-accent: ${activeLaunchPageConfig.palette.accent}; --launch-text: ${activeLaunchPageConfig.palette.text};`
		: '';
	$: launchCardStyle = activeLaunchPageConfig
		? `--launch-card-bg: ${activeLaunchPageConfig.palette.cardBackground};`
		: '';

	const t = (key: string): string => get(_)(key) as string;

	// Effective server target for QR / diagnostics.
	$: serverUrl = typeof window !== 'undefined'
		? getServerUrl()
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

	function applyServerDomain() {
		connectionError = '';
		try {
			const normalized = setConfiguredServerUrl(serverDomain, rememberServer);
			serverDomain = normalized;
			showConnectionPrompt = false;
		} catch (err) {
			connectionError = err instanceof Error ? err.message : 'Invalid domain';
		}
	}

	// Guest login
	function handleGuestLogin() {
		if (username.trim()) {
			clearAuthSession();
			dispatch('login', { username: username.trim(), authMethod: 'guest' });
		}
	}

	// Register
	async function handleRegister() {
		error = '';

		// Validation
		if (username.length < 2) {
			error = t('login.errors.username_min');
			return;
		}
		const cleanHandle = handle.replace(/^@/, '').toLowerCase();
		if (!/^[a-z][a-z0-9_]{1,31}$/.test(cleanHandle)) {
			error = t('login.errors.handle_invalid');
			return;
		}
		if (password.length < 8) {
			error = t('login.errors.password_min');
			return;
		}
		if (password !== passwordConfirm) {
			error = t('login.errors.password_mismatch');
			return;
		}

		loading = true;

		try {
			const result = await register(username, password, cleanHandle);
			setAuthToken(result.token);
			if (result.user.id) {
				localStorage.setItem('dbUserId', String(result.user.id));
				await initE2E(result.user.id, result.token, true);
				await retryDecryptLoadedDmMessages();
			}
			pendingRegisteredLogin = { username: result.user.username, token: result.token };
			showHomeExperiencePrompt = true;
		} catch (err) {
			error = err instanceof Error ? err.message : t('login.errors.registration_failed');
		} finally {
			loading = false;
		}
	}

	async function completeRegistrationHomeExperience(mode: HomeExperienceMode) {
		if (!pendingRegisteredLogin) return;
		loading = true;
		error = '';
		try {
			await saveUserSettings(pendingRegisteredLogin.token, { home_experience: mode });
			setStoredHomeExperienceMode(mode);
			dispatch('login', {
				username: pendingRegisteredLogin.username,
				token: pendingRegisteredLogin.token,
				authMethod: 'registered',
				homeExperience: mode
			});
			pendingRegisteredLogin = null;
			showHomeExperiencePrompt = false;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to save home experience setting.';
		} finally {
			loading = false;
		}
	}

	// Login
	async function handleLogin() {
		error = '';

		if (!username || !password) {
			error = t('login.errors.username_password_required');
			return;
		}

		loading = true;

		try {
			const result = await login(username, password);
			setAuthToken(result.token);
			if (result.user.id) {
				localStorage.setItem('dbUserId', String(result.user.id));
				await initE2E(result.user.id, result.token, false);
				await retryDecryptLoadedDmMessages();
			}
			dispatch('login', { username: result.user.username, token: result.token, authMethod: 'registered' });
		} catch (err) {
			error = err instanceof Error ? err.message : t('login.errors.login_failed');
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
		void getLaunchPageConfig()
			.then((config) => {
				launchPageConfig = config;
			})
			.catch((error) => {
				console.warn('[Login] Failed to load launch page config:', error);
			});

		const urlParams = new URLSearchParams(window.location.search);
		const room = urlParams.get('room');
		if (room) customRoom = room;

		const configured = getConfiguredServerUrl();
		if (configured) {
			serverDomain = configured;
			showConnectionPrompt = false;
			return;
		}

		serverDomain = resolveServerUrl().url;
		showConnectionPrompt = true;
	});
</script>

<div class="login-container" style={launchContainerStyle}>
	<div class="login-shell" class:has-launch={!!activeLaunchPageConfig}>
		{#if activeLaunchPageConfig}
			<section class="launch-panel">
				{#if activeLaunchPageConfig.heroImageUrl}
					<img class="launch-hero-image" src={activeLaunchPageConfig.heroImageUrl} alt={activeLaunchPageConfig.brandName} />
				{/if}
				<div class="launch-brand">{activeLaunchPageConfig.brandName}</div>
				<h1>{activeLaunchPageConfig.heroTitle || activeLaunchPageConfig.headline}</h1>
				{#if activeLaunchPageConfig.heroBody || activeLaunchPageConfig.subheadline}
					<p>{activeLaunchPageConfig.heroBody || activeLaunchPageConfig.subheadline}</p>
				{/if}
				{#if activeLaunchPageConfig.heroPrimaryCtaLabel && activeLaunchPageConfig.heroPrimaryCtaUrl}
					<a class="launch-primary-cta" href={activeLaunchPageConfig.heroPrimaryCtaUrl} target="_blank" rel="noreferrer">
						{activeLaunchPageConfig.heroPrimaryCtaLabel}
					</a>
				{/if}
				{#if activeLaunchPageConfig.highlights.length > 0}
					<ul class="launch-highlights">
						{#each activeLaunchPageConfig.highlights as highlight (highlight.title)}
							<li>
								<strong>{highlight.title}</strong>
								<span>{highlight.description}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}

		<div class="login-box" style={launchCardStyle}>
			<img src={activeLaunchPageConfig?.logoUrl || '/wabi-logo.webp'} alt={activeLaunchPageConfig?.brandName || 'Wabi'} class="logo" />
			{#if activeLaunchPageConfig}
				<h2 class="launch-headline">{activeLaunchPageConfig.headline}</h2>
				<p class="launch-subheadline">{activeLaunchPageConfig.subheadline}</p>
			{/if}

			{#if showConnectionPrompt}
				<div class="connection-box">
					<h3>Connect to Wabi Domain</h3>
					<input
						type="text"
						bind:value={serverDomain}
						placeholder="wabi.chat or https://staging.wabi.chat"
						use:focusOnMount
						disabled={loading}
					/>
					<label class="remember-row">
						<input type="checkbox" bind:checked={rememberServer} />
						<span>Remember this domain on this device</span>
					</label>
					{#if connectionError}
						<div class="error-message">{connectionError}</div>
					{/if}
					<button type="button" class="join-btn" on:click={applyServerDomain}>Continue</button>
				</div>
			{:else}
				<div class="server-target">
					<span>Server: {serverUrl}</span>
					<button type="button" class="server-change" on:click={() => (showConnectionPrompt = true)}>Change</button>
				</div>

			{#if showHomeExperiencePrompt}
				<div class="experience-prompt">
					<h3>Choose your default home view</h3>
					<p>Pick how Wabi should open by default. You can change this any time in Settings.</p>
					<div class="experience-actions">
						<button
							type="button"
							class="join-btn"
							disabled={loading}
							on:click={() => completeRegistrationHomeExperience('conversations')}
						>
							Conversation-first
						</button>
						<button
							type="button"
							class="join-btn secondary-btn"
							disabled={loading}
							on:click={() => completeRegistrationHomeExperience('community')}
						>
							Community-first
						</button>
					</div>
				</div>
			{:else}
			<!-- Tab Navigation -->
			<div class="tabs">
				<button
					class="tab-btn"
					class:active={tab === 'guest'}
					on:click={() => switchTab('guest')}
				>
					{$_('login.tabs.guest')}
				</button>
				<button
					class="tab-btn"
					class:active={tab === 'login'}
					on:click={() => switchTab('login')}
				>
					{$_('login.tabs.login')}
				</button>
				<button
					class="tab-btn"
					class:active={tab === 'register'}
					on:click={() => switchTab('register')}
				>
					{$_('login.tabs.register')}
				</button>
			</div>

			<div class="locale-row">
				<label for="locale-picker">{$_('login.language.label')}</label>
				<select
					id="locale-picker"
					bind:value={selectedLocale}
					on:change={(event) => setAppLocale((event.currentTarget as HTMLSelectElement).value)}
				>
					{#each availableLocales as localeOption}
						<option value={localeOption.code}>{localeOption.label}</option>
					{/each}
				</select>
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
						placeholder={$_('login.guest.name_placeholder')}
						maxlength="20"
						required
						use:focusOnMount
						disabled={loading}
					/>
					<button type="submit" class="join-btn" disabled={loading}>
						{loading ? $_('login.guest.joining') : $_('login.guest.join_button')}
					</button>
				</form>

				<button type="button" on:click={generateQR} class="qr-btn" disabled={loading}>
					{$_('login.guest.join_qr_button')}
				</button>

				<a href="/business" class="hub-btn">{$_('login.guest.business_hub')}</a>
			{/if}

			<!-- LOGIN TAB -->
			{#if tab === 'login'}
				<form on:submit|preventDefault={handleLogin}>
					<input
						type="text"
						bind:value={username}
						placeholder={$_('login.auth.username_or_handle_placeholder')}
						required
						use:focusOnMount
						disabled={loading}
					/>
					<input
						type="password"
						bind:value={password}
						placeholder={$_('login.auth.password_placeholder')}
						required
						disabled={loading}
					/>
					<button type="submit" class="join-btn" disabled={loading}>
						{loading ? $_('login.auth.logging_in') : $_('login.auth.login_button')}
					</button>
				</form>
			{/if}

			<!-- REGISTER TAB -->
			{#if tab === 'register'}
				<form on:submit|preventDefault={handleRegister}>
					<input
						type="text"
						bind:value={username}
						placeholder={$_('login.auth.display_name_placeholder')}
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
							placeholder={$_('login.auth.handle_placeholder')}
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
						placeholder={$_('login.auth.password_rules_placeholder')}
						minlength="8"
						required
						disabled={loading}
					/>
					<input
						type="password"
						bind:value={passwordConfirm}
						placeholder={$_('login.auth.confirm_password_placeholder')}
						minlength="8"
						required
						disabled={loading}
					/>
					<button type="submit" class="join-btn" disabled={loading}>
						{loading ? $_('login.auth.creating_account') : $_('login.auth.create_account_button')}
					</button>
				</form>
			{/if}
			{/if}
			{/if}
			{#if activeLaunchPageConfig?.footerNote}
				<p class="launch-footer-note">{activeLaunchPageConfig.footerNote}</p>
			{/if}
		</div>
	</div>

	<!-- QR MODAL -->
	{#if showQR}
		<div
			class="qr-overlay"
			role="button"
			tabindex="0"
			aria-label={$_('login.qr.close_modal_aria')}
			on:click={() => (showQR = false)}
			on:keydown={(e) => (e.key === 'Escape' || e.key === ' ') && (showQR = false)}
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
					<button on:click={() => (showQR = false)}>{$_('common.close')}</button>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.login-container {
		--launch-bg-top: var(--dark-bg-primary);
		--launch-bg-bottom: var(--dark-bg-secondary);
		--launch-accent: var(--accent);
		--launch-text: var(--text-primary);
		--launch-card-bg: rgba(20, 20, 30, 0.25);
		min-height: 100dvh;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow-y: auto;
		background: linear-gradient(135deg, var(--launch-bg-top) 0%, var(--launch-bg-bottom) 100%);
		padding: 1rem;
	}

	.login-shell {
		width: min(1100px, 100%);
		display: block;
	}

	.login-shell.has-launch {
		display: grid;
		grid-template-columns: minmax(320px, 1fr) minmax(360px, 420px);
		gap: 1.25rem;
		align-items: stretch;
	}

	.launch-panel {
		background: linear-gradient(180deg, rgba(5, 8, 18, 0.7) 0%, rgba(5, 8, 18, 0.4) 100%);
		backdrop-filter: blur(14px);
		-webkit-backdrop-filter: blur(14px);
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 16px;
		padding: 2rem;
		color: var(--launch-text);
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}

	.launch-hero-image {
		width: 100%;
		max-height: 220px;
		object-fit: cover;
		border-radius: 12px;
		border: 1px solid rgba(255, 255, 255, 0.15);
	}

	.launch-brand {
		font-size: 0.82rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.78);
		font-weight: 700;
	}

	.launch-panel h1 {
		margin: 0;
		font-size: clamp(1.5rem, 2.3vw, 2.2rem);
		line-height: 1.2;
	}

	.launch-panel p {
		margin: 0;
		color: rgba(255, 255, 255, 0.84);
		line-height: 1.55;
	}

	.launch-primary-cta {
		align-self: flex-start;
		text-decoration: none;
		color: #ffffff;
		background: var(--launch-accent);
		padding: 0.7rem 1rem;
		border-radius: 10px;
		font-weight: 700;
		transition: transform 0.2s ease;
	}

	.launch-primary-cta:hover {
		transform: translateY(-1px);
	}

	.launch-highlights {
		list-style: none;
		padding: 0;
		margin: 0.25rem 0 0 0;
		display: grid;
		gap: 0.65rem;
	}

	.launch-highlights li {
		display: grid;
		gap: 0.2rem;
		padding-left: 0.9rem;
		border-left: 2px solid rgba(255, 255, 255, 0.26);
	}

	.launch-highlights strong {
		font-size: 0.94rem;
	}

	.launch-highlights span {
		font-size: 0.84rem;
		color: rgba(255, 255, 255, 0.75);
	}

	.login-box {
		background: var(--launch-card-bg);
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

	.launch-headline {
		margin: 0 0 0.35rem 0;
		color: var(--launch-text);
		font-size: 1.12rem;
		line-height: 1.3;
	}

	.launch-subheadline {
		margin: 0 0 1rem 0;
		color: var(--text-secondary);
		font-size: 0.92rem;
	}

	.launch-footer-note {
		margin: 0.6rem 0 0;
		font-size: 0.8rem;
		color: var(--text-secondary);
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
		color: var(--launch-accent, var(--accent));
	}

	.tab-btn.active {
		color: var(--launch-accent, var(--accent));
		border-bottom-color: var(--launch-accent, var(--accent));
	}

	.locale-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 1rem;
	}

	.locale-row label {
		color: var(--text-secondary);
		font-size: 0.85rem;
	}

	.locale-row select {
		background: var(--bg-tertiary);
		color: var(--text-primary);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.4rem 0.6rem;
		font-size: 0.85rem;
	}

	.connection-box {
		text-align: left;
	}

	.connection-box h3 {
		margin: 0 0 0.75rem 0;
		color: var(--text-primary);
		font-size: 1rem;
	}

	.remember-row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin: 0.1rem 0 1rem 0;
		color: var(--text-secondary);
		font-size: 0.9rem;
	}

	.remember-row input[type="checkbox"] {
		width: 16px;
		height: 16px;
		margin: 0;
		padding: 0;
	}

	.server-target {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-bottom: 0.75rem;
		color: var(--text-secondary);
		font-size: 0.8rem;
	}

	.server-target span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.server-change {
		border: 1px solid var(--border);
		background: transparent;
		color: var(--text-secondary);
		border-radius: 8px;
		padding: 0.25rem 0.6rem;
		cursor: pointer;
		font-size: 0.75rem;
	}

	input {
		width: 100%;
		padding: 1rem;
		font-size: 1.1rem;
		border-radius: 12px;
		border: none;
		background: var(--bg-tertiary);
		color: var(--text-primary);
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
		background: var(--launch-accent, var(--accent));
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

	.secondary-btn {
		background: transparent;
		color: var(--text-primary);
		border: 1px solid var(--border);
	}

	.experience-prompt {
		text-align: left;
		margin-bottom: 0.75rem;
	}

	.experience-prompt h3 {
		margin: 0 0 0.5rem 0;
		font-size: 1.1rem;
		color: var(--text-primary);
	}

	.experience-prompt p {
		margin: 0 0 1rem 0;
		font-size: 0.9rem;
		color: var(--text-secondary);
	}

	.experience-actions {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.experience-actions .join-btn {
		margin-bottom: 0;
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
		border-color: var(--launch-accent, var(--accent));
		color: var(--launch-accent, var(--accent));
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
		border-color: var(--launch-accent, var(--accent));
		color: var(--launch-accent, var(--accent));
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
		color: var(--launch-accent, var(--accent));
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
		color: var(--text-primary);
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
		background: var(--launch-accent, var(--accent));
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
		.login-shell.has-launch {
			grid-template-columns: 1fr;
		}

		.launch-panel {
			padding: 1.2rem;
			gap: 0.65rem;
		}

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
