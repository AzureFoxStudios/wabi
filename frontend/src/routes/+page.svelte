<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import { initSocket, disconnect, dmPanelSignal } from '$lib/socket';
	import { requestNotificationPermission } from '$lib/notifications';
	import Login from '$lib/components/Login.svelte';
	import MainLayout from '$lib/components/MainLayout.svelte';
	import { layoutStore } from '$lib/layoutStore';
	import { initE2E, clearE2EState } from '$lib/e2eManager';
	import { clearAuthSession, getAuthToken, setAuthToken } from '$lib/authSession';
	import { initializeAccessibilitySettings } from '$lib/accessibility';
	import { initializeAnimationPassSettings } from '$lib/animationPass';
	import { startupMark, startupMeasure, startupScheduleReport } from '$lib/startupProfiler';
	import { _ } from '$lib/i18n';

	// Theme system
	import { initializeTheme, watchThemeChanges, syncThemeToLocalStorage } from '$lib/theme/initTheme';
	import { startTimedThemeModeScheduler } from '$lib/timedThemeMode';

	// Apply layout-affecting accessibility preferences before first render to avoid CLS.
	if (typeof window !== 'undefined') {
		initializeAccessibilitySettings();
		initializeAnimationPassSettings();
	}

	let loggedIn = typeof window !== 'undefined' && !!localStorage.getItem('username');
	let isInitialLoad = true;
	let isBootstrapping = true;
	let showLoadingScreen = true;

	let unsubscribeThemeWatcher: (() => void) | null = null;
	let unsubscribeLocalStorageSync: (() => void) | null = null;
	let unsubscribeLayoutStore: (() => void) | null = null;
	let stopTimedThemeScheduler: (() => void) | null = null;

	function scheduleNonCritical(task: () => void, timeout = 1500): void {
		if (typeof window === 'undefined') return;
		const ric = (window as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
		if (ric) {
			ric(task, { timeout });
			return;
		}
		window.setTimeout(task, 0);
	}

	// --- Lifecycle ---
	onMount(() => {
		let disposed = false;
		startupMark('page:onMount:start');
		startupMark('page:accessibility:ready');
		startupMeasure('page:accessibility:init', 'page:onMount:start', 'page:accessibility:ready');
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

		(async () => {
			startupMark('page:bootstrap:start');
			showLoadingScreen = true;
			isInitialLoad = true;
			startupMark('page:ui:unblocked');
			startupMeasure('page:to-ui-unblocked', 'page:onMount:start', 'page:ui:unblocked');

			const notificationsEnabled = localStorage.getItem('notificationsEnabled') !== 'false';
			if (notificationsEnabled && Notification.permission === 'default') {
				scheduleNonCritical(() => {
					requestNotificationPermission().catch(() => {
						// No-op: permission prompts are best-effort.
					});
				});
			}

			unsubscribeLayoutStore = layoutStore.subscribe(state => {
				if (state.isMobile) {
					layoutStore.resetPanelsOnDesktop();
				}
			});

			const savedUsername = localStorage.getItem('username');
			const savedToken = getAuthToken();
			if (savedUsername) {
				startupMark('page:socket:init:start');
				initSocket(savedUsername, savedToken || undefined);
				startupMark('page:socket:init:end');
				startupMeasure('page:socket:init:call', 'page:socket:init:start', 'page:socket:init:end');
				loggedIn = true;

				// Initialize E2E in background so it doesn't block initial render and socket startup.
				const dbUserId = localStorage.getItem('dbUserId');
				if (dbUserId) {
					scheduleNonCritical(() => {
						startupMark('page:e2e:init:start');
						void initE2E(parseInt(dbUserId, 10), savedToken, false)
							.catch((err) => {
								console.warn('[App] E2E init failed in background; continuing without E2E for now:', err);
							})
							.finally(() => {
								startupMark('page:e2e:init:end');
								startupMeasure('page:e2e:init', 'page:e2e:init:start', 'page:e2e:init:end');
							});
					});
				}
			}

			const isRegistered = !!savedToken || !!localStorage.getItem('dbUserId');
			// Theme fetch can hit network; don't block startup path.
			startupMark('page:theme:init:start');
			void initializeTheme(isRegistered).finally(() => {
				startupMark('page:theme:init:end');
				startupMeasure('page:theme:init', 'page:theme:init:start', 'page:theme:init:end');
			});
			if (disposed) return;

			unsubscribeThemeWatcher = watchThemeChanges();
			stopTimedThemeScheduler = startTimedThemeModeScheduler();
			if (!isRegistered) {
				unsubscribeLocalStorageSync = syncThemeToLocalStorage();
			}
			startupMark('page:bootstrap:end');
			startupMeasure('page:bootstrap', 'page:bootstrap:start', 'page:bootstrap:end');
			startupMeasure('page:total-to-bootstrap', 'page:onMount:start', 'page:bootstrap:end');
			startupScheduleReport('initial-load', 400);
			isBootstrapping = false;
			showLoadingScreen = false;
			isInitialLoad = false;
		})();

		window.addEventListener('keydown', handleKeyDown);

		return () => {
			disposed = true;
			window.removeEventListener('keydown', handleKeyDown);
			unsubscribeThemeWatcher?.();
			unsubscribeLocalStorageSync?.();
			unsubscribeLayoutStore?.();
			stopTimedThemeScheduler?.();
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
			setAuthToken(token);
		}

		initSocket(username, token);
		loggedIn = true;

		const isRegistered = authMethod === 'registered' || !!token;
		await initializeTheme(isRegistered);

		// Stop old watchers/syncers and start new ones if needed
		unsubscribeThemeWatcher?.();
		unsubscribeLocalStorageSync?.();
		stopTimedThemeScheduler?.();

		unsubscribeThemeWatcher = watchThemeChanges();
		stopTimedThemeScheduler = startTimedThemeModeScheduler();
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
			clearAuthSession();
		} catch (e) {
			console.error('Failed to clear localStorage:', e);
		}
	}
</script>

{#if showLoadingScreen && !isBootstrapping}
	<div class="loading-screen" transition:fade={{ duration: 400 }}></div>
{/if}

{#if isBootstrapping}
	<div class="boot-placeholder" aria-hidden="true">
		<div class="boot-center">
			<img src="/wabi-logo.webp" alt="Wabi" class="boot-logo" />
			<div class="boot-title">{$_('app.starting')}</div>
		</div>
	</div>
{:else if !loggedIn}
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
		background: linear-gradient(180deg, #0f172a 0%, #0b1220 55%, #060b14 100%);
		z-index: 10000;
		pointer-events: none;
	}

	.boot-placeholder {
		min-height: 100vh;
		background: linear-gradient(180deg, #0f172a 0%, #0b1220 55%, #060b14 100%);
		display: grid;
		place-items: center;
	}

	.boot-center {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;
	}

	.boot-logo {
		--boot-base-filter: invert(1) drop-shadow(0 10px 24px rgba(0, 0, 0, 0.35));
		width: 86px;
		height: 86px;
		object-fit: contain;
		filter: var(--boot-base-filter);
		animation: boot-spin 2.1s linear infinite, boot-filter-rotate 900ms ease-out 1;
	}

	.boot-title {
		font-size: 0.95rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.88);
		font-weight: 600;
	}

	@keyframes boot-spin {
		from { transform: rotate(0deg); }
		to { transform: rotate(360deg); }
	}

	@keyframes boot-filter-rotate {
		from { filter: var(--boot-base-filter) hue-rotate(0deg); }
		to { filter: var(--boot-base-filter) hue-rotate(360deg); }
	}
</style>
