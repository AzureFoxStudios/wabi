	<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { register, login, saveUserSettings, getLaunchPageConfig, getPublicAuthPolicy, getSetupStatus, type LaunchPageConfig } from '$lib/api';
	import type { AuthPolicy } from '../../../../shared/adminPolicyContracts';
	import { clearAuthSession, setAuthToken, setPersistentAuthToken, setStoredDbUserId } from '$lib/authSession';
		import { retryDecryptLoadedDmMessages } from '$lib/socket';
	import { setStoredHomeExperienceMode, type HomeExperienceMode } from '$lib/homeExperience';
	import { _, availableLocales, currentLocale, setAppLocale } from '$lib/i18n';
	import { getConfiguredServerUrl, getServerUrl, resolveServerUrl } from '$lib/serverUrl';
	import { brandName } from '$lib/branding';
	import LaunchPanel from '$lib/components/login/LaunchPanel.svelte';
	import LoginQRModal from '$lib/components/login/LoginQRModal.svelte';
	import LoginConnectionPrompt from '$lib/components/login/LoginConnectionPrompt.svelte';
	import { buildLaunchPageStyles, injectNeutralBranding, getEffectiveBrandConfig } from '$lib/components/loginHelpers';
	import './login.css';

	const dispatch = createEventDispatcher<{
		login: { username: string; token?: string; authMethod: 'guest' | 'registered'; homeExperience?: HomeExperienceMode; mustChangePassword?: boolean };
	}>();

	let authMode: 'login' | 'register' = 'login';
	let guestExpanded = false;
	let username = '';
	let guestName = '';
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
	let showPassword = false;
	let authPolicy: AuthPolicy = { mode: 'open', allowGuest: true, allowRegister: true, emailVerifyRequired: false };

	$: selectedLocale = $currentLocale || 'en';
	$: fallbackBrand = getEffectiveBrandConfig();
	// LaunchPanel is a marketing sibling. A host logo/banner is identity, not a story.
	$: showLaunchPanel = Boolean(
		launchPageConfig?.enabled &&
			(launchPageConfig.heroTitle ||
				launchPageConfig.headline ||
				(launchPageConfig.heroPrimaryCtaLabel && launchPageConfig.heroPrimaryCtaUrl) ||
				(launchPageConfig.highlights && launchPageConfig.highlights.length > 0) ||
				launchPageConfig.customCss)
	);
	$: activeLaunchPageConfig = showLaunchPanel ? launchPageConfig : null;
	$: hostBrandName = launchPageConfig?.brandName || fallbackBrand.name || brandName;
	$: hostLogoUrl = launchPageConfig?.logoUrl || fallbackBrand.logoSmallUrl || '/wabi-logo.webp';
	$: invertHostLogo = /(?:^|\/)(?:wabi-logo(?:-small)?\.webp|icon\.png)(?:\?|$)/i.test(hostLogoUrl);
	$: atmosphereUrl = launchPageConfig?.backgroundImageUrl || null;
	$: launchStyles = launchPageConfig
		? buildLaunchPageStyles({
				enabled: true,
				palette: {
					backgroundTop: launchPageConfig.palette?.backgroundTop || '',
					backgroundBottom: launchPageConfig.palette?.backgroundBottom || '',
					accent: launchPageConfig.palette?.accent || '',
					text: launchPageConfig.palette?.text || '',
					cardBackground: launchPageConfig.palette?.cardBackground || ''
				},
				backgroundImageUrl: atmosphereUrl || undefined,
				customCss: showLaunchPanel ? launchPageConfig.customCss || undefined : undefined
			})
		: { launchContainerStyle: '', launchCardStyle: '', launchCustomCss: '' };
	$: launchContainerStyle = launchStyles.launchContainerStyle;
	$: launchCardStyle = launchStyles.launchCardStyle;
	$: launchCustomCss = launchStyles.launchCustomCss;

	const t = (key: string): string => get(_)(key) as string;
	$: serverUrl = typeof window !== 'undefined' ? getServerUrl() : '';
	$: if (authMode === 'register' && !handleManuallyEdited) handle = username.replace(/\s+/g, '').toLowerCase();
	let handleManuallyEdited = false;

	function switchAuthMode(newMode: 'login' | 'register') {
		authMode = newMode; error = ''; username = ''; guestName = ''; handle = ''; handleManuallyEdited = false; password = ''; passwordConfirm = '';
	}

	function handleGuestLogin() {
		if (guestName.trim()) { clearAuthSession(); setStoredDbUserId(null); dispatch('login', { username: guestName.trim(), authMethod: 'guest' }); }
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
			if (result.user.id) { setStoredDbUserId(result.user.id); /* DM-strip: removed initE2E + retryDecryptLoadedDmMessages */ }
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
			if (result.user.id) { setStoredDbUserId(result.user.id); /* DM-strip: removed initE2E + retryDecryptLoadedDmMessages */ }
			localStorage.setItem('wabi_has_logged_in', 'true');
			dispatch('login', { username: result.user.username, token: result.token, authMethod: 'registered', mustChangePassword: result.mustChangePassword === true });
		} catch (err) { error = err instanceof Error ? err.message : t('login.errors.login_failed'); }
		finally { loading = false; }
	}

	function focusOnMount(node: HTMLInputElement) { node.focus(); return {}; }

	onMount(async () => {
		injectNeutralBranding();
		// Login is pre-auth. Pick a random full theme from ALL_PALETTES so the
		// ambient + accents cohere with a real selectable theme — not a detached
		// effect list. Reloads still feel fresh, but the preview matches what the
		// user will see in settings.
		try {
			const { ALL_PALETTES } = await import('$lib/theme/palettes');
			const root = document.documentElement;
			const pick = ALL_PALETTES[Math.floor(Math.random() * ALL_PALETTES.length)];
			const ambient = pick.ambient;
			if (ambient && ambient.effect !== 'none') {
				root.style.setProperty('--bg-effect-effect', ambient.effect);
				root.style.setProperty('--bg-effect-color', ambient.color || pick.accent);
				if (ambient.color2) root.style.setProperty('--bg-effect-color2', ambient.color2);
				if (ambient.color3) root.style.setProperty('--bg-effect-color3', ambient.color3);
				root.style.setProperty('--bg-effect-intensity', String(ambient.intensity ?? 0.5));
				root.style.setProperty('--bg-effect-size', String(ambient.size ?? 1));
				root.style.setProperty('--bg-effect-speed', String(ambient.speed ?? 1));
				if (ambient.frostOpacity) root.style.setProperty('--bg-effect-frost-opacity', String(ambient.frostOpacity));
				if (ambient.frostBlur) root.style.setProperty('--bg-effect-frost-blur', String(ambient.frostBlur));
				root.setAttribute('data-ambient', 'true');
				root.setAttribute('data-login-ambient', ambient.effect);
			}
			// Soft-tint UI accents so the login card matches the ambient.
			root.style.setProperty('--accent-primary-color', pick.accent);
			root.style.setProperty('--accent-secondary-color', pick.accentSecondary);
		} catch {
			/* non-fatal */
		}
		void getLaunchPageConfig().then((config) => { launchPageConfig = config; }).catch((err) => { console.warn('[Login] Failed to load launch page config:', err); });
		void getPublicAuthPolicy().then((policy) => {
			authPolicy = policy;
			if (!policy.allowRegister && !wizardMode) authMode = 'login';
		});
		void getSetupStatus().then((status) => { if (status.setupRequired) { wizardMode = true; authMode = 'register'; } });
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

<div class="login-container" class:has-atmosphere={!!atmosphereUrl} data-login-brand={invertHostLogo ? 'wabi' : 'custom'} style={launchContainerStyle}>
	<div class="login-shell" class:has-launch={!!activeLaunchPageConfig}>
		{#if activeLaunchPageConfig}
			<LaunchPanel config={activeLaunchPageConfig} />
		{/if}

		<div class="login-box" class:login-box-default={!activeLaunchPageConfig} style={launchCardStyle}>
			<div class="login-brand-panel">
				<img src={hostLogoUrl} alt={hostBrandName} class="login-logo" class:login-logo-compact={!activeLaunchPageConfig} class:login-logo-invert={invertHostLogo} />
				{#if activeLaunchPageConfig}
					{#if activeLaunchPageConfig.headline}
						<h2 class="launch-headline">{activeLaunchPageConfig.headline}</h2>
					{/if}
					{#if activeLaunchPageConfig.subheadline}
						<p class="launch-subheadline">{activeLaunchPageConfig.subheadline}</p>
					{/if}
				{:else}
					<h1 class="login-title">{hostBrandName}</h1>
				{/if}
			</div>

			<div class="login-auth-panel">
				{#if showConnectionPrompt}
					<LoginConnectionPrompt bind:serverDomain {loading} on:applied={() => (showConnectionPrompt = false)} />
				{:else}
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
								<button type="submit" class="auth-btn auth-btn-primary" disabled={loading}>
									{loading ? $_('login.auth.creating_account') : $_('login.auth.create_account_button')}
								</button>
							</form>

							<p class="wizard-note wizard-note-standalone">{$_('login.wizard.advanced_setup_note')}</p>
						</div>

					{:else if showHomeExperiencePrompt}
						<div class="experience-prompt">
							<h3>Choose your default home view</h3>
							<p>Pick how {brandName} should open by default. You can change this any time in Settings.</p>
							<div class="experience-actions">
								<button type="button" class="auth-btn auth-btn-primary" disabled={loading} on:click={() => completeRegistrationHomeExperience('conversations')}>
									Conversation-first
								</button>
								<button type="button" class="auth-btn auth-btn-secondary" disabled={loading} on:click={() => completeRegistrationHomeExperience('community')}>
									Community-first
								</button>
							</div>
						</div>
					{:else}
						{#if error}
							<div class="error-message">{error}</div>
						{/if}

						{#if authMode === 'login'}
							<form class="auth-form" on:submit|preventDefault={handleLogin}>
								<label class="field-label">
									<span class="field-caption">Username or handle</span>
									<input type="text" bind:value={username} placeholder={$_('login.auth.username_or_handle_placeholder')} autocomplete="username" required use:focusOnMount disabled={loading} />
								</label>
								<label class="field-label password-field">
									<span class="field-caption">Password</span>
									<div class="password-wrapper">
										<input type={showPassword ? 'text' : 'password'} bind:value={password} placeholder={$_('login.auth.password_placeholder')} autocomplete="current-password" required disabled={loading} />
										<button type="button" class="password-toggle" on:click={() => showPassword = !showPassword} aria-label={showPassword ? $_('login.auth.hide_password') : $_('login.auth.show_password')} aria-pressed={showPassword}>
											<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
												{#if showPassword}
													<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
													<line x1="1" y1="1" x2="23" y2="23"></line>
												{:else}
													<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
													<circle cx="12" cy="12" r="3"></circle>
												{/if}
											</svg>
										</button>
									</div>
								</label>
								<div class="field-row">
									<label class="remember-row">
										<input type="checkbox" bind:checked={rememberMe} disabled={loading} />
										<span>{$_('login.auth.remember_me')}</span>
									</label>
									<!-- Finding 13: forgot-password has no backend yet — hide until recovery exists -->
								</div>
								<button type="submit" class="auth-btn auth-btn-primary" disabled={loading}>
									{loading ? $_('login.auth.logging_in') : $_('login.auth.login_button')}
								</button>
							</form>
							<p class="auth-alt-prompt">
								{#if authPolicy.allowRegister}
									{$_('login.auth.create_account_prompt')} <button type="button" class="auth-link" on:click={() => switchAuthMode('register')}>{$_('login.auth.create_account_link')}</button>
								{:else}
									Registration is closed on this server.
								{/if}
							</p>
						{:else}
							<form class="auth-form" on:submit|preventDefault={handleRegister}>
								<label class="field-label">
									<span class="field-caption">Display name</span>
									<input type="text" bind:value={username} placeholder={$_('login.auth.display_name_placeholder')} autocomplete="name" minlength="2" maxlength="32" required use:focusOnMount disabled={loading} />
								</label>
								<label class="field-label">
									<span class="field-caption">Permanent handle</span>
									<div class="handle-input-wrapper">
										<span class="handle-prefix">@</span>
										<input type="text" bind:value={handle} on:input={() => { handleManuallyEdited = true; }} placeholder={$_('login.auth.handle_placeholder')} autocomplete="username" minlength="2" maxlength="32" required disabled={loading} class="handle-input" />
									</div>
								</label>
								<label class="field-label">
									<span class="field-caption">Password</span>
									<input type="password" bind:value={password} placeholder={$_('login.auth.password_rules_placeholder')} autocomplete="new-password" minlength="8" required disabled={loading} />
								</label>
								<label class="field-label">
									<span class="field-caption">Confirm password</span>
									<input type="password" bind:value={passwordConfirm} placeholder={$_('login.auth.confirm_password_placeholder')} autocomplete="new-password" minlength="8" required disabled={loading} />
								</label>
								<button type="submit" class="auth-btn auth-btn-primary" disabled={loading}>
									{loading ? $_('login.auth.creating_account') : $_('login.auth.create_account_button')}
								</button>
							</form>
							<p class="auth-alt-prompt">
								Already have an account? <button type="button" class="auth-link" on:click={() => switchAuthMode('login')}>Log in</button>
							</p>
						{/if}

						{#if authPolicy.allowGuest}
						<div class="auth-divider">
							<span>guest access</span>
						</div>

						{#if guestExpanded}
							<div class="guest-section">
								<form on:submit|preventDefault={handleGuestLogin}>
									<label class="field-label">
										<span class="field-caption">Guest display name</span>
										<input type="text" bind:value={guestName} placeholder={$_('login.guest.name_placeholder')} autocomplete="nickname" maxlength="20" required disabled={loading} />
									</label>
									<button type="submit" class="auth-btn auth-btn-secondary" disabled={loading}>
										{loading ? $_('login.guest.joining') : $_('login.guest.join_button')}
									</button>
								</form>
								<div class="guest-extras">
									<button type="button" on:click={() => (showQR = true)} class="auth-btn auth-btn-ghost" disabled={loading}>{$_('login.guest.join_qr_button')}</button>
									<a href="/business" class="auth-btn auth-btn-ghost">{$_('login.guest.business_hub')}</a>
								</div>
							</div>
						{:else}
							<button type="button" class="guest-expand" on:click={() => { guestExpanded = true; error = ''; }}>
								{$_('login.auth.guest_access_link')}
							</button>
						{/if}
						{/if}

						<div class="auth-footer-row">
							<div class="locale-pill">
								<span class="locale-flag" aria-hidden="true">🇺🇸</span>
								<span class="locale-label" aria-hidden="true">English</span>
								<select id="locale-picker" aria-label="Language" bind:value={selectedLocale} on:change={(event) => setAppLocale((event.currentTarget as HTMLSelectElement).value)}>
									{#each availableLocales as localeOption}
										<option value={localeOption.code}>{localeOption.label}</option>
									{/each}
								</select>
							</div>
							<div class="server-pill">
								<span class="server-pill-url">{$_('login.auth.change_server')}</span>
								<button type="button" class="server-pill-btn" on:click={() => (showConnectionPrompt = true)}>{$_('login.auth.change_server_link')}</button>
							</div>
						</div>
					{/if}
				{/if}
				{#if activeLaunchPageConfig?.footerNote}
					<p class="launch-footer-note">{activeLaunchPageConfig.footerNote}</p>
				{/if}
			</div>
		</div>
	</div>

	{#if showQR}
		<LoginQRModal {serverUrl} on:close={() => (showQR = false)} />
	{/if}
</div>
