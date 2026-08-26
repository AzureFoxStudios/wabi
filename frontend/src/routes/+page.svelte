<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import { initSocket, disconnect, dmPanelSignal, retryDecryptLoadedDmMessages, currentUser, joinChannel } from '$lib/socket';
	import { requestNotificationPermission } from '$lib/notifications';
	import Login from '$lib/components/Login.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import { showToast } from '$lib/toast';
	import { layoutStore } from '$lib/layoutStore';
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
	import { getUserSettings, getSetupStatus, getApiBase } from '$lib/api';
	import { initializeAccessibilitySettings } from '$lib/accessibility';
	import { initializeAnimationPassSettings } from '$lib/animationPass';
	import { refreshBackendEndpointCandidates } from '$lib/backendEndpoints';
	import { startupMark, startupMeasure, startupScheduleReport } from '$lib/startupProfiler';
	import {
		applyHomeExperienceMode,
		getStoredHomeExperienceMode,
		normalizeHomeExperienceMode,
		setStoredHomeExperienceMode,
		type HomeExperienceMode
	} from '$lib/homeExperience';
	import { _ } from '$lib/i18n';
	import { brandName } from '$lib/branding';
	import { startDesktopHelperLifecycle, stopDesktopHelperService } from '$lib/desktopHelper';
	import { startFollowNotificationPoller } from '$lib/followNotifier';
	import { animationQuality } from '$lib/motion/animationQuality';
	import {
		getLocalWabiAccountKey,
		getSuggestedLocalWabiImportSourceAccount,
		hasHandledLocalWabiImportPrompt,
		markLocalWabiImportPromptHandled
	} from '$lib/localWabiAccounts';
	import {
		applyLocalWabiProfileImport,
		getLocalWabiProfileImportPreview
	} from '$lib/localWabiProfileImport';

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
	let pendingPostLoginProfileImportCheck = false;
	let showProfileImportPrompt = false;
	let profileImportPromptSourceKey = '';
	let profileImportPromptTargetKey = '';
	let profileImportPromptMessage = '';
	let perfToastVisible = false;
	let perfToastDismissed = false;

	// Phase 3 boot optimization: LayoutRouter (and the ~2.4 MB app world it
	// drags in) is loaded via dynamic import, taken only when a session exists
	// or login succeeds. The anonymous login path never downloads it.
	type LayoutRouterComponent = typeof import('$lib/components/LayoutRouter.svelte').default;
	let LayoutRouterCmp: LayoutRouterComponent | null = null;
	let layoutRouterPromise: Promise<unknown> | null = null;

	function ensureLayoutRouter(): Promise<unknown> {
		if (!layoutRouterPromise) {
			layoutRouterPromise = import('$lib/components/LayoutRouter.svelte').then((m) => {
				LayoutRouterCmp = m.default;
				return m;
			});
		}
		return layoutRouterPromise;
	}

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

	function seedBackendFailoverCache(): void {
		scheduleNonCritical(() => {
			void refreshBackendEndpointCandidates().catch((error) => {
				console.warn('[App] Failed to seed backend failover candidates:', error);
			});
		}, 250);
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
			if (e.ctrlKey && e.shiftKey && (e.key === 'O' || e.key === 'o')) {
				e.preventDefault();
				handleLogout();
			}
		};

		(async () => {
			startupMark('page:bootstrap:start');
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

			// One-time performance toast when weak GPU was auto-detected
			if (!$animationQuality.userOverride && $animationQuality.cssOnly) {
				scheduleNonCritical(() => {
					if (!disposed) {
						perfToastVisible = true;
					}
				}, 2000);
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
				
				pendingPostLoginProfileImportCheck = false;
				showProfileImportPrompt = false;
				profileImportPromptSourceKey = '';
				profileImportPromptTargetKey = '';
				profileImportPromptMessage = '';
				authStore.clearAuthError();
				authResetInFlight = false;
			});

			const savedUsername = getStoredUsername();
			const savedToken = getAuthToken();
			const savedGuestSessionId = getGuestSessionId();
			const hasSession = Boolean(savedToken || savedGuestSessionId);
			const hasLoggedInBefore = localStorage.getItem('wabi_has_logged_in') === 'true';

			// Server is the source of truth for first-user / no-owner state, but we
			// no longer BLOCK first paint on that roundtrip — awaiting it delayed
			// every boot (login page included) by a full API RTT behind the boot
			// shell. Decide locally from client hints now, then let the server
			// correct us when its response lands: a fresh/DB-reset server still
			// forces the registration wizard over any stale localStorage.
			const enterSetupWizard = () => {
				const bootTitle = document.getElementById('wabi-boot-title');
				if (bootTitle) bootTitle.textContent = 'Setting up Wabi';
				localStorage.removeItem('wabi_has_logged_in');
				disconnect();
				loggedIn = false;
				syncFollowNotificationPoller(false);
				clearStoredIdentity();
				clearAuthSession();
			};

			void getSetupStatus()
				.then((status) => {
					if (disposed) return;
					if (status?.setupRequired) {
						// This is the important part: server wins over localStorage.
						enterSetupWizard();
					}
				})
				.catch(() => {
					// Can't reach the server yet; client hints stand.
				});

			if (savedUsername && hasSession) {
				seedBackendFailoverCache();
				// Overlap the app-bundle download with the socket connect.
				void ensureLayoutRouter();
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
				// DM-strip 2026-06-16: initE2E + retryDecryptLoadedDmMessages removed. E2E
				// encryption was a DM-only concern; without DMs there's nothing to
				// encrypt. The startup marks are kept as no-ops so the rest of the
				// startup profiler instrumentation isn't affected.
				const dbUserId = getStoredDbUserId();
				if (dbUserId) {
					startupMark('page:e2e:init:start');
					startupMark('page:e2e:init:end');
					startupMeasure('page:e2e:init', 'page:e2e:init:start', 'page:e2e:init:end');
				}
			} else if (hasLoggedInBefore) {
				// Returning user but offline — enter reconnect mode.
				// Don't show login. Stay in boot shell with retry.
				window.dispatchEvent(new CustomEvent('wabi:boot-reconnect'));

				let reconnectAttempts = 0;
				const maxReconnectAttempts = 10;
				const probeReconnect = () => {
					reconnectAttempts++;
					const token = getAuthToken();
					if (token) {
						fetch(`${getApiBase()}/api/user/me`, {
							headers: { 'Authorization': `Bearer ${token}` },
							signal: AbortSignal.timeout(5000)
						}).then((res) => {
							if (res.ok && !disposed) {
								clearInterval(reconnectTimer);
								void ensureLayoutRouter();
								loggedIn = true;
								initSocket(savedUsername, token);
								syncFollowNotificationPoller(true);
								applyHomeExperienceMode(getStoredHomeExperienceMode());
								dismissDocumentBootShell();
							}
						}).catch(() => {});
					}
					if (reconnectAttempts >= maxReconnectAttempts) {
						clearInterval(reconnectTimer);
					}
				};
				let reconnectTimer = setInterval(probeReconnect, 3000);
				// Phase 6 nit: probe immediately instead of waiting a full 3 s
				// for the first interval tick.
				probeReconnect();

				const onReconnect = () => {
					clearInterval(reconnectTimer);
					void ensureLayoutRouter();
					loggedIn = true;
					isBootstrapping = false;
					dismissDocumentBootShell();
				};
				window.addEventListener('wabi:work-offline', onReconnect, { once: true });

				// Not used until destroy, but store for cleanup.
				// No additional cleanup needed since we use 'once: true'.
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
			// Hold the boot shell until the app module can actually render — but
			// ONLY on the session path. An anonymous visitor must never download
			// LayoutRouter (that's the whole point of this phase); Login renders
			// immediately for them.
			if (savedUsername && hasSession) {
				startupMark('page:layout-module:await:start');
				try {
					await Promise.race([
						ensureLayoutRouter(),
						new Promise((resolve) => setTimeout(resolve, 10_000)) // never trap the user on the boot shell
					]);
				} finally {
					startupMark('page:layout-module:await:end');
					startupMeasure('page:layout-module', 'page:layout-module:await:start', 'page:layout-module:await:end');
				}
			}
			isBootstrapping = false;
			dismissDocumentBootShell();
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
		joinChannel($dmPanelSignal.channelId);
		dmPanelSignal.set(null);
	}

	$: if (pendingPostLoginProfileImportCheck && $currentUser?.dbUserId) {
		const targetKey = getLocalWabiAccountKey($currentUser);
		if (!targetKey) {
			pendingPostLoginProfileImportCheck = false;
		} else if (hasHandledLocalWabiImportPrompt(targetKey)) {
			pendingPostLoginProfileImportCheck = false;
		} else {
			const suggestedSource = getSuggestedLocalWabiImportSourceAccount(targetKey);
			const preview = suggestedSource
				? getLocalWabiProfileImportPreview(suggestedSource.key, $currentUser)
				: null;
			if (preview?.canImport) {
				profileImportPromptSourceKey = preview.source.key;
				profileImportPromptTargetKey = preview.targetKey;
				profileImportPromptMessage =
					`Import your display name and profile picture from ${preview.sourceLabel}? ` +
					`If the display name is unavailable on this server, ${brandName} will still try the picture.`;
				showProfileImportPrompt = true;
			}
			pendingPostLoginProfileImportCheck = false;
		}
	}

	async function handleLogin(event: CustomEvent<{ username: string; token?: string; authMethod: 'guest' | 'registered'; homeExperience?: HomeExperienceMode; mustChangePassword?: boolean }>) {
		// Start the app-bundle download immediately — it overlaps socket
		// connect + theme init while Login stays visible and interactive.
		void ensureLayoutRouter();
		const { username, token, authMethod, homeExperience, mustChangePassword } = event.detail;
		setStoredUsername(username);

		if (token) {
			setAuthToken(token);
		}

		seedBackendFailoverCache();
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
		pendingPostLoginProfileImportCheck = isRegistered;
	}

	function openAccountSecurityFromTempPasswordPrompt() {
		showTempPasswordPrompt = false;
		accountSecurityOpenRequest += 1;
	}

	function handleLogout() {
		disconnect();
		syncFollowNotificationPoller(false);
		void stopDesktopHelperService(true);
		
		loggedIn = false;
		showTempPasswordPrompt = false;
		pendingPostLoginProfileImportCheck = false;
		showProfileImportPrompt = false;
		profileImportPromptSourceKey = '';
		profileImportPromptTargetKey = '';
		profileImportPromptMessage = '';
		localStorage.removeItem('wabi_has_logged_in');
		clearStoredIdentity();
		clearAuthSession();
		// Finding 5: drop SW media cache so uploads don't outlive the session
		if (typeof caches !== 'undefined') {
			void caches.keys().then((keys) =>
				Promise.all(
					keys
						.filter((k) => k === 'media-cache-v1' || k === 'media-cache-v2' || k.startsWith('media-cache-'))
						.map((k) => caches.delete(k))
				)
			).catch(() => {});
		}
	}

	async function confirmProfileImportPrompt(): Promise<void> {
		const targetKey = profileImportPromptTargetKey;
		const sourceKey = profileImportPromptSourceKey;
		showProfileImportPrompt = false;
		profileImportPromptSourceKey = '';
		profileImportPromptTargetKey = '';
		profileImportPromptMessage = '';
		markLocalWabiImportPromptHandled(targetKey);
		const result = await applyLocalWabiProfileImport(sourceKey);
		if (!result.success) {
			showToast(result.errors.join(' ') || 'Profile import did not complete.', 'error');
			return;
		}
		const importedSummary = result.importedFields.join(' and ');
		showToast(`Imported ${importedSummary}.`, 'info');
	}

	function cancelProfileImportPrompt(): void {
		markLocalWabiImportPromptHandled(profileImportPromptTargetKey);
		showProfileImportPrompt = false;
		profileImportPromptSourceKey = '';
		profileImportPromptTargetKey = '';
		profileImportPromptMessage = '';
	}
</script>

{#if !isBootstrapping}
	<!-- Performance auto-detect toast -->
	{#if perfToastVisible}
		<div class="perf-toast" role="status" aria-live="polite">
			<span class="perf-toast-icon">⚡</span>
			<span class="perf-toast-msg">
				<strong>Performance mode enabled</strong> — We detected a weak GPU and auto-enabled CSS animations and disabled new windows.
				You can adjust these in <button class="perf-toast-link" on:click={() => { perfToastDismissed = true; window.dispatchEvent(new CustomEvent('wabi:open-settings', { detail: 'appearance' })); }}>Settings → Appearance</button>.
			</span>
			<button class="perf-toast-close" on:click={() => { perfToastVisible = false; perfToastDismissed = true; }} aria-label="Dismiss">×</button>
		</div>
	{/if}
	{#if !loggedIn || !LayoutRouterCmp}
		<!-- Login path: also covers the brief loggedIn-but-module-still-loading window -->
		{#if isInitialLoad}
			<Login on:login={handleLogin} />
		{:else}
			<div transition:fade={{ duration: 300 }}>
				<Login on:login={handleLogin} />
			</div>
		{/if}
	{:else}
		{#if isInitialLoad}
			<svelte:component this={LayoutRouterCmp} accountSecurityOpenRequest={accountSecurityOpenRequest} on:logout={handleLogout} />
		{:else}
			<div transition:fade={{ duration: 300 }}>
				<svelte:component this={LayoutRouterCmp} accountSecurityOpenRequest={accountSecurityOpenRequest} on:logout={handleLogout} />
			</div>
		{/if}
	{/if}
	{#if loggedIn}
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
		<ConfirmDialog
			isOpen={showProfileImportPrompt}
			title="Import Profile"
			message={profileImportPromptMessage}
			confirmText="Import"
			cancelText="Later"
			variant="info"
			onConfirm={confirmProfileImportPrompt}
			onCancel={cancelProfileImportPrompt}
		/>
	{/if}
{/if}

<style>
	.perf-toast {
		position: fixed;
		bottom: 1rem;
		left: 50%;
		transform: translateX(-50%);
		z-index: var(--z-toast, 1500);
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.75rem 1rem;
		background: var(--bg-elevated, #1e1e2e);
		border: 1px solid var(--border-subtle, #3a3a4a);
		border-radius: 0.5rem;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
		max-width: min(90vw, 28rem);
		font-size: 0.8125rem;
		line-height: 1.4;
		color: var(--text-heading, #e0e0e0);
	}
	.perf-toast-icon {
		flex-shrink: 0;
		font-size: 1rem;
	}
	.perf-toast-msg {
		flex: 1;
	}
	.perf-toast-msg strong {
		color: var(--text-heading, #e0e0e0);
	}
	.perf-toast-link {
		background: none;
		border: none;
		padding: 0;
		color: var(--accent, #7c6af5);
		cursor: pointer;
		font-size: inherit;
		text-decoration: underline;
	}
	.perf-toast-close {
		flex-shrink: 0;
		background: none;
		border: none;
		padding: 0 0 0 0.25rem;
		color: var(--text-secondary, #a0a0a0);
		cursor: pointer;
		font-size: 1.125rem;
		line-height: 1;
	}
	.perf-toast-close:hover {
		color: var(--text-heading, #e0e0e0);
	}
</style>
