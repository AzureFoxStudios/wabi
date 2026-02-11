<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import { initSocket, disconnect, dmPanelSignal } from '$lib/socket';
	import { requestNotificationPermission } from '$lib/notifications';
	import Login from '$lib/components/Login.svelte';
	import MainLayout from '$lib/components/MainLayout.svelte';
	import type { PageData } from './$types';
	import { layoutStore } from '$lib/layoutStore';
	import { initE2E, clearE2EState } from '$lib/e2eManager';

	// Theme system
	import { initializeTheme, watchThemeChanges, syncThemeToLocalStorage } from '$lib/theme/initTheme';

	export let data: PageData;

	let loggedIn = typeof window !== 'undefined' && !!localStorage.getItem('username');
	let isInitialLoad = true;
	let showLoadingScreen = true;

	let unsubscribeThemeWatcher: (() => void) | null = null;
	let unsubscribeLocalStorageSync: (() => void) | null = null;

	// --- Lifecycle ---
	onMount(async () => {
		showLoadingScreen = false;
		isInitialLoad = false;

		const notificationsEnabled = localStorage.getItem('notificationsEnabled') !== 'false';
		if (notificationsEnabled) await requestNotificationPermission();
		
		layoutStore.subscribe(state => {
			if (state.isMobile) {
				layoutStore.resetPanelsOnDesktop();
			}
		});

		const savedUsername = localStorage.getItem('username');
		const savedToken = localStorage.getItem('authToken');
		if (savedUsername) {
			initSocket(savedUsername, savedToken || undefined);
			loggedIn = true;

			// Initialize E2E encryption if registered user
			if (savedToken) {
				const dbUserId = localStorage.getItem('dbUserId');
				if (dbUserId) {
					initE2E(parseInt(dbUserId, 10), savedToken, false);
				}
			}
		}

		const isRegistered = !!savedToken;
		await initializeTheme(isRegistered);

		unsubscribeThemeWatcher = watchThemeChanges();

		if (!isRegistered) {
			unsubscribeLocalStorageSync = syncThemeToLocalStorage();
		}

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
		
		return () => {
			window.removeEventListener('keydown', handleKeyDown);
			unsubscribeThemeWatcher?.();
			unsubscribeLocalStorageSync?.();
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
		try {
			localStorage.removeItem('username');
			localStorage.removeItem('sessionId');
			localStorage.removeItem('authToken');
		} catch (e) {
			console.error('Failed to clear localStorage:', e);
		}
	}
</script>

{#if showLoadingScreen}
	<div class="loading-screen" transition:fade={{ duration: 400 }}></div>
{/if}

{#if !loggedIn}
	{#if isInitialLoad}
		<Login on:login={handleLogin} />
	{:else}
		<div transition:fade={{ duration: 300 }}>
			<Login on:login={handleLogin} />
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
	.loading-screen {
		position: fixed;
		inset: 0;
		background: var(--gradient-loading-dark);
		z-index: 10000;
		pointer-events: none;
	}
</style>
