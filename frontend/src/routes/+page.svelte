<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import { initSocket, disconnect, dmPanelSignal, retryDecryptLoadedDmMessages } from '$lib/socket';
	import { requestNotificationPermission } from '$lib/notifications';
	import Login from '$lib/components/Login.svelte';
	import MainLayout from '$lib/components/MainLayout.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import { layoutStore } from '$lib/layoutStore';
	import { initE2E, clearE2EState } from '$lib/e2eManager';
	import {
		clearAuthSession,
		clearStoredIdentity,
		getAuthToken,
		getGuestSessionId,
		getStoredDbUserId,
		getStoredUsername,
		setAuthToken,
		setStoredUsername
	} from '$lib/authSession';
	import { authStore } from '$lib/authStore';
	import { getUserSettings } from '$lib/api';
	import { initializeAccessibilitySettings } from '$lib/accessibility';
	import { initializeAnimationPassSettings } from '$lib/animationPass';
	import { startupMark, startupMeasure, startupScheduleReport } from '$lib/startupProfiler';
	import {
		applyHomeExperienceMode,
		getStoredHomeExperienceMode,
		normalizeHomeExperienceMode,
		setStoredHomeExperienceMode,
		type HomeExperienceMode
	} from '$lib/homeExperience';
	import { _ } from '$lib/i18n';
	import { startDesktopHelperLifecycle, stopDesktopHelperService } from '$lib/desktopHelper';
	import { startFollowNotificationPoller } from '$lib/followNotifier';

	// Theme system
	import { initializeTheme, watchThemeChanges, syncThemeToLocalStorage } from '$lib/theme/initTheme';
	import { startTimedThemeModeScheduler } from '$lib/timedThemeMode';

	// Apply layout-affecting accessibility preferences before first render to avoid CLS.
	if (typeof window !== 'undefined') {
		initializeAccessibilitySettings();
		initializeAnimationPassSettings();
	}

	let loggedIn = false;
	let isInitialLoad = true;
	let isBootstrapping = true;
	let showLoadingScreen = true;

	let unsubscribeThemeWatcher: (() => void) | null = null;
	let unsubscribeLocalStorageSync: (() => void) | null = null;
	let unsubscribeLayoutStore: (() => void) | null = null;
	let unsubscribeAuthStore: (() => void) | null = null;
	let stopTimedThemeScheduler: (() => void) | null = null;
	let authResetInFlight = false;
	let bootShellDismissed = false;
	let stopDesktopHelperLifecycle: (() => void) | null = null;
	let stopFollowNotificationPoller: (() => void) | null = null;
	let showTempPasswordPrompt = false;
	let accountSecurityOpenRequest = 0;

	function dismissDocumentBootShell(): void {
		if (bootShellDismissed || typeof window === 'undefined') return;
		bootShellDismissed = true;
		window.dispatchEvent(new CustomEvent('wabi:boot-hide'));
	}

	function scheduleNonCritical(task: () => void, timeout = 1500): void {
		if (typeof window === 'undefined') return;
		const ric = (window as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
		if (ric) {
			ric(task, { timeout });
			return;
		}
		window.setTimeout(task, 0);
	}

	function syncFollowNotificationPoller(nextLoggedIn: boolean): void {
		if (!nextLoggedIn) {
			stopFollowNotificationPoller?.();
			stopFollowNotificationPoller = null;
			return;
		}
		if (!stopFollowNotificationPoller) {
			stopFollowNotificationPoller = startFollowNotificationPoller();
		}
	}

	async function syncHomeExperienceFromServer(token: string | null | undefined): Promise<HomeExperienceMode> {
		if (!token) {
			return getStoredHomeExperienceMode();
		}
		try {
			const settings = await getUserSettings(token);
			const mode = normalizeHomeExperienceMode(settings?.home_experience);
			setStoredHomeExperienceMode(mode);
			return mode;
		} catch {
			return getStoredHomeExperienceMode();
		}
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
			unsubscribeAuthStore = authStore.subscribe((state) => {
				const errorType = state.error?.type;
				if (!state.isAuthError || !errorType) return;
				if (errorType !== 'session_expired' && errorType !== 'invalid_token') return;
				if (authResetInFlight) return;

				authResetInFlight = true;
				loggedIn = false;
				disconnect();
				syncFollowNotificationPoller(false);
				void stopDesktopHelperService(true);
				clearAuthSession();
				clearStoredIdentity();
				clearE2EState();
				authStore.clearAuthError();
				authResetInFlight = false;
			});

			const savedUsername = getStoredUsername();
			const savedToken = getAuthToken();
			const savedGuestSessionId = getGuestSessionId();
			const hasSession = Boolean(savedToken || savedGuestSessionId);
			if (savedUsername && hasSession) {
				startupMark('page:socket:init:start');
				initSocket(savedUsername, savedToken || undefined);
				startupMark('page:socket:init:end');
				startupMeasure('page:socket:init:call', 'page:socket:init:start', 'page:socket:init:end');
				loggedIn = true;
				syncFollowNotificationPoller(true);
				applyHomeExperienceMode(getStoredHomeExperienceMode());
				if (savedToken) {
					scheduleNonCritical(() => {
						void syncHomeExperienceFromServer(savedToken).then((mode) => {
							applyHomeExperienceMode(mode);
						});
					});
				}

				// Initialize E2E in background so it doesn't block initial render and socket startup.
				const dbUserId = getStoredDbUserId();
				if (dbUserId) {
					startupMark('page:e2e:init:start');
					void initE2E(dbUserId, savedToken, false)
						.then(() => retryDecryptLoadedDmMessages())
						.catch((err) => {
							console.warn('[App] E2E init failed; continuing without E2E for now:', err);
						})
						.finally(() => {
							startupMark('page:e2e:init:end');
							startupMeasure('page:e2e:init', 'page:e2e:init:start', 'page:e2e:init:end');
						});
				}
			} else {
				// Prevent stale username-only local state from skipping login.
				loggedIn = false;
				syncFollowNotificationPoller(false);
				clearStoredIdentity();
				clearAuthSession();
			}

			const isRegistered = !!savedToken || !!getStoredDbUserId();
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
			stopDesktopHelperLifecycle = startDesktopHelperLifecycle();
			isBootstrapping = false;
			dismissDocumentBootShell();
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
				unsubscribeAuthStore?.();
				stopTimedThemeScheduler?.();
				stopDesktopHelperLifecycle?.();
				stopFollowNotificationPoller?.();
			};
		});
	
	onDestroy(() => {
		disconnect();
		syncFollowNotificationPoller(false);
		void stopDesktopHelperService(true);
	});

	// --- Event Handlers & Logic ---
	$: if ($dmPanelSignal) {
		layoutStore.openDM($dmPanelSignal.channelId, $dmPanelSignal.otherUser);
		dmPanelSignal.set(null);
	}

	async function handleLogin(event: CustomEvent<{ username: string; token?: string; authMethod: 'guest' | 'registered'; homeExperience?: HomeExperienceMode; mustChangePassword?: boolean }>) {
		const { username, token, authMethod, homeExperience, mustChangePassword } = event.detail;
		setStoredUsername(username);

		if (token) {
			setAuthToken(token);
		}

		initSocket(username, token);
		loggedIn = true;
		syncFollowNotificationPoller(true);

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

		const immediateMode = normalizeHomeExperienceMode(homeExperience || getStoredHomeExperienceMode());
		setStoredHomeExperienceMode(immediateMode);
		applyHomeExperienceMode(immediateMode);

		if (isRegistered && token && !homeExperience) {
			scheduleNonCritical(() => {
				void syncHomeExperienceFromServer(token).then((mode) => {
					applyHomeExperienceMode(mode);
				});
			});
		}

		showTempPasswordPrompt = mustChangePassword === true;
	}

	function openAccountSecurityFromTempPasswordPrompt() {
		showTempPasswordPrompt = false;
		accountSecurityOpenRequest += 1;
	}

	function handleLogout() {
		disconnect();
		syncFollowNotificationPoller(false);
		void stopDesktopHelperService(true);
		clearE2EState();
		loggedIn = false;
		showTempPasswordPrompt = false;
		clearStoredIdentity();
		clearAuthSession();
	}
</script>

{#if showLoadingScreen && !isBootstrapping}
	<div class="loading-screen" transition:fade={{ duration: 400 }} aria-hidden="true">
		<div class="boot-center boot-center--overlay">
			<div class="boot-stage">
				<span class="boot-halo"></span>
				<span class="boot-ring"></span>
				<img src="/wabi-logo.webp" alt="" class="boot-logo" />
			</div>
			<div class="boot-copy">
				<div class="boot-title">{$_('app.starting')}</div>
				<div class="boot-dots" aria-hidden="true">
					<span></span>
					<span></span>
					<span></span>
				</div>
			</div>
		</div>
	</div>
{/if}

{#if isBootstrapping}
	<div class="boot-placeholder">
		<div class="boot-center" role="status" aria-live="polite">
			<div class="boot-stage" aria-hidden="true">
				<span class="boot-halo"></span>
				<span class="boot-ring"></span>
				<img src="/wabi-logo.webp" alt="" class="boot-logo" />
			</div>
			<div class="boot-copy">
				<div class="boot-title">{$_('app.starting')}</div>
				<div class="boot-dots" aria-hidden="true">
					<span></span>
					<span></span>
					<span></span>
				</div>
			</div>
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
		<MainLayout accountSecurityOpenRequest={accountSecurityOpenRequest} on:logout={handleLogout} />
	{:else}
		<div transition:fade={{ duration: 300 }}>
			<MainLayout accountSecurityOpenRequest={accountSecurityOpenRequest} on:logout={handleLogout} />
		</div>
	{/if}
	<ConfirmDialog
		isOpen={showTempPasswordPrompt}
		title="Temporary Password"
		message="An owner or admin reset this account with a temporary password. Open Account Security now and choose a new password."
		confirmText="Change Password"
		cancelText="Later"
		variant="warning"
		onConfirm={openAccountSecurityFromTempPasswordPrompt}
		onCancel={() => showTempPasswordPrompt = false}
	/>
{/if}

<style>
	.loading-screen {
		position: fixed;
		inset: 0;
		background:
			radial-gradient(circle at top, rgba(129, 140, 248, 0.16), transparent 38%),
			radial-gradient(circle at bottom, rgba(56, 189, 248, 0.14), transparent 42%),
			linear-gradient(180deg, #0f172a 0%, #0b1220 55%, #060b14 100%);
		z-index: 10000;
		pointer-events: none;
		display: grid;
		place-items: center;
		overflow: hidden;
	}

	.boot-placeholder {
		min-height: 100vh;
		background:
			radial-gradient(circle at top, rgba(129, 140, 248, 0.16), transparent 38%),
			radial-gradient(circle at bottom, rgba(56, 189, 248, 0.14), transparent 42%),
			linear-gradient(180deg, #0f172a 0%, #0b1220 55%, #060b14 100%);
		display: grid;
		place-items: center;
		overflow: hidden;
	}

	.boot-center {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1.15rem;
		padding: 2rem;
		text-align: center;
	}

	.boot-center--overlay {
		opacity: 0.92;
		transform: scale(0.985);
	}

	.boot-stage {
		position: relative;
		display: grid;
		place-items: center;
		width: 132px;
		height: 132px;
	}

	.boot-halo,
	.boot-ring {
		position: absolute;
		border-radius: 999px;
	}

	.boot-halo {
		inset: 10px;
		background:
			radial-gradient(circle, rgba(255, 255, 255, 0.22) 0%, rgba(255, 255, 255, 0.04) 38%, transparent 68%);
		filter: blur(8px);
		animation: boot-halo-pulse 1.8s ease-in-out infinite;
	}

	.boot-ring {
		inset: 0;
		border: 1px solid rgba(148, 163, 184, 0.18);
		box-shadow:
			inset 0 0 0 1px rgba(255, 255, 255, 0.03),
			0 18px 40px rgba(0, 0, 0, 0.3);
	}

	.boot-ring::after {
		content: '';
		position: absolute;
		inset: -1px;
		border-radius: inherit;
		border-top: 2px solid rgba(255, 255, 255, 0.82);
		border-right: 2px solid rgba(96, 165, 250, 0.85);
		border-bottom: 2px solid transparent;
		border-left: 2px solid transparent;
		animation: boot-spin 1.25s linear infinite;
	}

	.boot-copy {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.55rem;
	}

	.boot-logo {
		--boot-base-filter: invert(1) drop-shadow(0 12px 28px rgba(0, 0, 0, 0.38));
		width: 72px;
		height: 72px;
		object-fit: contain;
		filter: var(--boot-base-filter);
		animation: boot-logo-drift 1.8s ease-in-out infinite, boot-filter-rotate 900ms ease-out 1;
	}

	.boot-title {
		font-size: 0.9rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.88);
		font-weight: 700;
	}

	.boot-dots {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}

	.boot-dots span {
		width: 0.42rem;
		height: 0.42rem;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.8);
		animation: boot-dot-pulse 1.15s ease-in-out infinite;
	}

	.boot-dots span:nth-child(2) {
		animation-delay: 120ms;
	}

	.boot-dots span:nth-child(3) {
		animation-delay: 240ms;
	}

	@keyframes boot-spin {
		from { transform: rotate(0deg); }
		to { transform: rotate(360deg); }
	}

	@keyframes boot-logo-drift {
		0%, 100% { transform: translateY(0px) scale(1); }
		50% { transform: translateY(-3px) scale(1.02); }
	}

	@keyframes boot-filter-rotate {
		from { filter: var(--boot-base-filter) hue-rotate(0deg); }
		to { filter: var(--boot-base-filter) hue-rotate(360deg); }
	}

	@keyframes boot-halo-pulse {
		0%, 100% { opacity: 0.6; transform: scale(0.97); }
		50% { opacity: 1; transform: scale(1.02); }
	}

	@keyframes boot-dot-pulse {
		0%, 80%, 100% { opacity: 0.25; transform: translateY(0px); }
		40% { opacity: 1; transform: translateY(-2px); }
	}
</style>
