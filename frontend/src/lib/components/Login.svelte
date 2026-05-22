	<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { register, login, saveUserSettings, getLaunchPageConfig, getSetupStatus, type LaunchPageConfig } from '$lib/api';
	import { clearAuthSession, setAuthToken, setPersistentAuthToken, setStoredDbUserId } from '$lib/authSession';
	import { initE2E } from '$lib/e2eManager';
	import { retryDecryptLoadedDmMessages } from '$lib/socket';
	import { setStoredHomeExperienceMode, type HomeExperienceMode } from '$lib/homeExperience';
	import { _, availableLocales, currentLocale, setAppLocale } from '$lib/i18n';
	import { getConfiguredServerUrl, getServerUrl, resolveServerUrl } from '$lib/serverUrl';
	import LaunchPanel from '$lib/components/login/LaunchPanel.svelte';
	import LoginQRModal from '$lib/components/login/LoginQRModal.svelte';
	import LoginConnectionPrompt from '$lib/components/login/LoginConnectionPrompt.svelte';
	import './login.css';

	const dispatch = createEventDispatcher<{
		login: { username: string; token?: string; authMethod: 'guest' | 'registered'; homeExperience?: HomeExperienceMode; mustChangePassword?: boolean };
	}>();

	let tab: 'guest' | 'login' | 'register' = 'guest';
	let username = '';
	let handle = '';
	let password = '';
	let passwordConfirm = '';
	let error = '';
	let loading = false;
	let showConnectionPrompt = true;
	let serverDomain = '';
	let rememberMe = false;
	let showQR = false;
	let showHomeExperiencePrompt = false;
	let pendingRegisteredLogin: { username: string; token: string } | null = null;
	let selectedLocale = 'en';
	let launchPageConfig: LaunchPageConfig | null = null;
	let wizardMode = false;

	$: selectedLocale = $currentLocale || 'en';
	$: activeLaunchPageConfig = launchPageConfig?.enabled ? launchPageConfig : null;
	$: launchContainerStyle = activeLaunchPageConfig
		? `--launch-bg-top: ${activeLaunchPageConfig.palette.backgroundTop}; --launch-bg-bottom: ${activeLaunchPageConfig.palette.backgroundBottom}; --launch-accent: ${activeLaunchPageConfig.palette.accent}; --launch-text: ${activeLaunchPageConfig.palette.text};${activeLaunchPageConfig.backgroundImageUrl ? ` background-image: url(${activeLaunchPageConfig.backgroundImageUrl}); background-size: cover; background-position: center;` : ''}`
		: '';
	$: launchCardStyle = activeLaunchPageConfig ? `--launch-card-bg: ${activeLaunchPageConfig.palette.cardBackground};` : '';
	$: launchCustomCss = activeLaunchPageConfig?.customCss || '';

	const t = (key: string): string => get(_)(key) as string;
	$: serverUrl = typeof window !== 'undefined' ? getServerUrl() : '';
	$: if (tab === 'register' && !handleManuallyEdited) handle = username.replace(/\s+/g, '').toLowerCase();
	let handleManuallyEdited = false;

	function switchTab(newTab: 'guest' | 'login' | 'register') {
		tab = newTab; error = ''; username = ''; handle = ''; handleManuallyEdited = false; password = ''; passwordConfirm = '';
	}

	function handleGuestLogin() {
		if (username.trim()) { clearAuthSession(); setStoredDbUserId(null); dispatch('login', { username: username.trim(), authMethod: 'guest' }); }
	}

	async function handleRegister() {
		error = '';
		if (username.length < 2) { error = t('login.errors.username_min'); return; }
		const cleanHandle = handle.replace(/^@/, '').toLowerCase();
		if (!/^[a-z][a-z0-9_]{1,31}$/.test(cleanHandle)) { error = t('login.errors.handle_invalid'); return; }
		if (password.length < 8) { error = t('login.errors.password_min'); return; }
		if (password !== passwordConfirm) { error = t('login.errors.password_mismatch'); return; }
		loading = true;
		try {
			const result = await register(username, password, cleanHandle);
			setAuthToken(result.token);
			if (result.user.id) { setStoredDbUserId(result.user.id); await initE2E(result.user.id, result.token, true); await retryDecryptLoadedDmMessages(); }
			if (wizardMode) dispatch('login', { username: result.user.username, token: result.token, authMethod: 'registered' });
			else { pendingRegisteredLogin = { username: result.user.username, token: result.token }; showHomeExperiencePrompt = true; }
		} catch (err) { error = err instanceof Error ? err.message : t('login.errors.registration_failed'); }
		finally { loading = false; }
	}

	async function completeRegistrationHomeExperience(mode: HomeExperienceMode) {
		if (!pendingRegisteredLogin) return;
		loading = true; error = '';
		try {
			await saveUserSettings(pendingRegisteredLogin.token, { home_experience: mode });
			setStoredHomeExperienceMode(mode);
			dispatch('login', { username: pendingRegisteredLogin.username, token: pendingRegisteredLogin.token, authMethod: 'registered', homeExperience: mode });
			pendingRegisteredLogin = null; showHomeExperiencePrompt = false;
		} catch (err) { error = err instanceof Error ? err.message : 'Failed to save home experience setting.'; }
		finally { loading = false; }
	}

	async function handleLogin() {
		error = '';
		if (!username || !password) { error = t('login.errors.username_password_required'); return; }
		loading = true;
		try {
			const result = await login(username, password);
			setAuthToken(result.token);
			if (rememberMe) setPersistentAuthToken(result.token);
			if (result.user.id) { setStoredDbUserId(result.user.id); await initE2E(result.user.id, result.token, false); await retryDecryptLoadedDmMessages(); }
			dispatch('login', { username: result.user.username, token: result.token, authMethod: 'registered', mustChangePassword: result.mustChangePassword === true });
		} catch (err) { error = err instanceof Error ? err.message : t('login.errors.login_failed'); }
		finally { loading = false; }
	}

	function focusOnMount(node: HTMLInputElement) { node.focus(); return {}; }

	onMount(() => {
		void getLaunchPageConfig().then((config) => { launchPageConfig = config; }).catch((err) => { console.warn('[Login] Failed to load launch page config:', err); });
		void getSetupStatus().then((status) => { if (status.setupRequired) { wizardMode = true; tab = 'register'; } });
		const configured = getConfiguredServerUrl();
		if (configured) { serverDomain = configured; showConnectionPrompt = false; return; }
		const resolved = resolveServerUrl();
		const isTauri = resolved.source === 'dev_tauri' || resolved.source === 'prod_tauri';
		if (isTauri) { serverDomain = ''; showConnectionPrompt = true; } else { serverDomain = resolved.url; showConnectionPrompt = false; }
	});
</script>

<svelte:head>
	<style>{launchCustomCss}</style>
</svelte:head>

<div class="login-container" style={launchContainerStyle}>
	<div class="login-shell" class:has-launch={!!activeLaunchPageConfig}>
		{#if activeLaunchPageConfig}
			<LaunchPanel config={activeLaunchPageConfig} />
		{/if}

		<div class="login-box" style={launchCardStyle}>
			<img src={activeLaunchPageConfig?.logoUrl || '/wabi-logo.webp'} alt={activeLaunchPageConfig?.brandName || 'Wabi'} class="logo" />
			{#if activeLaunchPageConfig}
				<h2 class="launch-headline">{activeLaunchPageConfig.headline}</h2>
				<p class="launch-subheadline">{activeLaunchPageConfig.subheadline}</p>
			{/if}

			{#if showConnectionPrompt}
				<LoginConnectionPrompt bind:serverDomain {loading} on:applied={() => (showConnectionPrompt = false)} />
			{:else}
				<div class="server-target">
					<span>Server: {serverUrl}</span>
					<button type="button" class="server-change" on:click={() => (showConnectionPrompt = true)}>Change</button>
				</div>

			{#if wizardMode}
				<div class="wizard">
					<h3>{$_('login.wizard.welcome')}</h3>
					<p class="wizard-subtitle">{$_('login.wizard.owner_subtitle')}</p>

					{#if error}
						<div class="error-message">{error}</div>
					{/if}

					<form on:submit|preventDefault={handleRegister}>
						<input type="text" bind:value={username} placeholder={$_('login.auth.display_name_placeholder')} minlength="2" maxlength="32" required use:focusOnMount disabled={loading} />
						<div class="handle-input-wrapper">
							<span class="handle-prefix">@</span>
							<input type="text" bind:value={handle} on:input={() => { handleManuallyEdited = true; }} placeholder={$_('login.auth.handle_placeholder')} minlength="2" maxlength="32" required disabled={loading} class="handle-input" />
						</div>
						<input type="password" bind:value={password} placeholder={$_('login.auth.password_rules_placeholder')} minlength="8" required disabled={loading} />
						<input type="password" bind:value={passwordConfirm} placeholder={$_('login.auth.confirm_password_placeholder')} minlength="8" required disabled={loading} />
						<button type="submit" class="join-btn" disabled={loading}>
							{loading ? $_('login.auth.creating_account') : $_('login.auth.create_account_button')}
						</button>
					</form>

					<p class="wizard-note wizard-note-standalone">{$_('login.wizard.advanced_setup_note')}</p>
				</div>

			{:else if showHomeExperiencePrompt}
				<div class="experience-prompt">
					<h3>Choose your default home view</h3>
					<p>Pick how Wabi should open by default. You can change this any time in Settings.</p>
					<div class="experience-actions">
						<button type="button" class="join-btn" disabled={loading} on:click={() => completeRegistrationHomeExperience('conversations')}>
							Conversation-first
						</button>
						<button type="button" class="join-btn secondary-btn" disabled={loading} on:click={() => completeRegistrationHomeExperience('community')}>
							Community-first
						</button>
					</div>
				</div>
			{:else}
				<div class="tabs">
					<button class="tab-btn" class:active={tab === 'guest'} on:click={() => switchTab('guest')}>{$_('login.tabs.guest')}</button>
					<button class="tab-btn" class:active={tab === 'login'} on:click={() => switchTab('login')}>{$_('login.tabs.login')}</button>
					<button class="tab-btn" class:active={tab === 'register'} on:click={() => switchTab('register')}>{$_('login.tabs.register')}</button>
				</div>

				<div class="locale-row">
					<label for="locale-picker">{$_('login.language.label')}</label>
					<select id="locale-picker" bind:value={selectedLocale} on:change={(event) => setAppLocale((event.currentTarget as HTMLSelectElement).value)}>
						{#each availableLocales as localeOption}
							<option value={localeOption.code}>{localeOption.label}</option>
						{/each}
					</select>
				</div>

				{#if error}
					<div class="error-message">{error}</div>
				{/if}

				{#if tab === 'guest'}
					<form on:submit|preventDefault={handleGuestLogin}>
						<input type="text" bind:value={username} placeholder={$_('login.guest.name_placeholder')} maxlength="20" required use:focusOnMount disabled={loading} />
						<button type="submit" class="join-btn" disabled={loading}>
							{loading ? $_('login.guest.joining') : $_('login.guest.join_button')}
						</button>
					</form>
					<button type="button" on:click={() => (showQR = true)} class="qr-btn" disabled={loading}>{$_('login.guest.join_qr_button')}</button>
					<a href="/business" class="hub-btn">{$_('login.guest.business_hub')}</a>
				{/if}

				{#if tab === 'login'}
					<form on:submit|preventDefault={handleLogin}>
						<input type="text" bind:value={username} placeholder={$_('login.auth.username_or_handle_placeholder')} required use:focusOnMount disabled={loading} />
						<input type="password" bind:value={password} placeholder={$_('login.auth.password_placeholder')} required disabled={loading} />
						<label class="remember-row">
							<input type="checkbox" bind:checked={rememberMe} disabled={loading} />
							<span>Remember me on this device</span>
						</label>
						<button type="submit" class="join-btn" disabled={loading}>
							{loading ? $_('login.auth.logging_in') : $_('login.auth.login_button')}
						</button>
					</form>
				{/if}

				{#if tab === 'register'}
					<form on:submit|preventDefault={handleRegister}>
						<input type="text" bind:value={username} placeholder={$_('login.auth.display_name_placeholder')} minlength="2" maxlength="32" required use:focusOnMount disabled={loading} />
						<div class="handle-input-wrapper">
							<span class="handle-prefix">@</span>
							<input type="text" bind:value={handle} on:input={() => { handleManuallyEdited = true; }} placeholder={$_('login.auth.handle_placeholder')} minlength="2" maxlength="32" required disabled={loading} class="handle-input" />
						</div>
						<input type="password" bind:value={password} placeholder={$_('login.auth.password_rules_placeholder')} minlength="8" required disabled={loading} />
						<input type="password" bind:value={passwordConfirm} placeholder={$_('login.auth.confirm_password_placeholder')} minlength="8" required disabled={loading} />
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

	{#if showQR}
		<LoginQRModal {serverUrl} on:close={() => (showQR = false)} />
	{/if}
</div>
