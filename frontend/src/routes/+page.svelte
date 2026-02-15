<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import { initSocket, disconnect, dmPanelSignal, appealRequired } from '$lib/socket';
	import { requestNotificationPermission } from '$lib/notifications';
	import Login from '$lib/components/Login.svelte';
	import MainLayout from '$lib/components/MainLayout.svelte';
	import type { PageData } from './$types';
	import { layoutStore } from '$lib/layoutStore';
	import { initE2E, clearE2EState } from '$lib/e2eManager';
	import { authStore } from '$lib/authStore';

	// Theme system
	import { initializeTheme, watchThemeChanges, syncThemeToLocalStorage } from '$lib/theme/initTheme';

	export let data: PageData;

	let loggedIn = typeof window !== 'undefined' && !!localStorage.getItem('username');
	let isInitialLoad = true;
	let showLoadingScreen = true;
	let isAppealRequired = false;

	let unsubscribeThemeWatcher: (() => void) | null = null;
	let unsubscribeLocalStorageSync: (() => void) | null = null;

	// --- Lifecycle ---
	onMount(() => {
		showLoadingScreen = false;
		isInitialLoad = false;
		isAppealRequired = localStorage.getItem('appealRequired') === 'true';

		const unsubscribeAppeal = appealRequired.subscribe((required) => {
			isAppealRequired = required || localStorage.getItem('appealRequired') === 'true';
			if (required) loggedIn = false;
		});

		const unsubscribeAuth = authStore.subscribe((state) => {
			if (state.error?.type === 'session_expired' || state.error?.type === 'invalid_token' || state.appealRequired) {
				loggedIn = false;
			}
			if (state.appealRequired) isAppealRequired = true;
		});

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.ctrlKey && e.shiftKey && e.key === '1') {
				e.preventDefault();
				window.location.href = '/business';
			}
			if (e.ctrlKey && e.shiftKey && (e.key === 'O' || e.key === 'o')) {
				e.preventDefault();
				handleLogout();
			}
		};
		window.addEventListener('keydown', handleKeyDown);

		void (async () => {
			const notificationsEnabled = localStorage.getItem('notificationsEnabled') !== 'false';
			if (notificationsEnabled) await requestNotificationPermission();

			layoutStore.subscribe(state => {
				if (state.isMobile) layoutStore.resetPanelsOnDesktop();
			});

			const savedUsername = localStorage.getItem('username');
			const savedToken = localStorage.getItem('authToken');
			if (savedUsername) {
				if (savedToken) {
					const dbUserId = localStorage.getItem('dbUserId');
					if (dbUserId) {
						try {
							await initE2E(parseInt(dbUserId, 10), savedToken, false);
						} catch (err) {
							console.error('[App] Cached session invalid, clearing login:', err);
							localStorage.removeItem('username');
							localStorage.removeItem('authToken');
							localStorage.removeItem('dbUserId');
							localStorage.removeItem('sessionId');
							loggedIn = false;
							return;
						}
					}
				}

				initSocket(savedUsername, savedToken || undefined);
				loggedIn = true;
			}

			const isRegistered = !!savedToken;
			await initializeTheme(isRegistered);
			unsubscribeThemeWatcher = watchThemeChanges();
			if (!isRegistered) unsubscribeLocalStorageSync = syncThemeToLocalStorage();
		})();

		return () => {
			window.removeEventListener('keydown', handleKeyDown);
			unsubscribeThemeWatcher?.();
			unsubscribeLocalStorageSync?.();
			unsubscribeAppeal();
			unsubscribeAuth();
		};
	});
	
	onDestroy(() => {
		disconnect();
	});

	// --- Event Handlers & Logic ---
	$: if ($dmPanelSignal) {
		layoutStore.openDM($dmPanelSignal.channelId, $dmPanelSignal.otherUser);
		dmPanelSignal.set(null);
	}

	async function handleLogin(event: CustomEvent<{ username: string; token?: string; authMethod: 'guest' | 'registered' }>) {
		const { username, token, authMethod } = event.detail;
		if (isAppealRequired) return;
		localStorage.setItem('username', username);

		if (token) {
			localStorage.setItem('authToken', token);
			localStorage.removeItem('sessionId');
		}

		initSocket(username, token);
		loggedIn = true;

		const isRegistered = authMethod === 'registered' || !!token;
		await initializeTheme(isRegistered);

		// Stop old watchers/syncers and start new ones if needed
		unsubscribeThemeWatcher?.();
		unsubscribeLocalStorageSync?.();

		unsubscribeThemeWatcher = watchThemeChanges();
		if (!isRegistered) {
			unsubscribeLocalStorageSync = syncThemeToLocalStorage();
		}
	}

	function handleLogout() {
		disconnect();
		clearE2EState();
		loggedIn = false;
		isAppealRequired = false;
		authStore.clearAppealRequired();
		appealRequired.set(false);
		try {
			localStorage.removeItem('username');
			localStorage.removeItem('sessionId');
			localStorage.removeItem('authToken');
			localStorage.removeItem('appealRequired');
		} catch (e) {
			console.error('Failed to clear localStorage:', e);
		}
	}
</script>

{#if showLoadingScreen}
	<div class="loading-screen" transition:fade={{ duration: 400 }}></div>
{/if}

{#if isAppealRequired}
	<div class="appeal-gate" transition:fade={{ duration: 300 }}>
		<h1>Access Restricted</h1>
		<p>Your account requires an appeal review before chat access can continue.</p>
		<a class="appeal-cta" href="mailto:appeals@wabi.chat?subject=Appeal%20Request">Submit Appeal</a>
	</div>
{:else if !loggedIn}
	{#if isInitialLoad}
		<Login on:login={handleLogin} appealRequired={isAppealRequired} />
	{:else}
		<div transition:fade={{ duration: 300 }}>
			<Login on:login={handleLogin} appealRequired={isAppealRequired} />
		</div>
	{/if}
{:else}
	{#if isInitialLoad}
		<MainLayout on:logout={handleLogout} />
	{:else}
		<div transition:fade={{ duration: 300 }}>
			<MainLayout on:logout={handleLogout} />
		</div>
	{/if}
{/if}

<style>
	.appeal-gate {
		position: fixed;
		inset: 0;
		display: grid;
		place-content: center;
		gap: 0.75rem;
		text-align: center;
		padding: 2rem;
		background: var(--gradient-loading-dark);
		color: #fff;
		z-index: 10001;
	}

	.appeal-cta {
		display: inline-block;
		margin-top: 0.5rem;
		padding: 0.7rem 1rem;
		border-radius: 8px;
		background: #ff6b6b;
		color: #fff;
		text-decoration: none;
		font-weight: 700;
	}

	.loading-screen {
		position: fixed;
		inset: 0;
		background: var(--gradient-loading-dark);
		z-index: 10000;
		pointer-events: none;
	}
</style>
