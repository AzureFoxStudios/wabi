<script lang="ts">
	import { onMount } from 'svelte';
	import { _ as t } from '$lib/i18n';
	import { brandName } from '$lib/branding';
	import { getAuthToken } from '$lib/authSession';
	import { saveUserSettings } from '$lib/api';
	import ThemeCustomizer from '../ThemeCustomizer.svelte';
	import UniformFontMode from '../UniformFontMode.svelte';
	import EffectsTab from '$lib/effects/EffectsTab.svelte';
	import { layoutStore } from '$lib/layoutStore';
	import { homeLayout, type HomeLayoutMode } from '$lib/layoutStoreStates';
	import { animationQuality } from '$lib/motion/animationQuality';
	import { themeStore } from '$lib/theme/themeStore';
	import { THEMES } from '$lib/theme/themes';
	import { saveThemePreferences } from '$lib/theme/themeApi';
	import { saveThemeToLocalStorage } from '$lib/theme/themeManager';
	import {
		applyHomeExperienceMode,
		getStoredHomeExperienceMode,
		setStoredHomeExperienceMode,
		type HomeExperienceMode
	} from '$lib/homeExperience';
	import {
		getStoredAccessibilitySettings,
		updateAccessibilitySettings,
		type ChatAvatarMode,
		type DeletionCountdownMode,
		type MessageDensity
	} from '$lib/accessibility';
	import { getTauriPlatform } from '$lib/tauri-platform';
	import { isTauriRuntime } from '$lib/mediaRuntime';
	import type { VideoCompressionPresetId } from '$lib/video/videoCompressor';
	import {
		getDefaultVideoCompressionPreset,
		getVideoCompressionPresetOptions,
		getVideoCompressionRuntimeProfile,
		isVideoCompressionEnabled,
		setDefaultVideoCompressionPreset,
		setVideoCompressionEnabled,
		type VideoCompressionPresetOption,
		type VideoCompressionRuntime
	} from '$lib/video/videoCompressionSettings';

	let savingTheme = false;
	let ownMessagesOnRight = false;
	let homeExperienceMode: HomeExperienceMode = 'community';
	let chatAvatarMode: ChatAvatarMode = 'all';
	let appChromeOpacity = 1;
	let videoCompressionEnabled = true;
	let videoCompressionRuntime: VideoCompressionRuntime = 'desktop';
	let videoCompressionRuntimeLabel = 'Desktop';
	let videoCompressionPresetOptions: VideoCompressionPresetOption[] =
		getVideoCompressionPresetOptions('desktop');
	let selectedVideoCompressionPresetOption: VideoCompressionPresetOption | null = null;
	let defaultVideoCompressionPreset: VideoCompressionPresetId = 'balanced_720p';
	let messageDensity: MessageDensity = 'cozy';
	let deletionCountdownMode: DeletionCountdownMode = 'static';
	let clickableSendEnabled = true;

	$: selectedVideoCompressionPresetOption =
		videoCompressionPresetOptions.find((option) => option.id === defaultVideoCompressionPreset) || null;

	onMount(() => {
		const accessibilitySettings = getStoredAccessibilitySettings();
		ownMessagesOnRight = accessibilitySettings.ownMessagesOnRight;
		homeExperienceMode = getStoredHomeExperienceMode();
		chatAvatarMode = accessibilitySettings.chatAvatarMode;
		appChromeOpacity = accessibilitySettings.appChromeOpacity;
		messageDensity = accessibilitySettings.messageDensity;
		deletionCountdownMode = accessibilitySettings.deletionCountdownMode;
		clickableSendEnabled = accessibilitySettings.clickableSendEnabled;
		videoCompressionEnabled = isVideoCompressionEnabled();
		applyVideoCompressionRuntimePreferences();
		loadHomeExperienceFromServer();
	});

	function resolveVideoCompressionRuntimeScope(): VideoCompressionRuntime {
		if (!isTauriRuntime()) return 'desktop';
		const runtime = getTauriPlatform();
		if (runtime === 'android' || runtime === 'ios' || runtime === 'desktop') {
			return runtime;
		}
		return 'desktop';
	}

	function applyVideoCompressionRuntimePreferences(): void {
		videoCompressionRuntime = resolveVideoCompressionRuntimeScope();
		const profile = getVideoCompressionRuntimeProfile(videoCompressionRuntime);
		videoCompressionRuntimeLabel = profile.label;
		videoCompressionPresetOptions = getVideoCompressionPresetOptions(videoCompressionRuntime);
		const storedPreset = getDefaultVideoCompressionPreset(videoCompressionRuntime);
		const presetAllowed = videoCompressionPresetOptions.some((option) => option.id === storedPreset);
		const resolvedPreset = presetAllowed ? storedPreset : profile.recommendedPreset;
		defaultVideoCompressionPreset = resolvedPreset;
		if (resolvedPreset !== storedPreset) {
			setDefaultVideoCompressionPreset(resolvedPreset, videoCompressionRuntime);
		}
	}

	async function loadHomeExperienceFromServer(): Promise<void> {
		const token = getAuthToken();
		if (!token) return;
		try {
			const { getUserSettings } = await import('$lib/api');
			const settings = await getUserSettings(token);
			if (!settings?.home_experience) return;
			homeExperienceMode = settings.home_experience === 'conversations' ? 'conversations' : 'community';
			setStoredHomeExperienceMode(homeExperienceMode);
		} catch (error) {
			console.warn('[Settings] Failed to load home experience mode:', error);
		}
	}

	async function handleThemeChange(themeId: string) {
		try {
			savingTheme = true;
			themeStore.setThemeId(themeId);

			if (getAuthToken()) {
				await saveThemePreferences({ theme_id: themeId });
			} else {
				saveThemeToLocalStorage(themeId);
			}
		} catch (error) {
			console.error('[Settings] Failed to save theme:', error);
			alert('Failed to save theme preferences. Please try again.');
		} finally {
			savingTheme = false;
		}
	}

	function toggleOwnMessagesOnRight() {
		const next = updateAccessibilitySettings({ ownMessagesOnRight: !ownMessagesOnRight });
		ownMessagesOnRight = next.ownMessagesOnRight;
	}

	function updateChatAvatarMode(mode: ChatAvatarMode) {
		const next = updateAccessibilitySettings({ chatAvatarMode: mode });
		chatAvatarMode = next.chatAvatarMode;
	}

	function updateAppChromeOpacity(value: number) {
		const next = updateAccessibilitySettings({ appChromeOpacity: value });
		appChromeOpacity = next.appChromeOpacity;
	}

	function toggleVideoCompressionEnabled() {
		videoCompressionEnabled = !videoCompressionEnabled;
		setVideoCompressionEnabled(videoCompressionEnabled);
	}

	function updateVideoCompressionPreset(value: VideoCompressionPresetId) {
		defaultVideoCompressionPreset = value;
		setDefaultVideoCompressionPreset(value, videoCompressionRuntime);
	}

	function updateMessageDensity(value: MessageDensity) {
		const next = updateAccessibilitySettings({ messageDensity: value });
		messageDensity = next.messageDensity;
	}

	function updateDeletionCountdownMode(mode: DeletionCountdownMode) {
		const next = updateAccessibilitySettings({ deletionCountdownMode: mode });
		deletionCountdownMode = next.deletionCountdownMode;
	}

	function toggleClickableSendEnabled() {
		const next = updateAccessibilitySettings({ clickableSendEnabled: !clickableSendEnabled });
		clickableSendEnabled = next.clickableSendEnabled;
	}

	function updateDockSide(side: 'left' | 'right') {
		layoutStore.setNavDock(side);
	}

	function updateHomeLayoutMode(mode: HomeLayoutMode) {
		homeLayout.set(mode);
	}

	function toggleDockNavCollapsed() {
		layoutStore.toggleNavCollapsed();
	}

	async function updateHomeExperienceMode(mode: HomeExperienceMode) {
		homeExperienceMode = mode;
		setStoredHomeExperienceMode(mode);
		applyHomeExperienceMode(mode);

		const token = getAuthToken();
		if (!token) return;

		try {
			await saveUserSettings(token, { home_experience: mode });
		} catch (error) {
			console.warn('[Settings] Failed to save home experience mode:', error);
		}
	}



	function loadWorkspaceByName(name: string) {
		layoutStore.loadWorkspace(name);
	}

	function saveWorkspaceAsPrompt() {
		const suggested = `${$layoutStore.activeWorkspace}-copy`;
		const name = window.prompt('Save layout as', suggested);
		if (!name) return;
		layoutStore.saveWorkspace(name);
	}

	function renameWorkspacePrompt() {
		const current = $layoutStore.activeWorkspace;
		const nextName = window.prompt('Rename layout', current);
		if (!nextName) return;
		layoutStore.renameWorkspace(current, nextName);
	}

	function resetActiveWorkspace() {
		layoutStore.resetWorkspace($layoutStore.activeWorkspace);
	}

	async function exportWorkspaceJson() {
		const json = layoutStore.exportLayoutJson();
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(json);
			alert('Layout JSON copied to clipboard.');
			return;
		}
		window.prompt('Copy layout JSON:', json);
	}

	function importWorkspaceJsonPrompt() {
		const pasted = window.prompt('Paste layout JSON');
		if (!pasted) return;
		const ok = layoutStore.importLayoutJson(pasted);
		if (!ok) {
			alert('Invalid layout JSON.');
		}
	}
</script>

<div class="settings-section">
	<h3>{$t('settings.sections.appearance')}</h3>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Chat Avatars</span>
			<span class="setting-description">Choose how profile pictures are shown in chat</span>
		</div>
		<select class="theme-select" value={chatAvatarMode} on:change={(e) => updateChatAvatarMode(e.currentTarget.value as ChatAvatarMode)}>
			<option value="off">Off</option>
			<option value="user">User Only (Others)</option>
			<option value="all">All</option>
		</select>
	</div>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Home View</span>
			<span class="setting-description">Choose whether {brandName} opens focused on conversations or the community panel</span>
		</div>
		<select class="theme-select" value={homeExperienceMode} on:change={(e) => updateHomeExperienceMode(e.currentTarget.value as HomeExperienceMode)}>
			<option value="conversations">Conversation-first</option>
			<option value="community">Community-first</option>
		</select>
	</div>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Message Display</span>
			<span class="setting-description">Default keeps avatars with Discord-like group spacing; Compact removes avatars for dense chat</span>
		</div>
		<div class="density-toggle">
			<button type="button" class="density-btn" class:active={messageDensity === 'cozy'} on:click={() => updateMessageDensity('cozy')}>Default</button>
			<button type="button" class="density-btn" class:active={messageDensity === 'compact'} on:click={() => updateMessageDensity('compact')}>Compact</button>
		</div>
	</div>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Message Deletion Timer</span>
			<span class="setting-description">Show timers only in the last hour: Off, Static snapshot, or Live countdown</span>
		</div>
		<select class="theme-select" value={deletionCountdownMode} on:change={(e) => updateDeletionCountdownMode(e.currentTarget.value as DeletionCountdownMode)}>
			<option value="off">Off</option>
			<option value="static">General Countdown</option>
			<option value="live">Live Countdown</option>
		</select>
	</div>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Clickable Send Button</span>
			<span class="setting-description">Show the paper-plane send button next to the composer</span>
		</div>
		<button class="toggle-btn" class:active={clickableSendEnabled} on:click={toggleClickableSendEnabled}>
			{clickableSendEnabled ? 'ON' : 'OFF'}
		</button>
	</div>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Own Messages on Right</span>
			<span class="setting-description">Align your messages to the right side of chat</span>
		</div>
		<button class="toggle-btn" class:active={ownMessagesOnRight} on:click={toggleOwnMessagesOnRight}>
			{ownMessagesOnRight ? 'ON' : 'OFF'}
		</button>
	</div>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Navigation Dock Side</span>
			<span class="setting-description">Choose whether the navigation module is docked left or right</span>
		</div>
		<select class="theme-select" value={$layoutStore.navDock} on:change={(e) => updateDockSide(e.currentTarget.value as 'left' | 'right')}>
			<option value="left">Left</option>
			<option value="right">Right</option>
		</select>
	</div>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Conversation Layout</span>
			<span class="setting-description">Choose which navigation rails stay visible. This preference is saved on this device.</span>
		</div>
		<select class="theme-select" value={$homeLayout} on:change={(e) => updateHomeLayoutMode(e.currentTarget.value as HomeLayoutMode)}>
			<option value="server-browser">Full — server rail and channel sidebar</option>
			<option value="dm-focused">Focus — hide the server rail</option>
			<option value="dm-pure">DMs Only — hide both navigation rails</option>
		</select>
	</div>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Navigation Collapse</span>
			<span class="setting-description">Collapse or expand the navigation dock</span>
		</div>
		<button class="toggle-btn" class:active={$layoutStore.isNavCollapsed} on:click={toggleDockNavCollapsed}>
			{$layoutStore.isNavCollapsed ? 'COLLAPSED' : 'EXPANDED'}
		</button>
	</div>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Layout Preset</span>
			<span class="setting-description">Load or save docking layouts for different workflows</span>
		</div>
		<select class="theme-select" value={$layoutStore.activeWorkspace} on:change={(e) => loadWorkspaceByName(e.currentTarget.value)}>
			{#each $layoutStore.workspaces as workspaceName}
				<option value={workspaceName}>{workspaceName}</option>
			{/each}
		</select>
	</div>

	

	<div class="setting-item-full">
		<div class="settings-row-actions">
			<button type="button" class="action-btn" on:click={saveWorkspaceAsPrompt}>Save Layout As...</button>
			<button type="button" class="action-btn secondary" on:click={renameWorkspacePrompt}>Rename Layout...</button>
			<button type="button" class="action-btn danger" on:click={resetActiveWorkspace}>Reset Layout</button>
		</div>
		<div class="settings-row-actions">
			<button type="button" class="action-btn secondary" on:click={exportWorkspaceJson}>Export Layout JSON</button>
			<button type="button" class="action-btn secondary" on:click={importWorkspaceJsonPrompt}>Import Layout JSON</button>
		</div>
	</div>

	<div class="setting-item setting-item-stack">
		<div class="setting-info">
			<span class="setting-label">Window Chrome Opacity (Tauri)</span>
			<span class="setting-description">
				Make UI panels transparent while keeping text readable ({Math.round(appChromeOpacity * 100)}%)
			</span>
		</div>
		<input type="range" min="0.2" max="1" step="0.05" bind:value={appChromeOpacity} on:input={(e) => updateAppChromeOpacity(parseFloat(e.currentTarget.value))} class="volume-slider" />
	</div>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Video Compression ({videoCompressionRuntimeLabel})</span>
			<span class="setting-description">
				Prompt to compress large videos before upload with runtime-specific safety limits.
			</span>
		</div>
		<button class="toggle-btn" class:active={videoCompressionEnabled} on:click={toggleVideoCompressionEnabled}>
			{videoCompressionEnabled ? 'ON' : 'OFF'}
		</button>
	</div>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Default Compression Preset</span>
			<span class="setting-description">Used by the upload compression dialog for large videos</span>
		</div>
		<select class="theme-select" value={defaultVideoCompressionPreset} on:change={(e) => updateVideoCompressionPreset(e.currentTarget.value as VideoCompressionPresetId)} disabled={!videoCompressionEnabled}>
			{#each videoCompressionPresetOptions as presetOption}
				<option value={presetOption.id}>{presetOption.label}</option>
			{/each}
		</select>
		{#if selectedVideoCompressionPresetOption}
			<div class="runtime-note">{selectedVideoCompressionPresetOption.description}</div>
		{/if}
	</div>

	<div class="setting-item-full">
		<div class="setting-info">
			<span class="setting-label">Theme</span>
			<span class="setting-description">Choose your preferred theme</span>
		</div>
		<div class="theme-cards">
			{#each Object.values(THEMES) as theme}
				<button type="button" class="theme-card" class:active={$themeStore.themeId === theme.id} on:click={() => handleThemeChange(theme.id)} disabled={savingTheme} title={theme.description}>
					<div class="theme-card-preview" style="background: {theme.colors.bgSecondary};">
						<div class="theme-preview-top" style="background: {theme.colors.bgTertiary};"></div>
						<div class="theme-preview-content">
							<div class="theme-preview-bar long" style="background: {theme.colors.textPrimary}; opacity: 0.55;"></div>
							<div class="theme-preview-bar short" style="background: {theme.colors.textSecondary}; opacity: 0.4;"></div>
							<div class="theme-preview-accent" style="background: {theme.colors.accentHex};"></div>
						</div>
					</div>
					<div class="theme-card-footer">
						<span class="theme-card-name">{theme.name}</span>
						{#if $themeStore.themeId === theme.id}<span class="theme-card-badge">&#10003;</span>{/if}
					</div>
				</button>
			{/each}
		</div>
	</div>
	{#if savingTheme}
		<div class="save-indicator"><span class="spinner">...</span> Saving theme...</div>
	{/if}

	<div class="customizer-container">
		<ThemeCustomizer />
	</div>

	<div class="customizer-container">
		<UniformFontMode />
	</div>

	<div class="customizer-container">
		<EffectsTab />
	</div>

	<div class="settings-subsection">
		<h4 class="subsection-label">Performance</h4>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Use CSS animations</span>
				<span class="setting-description">
					Replace spring physics with simple CSS transitions. Reduces GPU load on weaker devices.
					{#if $animationQuality.cssOnly && !$animationQuality.userOverride}
						<span class="auto-badge">Auto-enabled</span>
					{/if}
				</span>
			</div>
			<button class="toggle-btn" class:active={$animationQuality.cssOnly} on:click={() => animationQuality.setCssOnly(!$animationQuality.cssOnly)} aria-pressed={$animationQuality.cssOnly}>
				{$animationQuality.cssOnly ? 'ON' : 'OFF'}
			</button>
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Disable new windows</span>
				<span class="setting-description">
					Blocks opening panels in separate windows. Reduces GPU compositor load on weaker devices.
					{#if $animationQuality.disableWindows && !$animationQuality.userOverride}
						<span class="auto-badge">Auto-enabled</span>
					{/if}
				</span>
			</div>
			<button class="toggle-btn" class:active={$animationQuality.disableWindows} on:click={() => animationQuality.setDisableWindows(!$animationQuality.disableWindows)} aria-pressed={$animationQuality.disableWindows}>
				{$animationQuality.disableWindows ? 'ON' : 'OFF'}
			</button>
		</div>
		{#if !$animationQuality.userOverride}
			<div class="setting-item">
				<div class="setting-info">
					<span class="setting-label">Detected device tier</span>
					<span class="setting-description">{$animationQuality.tier} - settings were auto-adjusted. Toggle any option above to take manual control.</span>
				</div>
				<button class="action-btn small" on:click={() => animationQuality.resetToAuto()}>Reset to auto</button>
			</div>
		{/if}
	</div>
</div>
