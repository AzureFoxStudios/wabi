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
	<h3>Chat</h3>
	<div class="settings-group-card">
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Avatars</span>
				<span class="setting-description">In message list.</span>
			</div>
			<select class="theme-select" value={chatAvatarMode} on:change={(e) => updateChatAvatarMode(e.currentTarget.value as ChatAvatarMode)}>
				<option value="off">Off</option>
				<option value="user">Others only</option>
				<option value="all">Everyone</option>
			</select>
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Density</span>
				<span class="setting-description">Spacing density.</span>
			</div>
			<div class="density-toggle">
				<button type="button" class="density-btn" class:active={messageDensity === 'cozy'} on:click={() => updateMessageDensity('cozy')}>Default</button>
				<button type="button" class="density-btn" class:active={messageDensity === 'compact'} on:click={() => updateMessageDensity('compact')}>Compact</button>
			</div>
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Own messages right</span>
				<span class="setting-description">Your bubbles on the right.</span>
			</div>
			<button class="toggle-btn" class:active={ownMessagesOnRight} on:click={toggleOwnMessagesOnRight} aria-label="Own messages on right"></button>
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Send button</span>
				<span class="setting-description">Composer send control.</span>
			</div>
			<button class="toggle-btn" class:active={clickableSendEnabled} on:click={toggleClickableSendEnabled} aria-label="Clickable send button"></button>
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Deletion timer</span>
				<span class="setting-description">Expiring-message countdown.</span>
			</div>
			<select class="theme-select" value={deletionCountdownMode} on:change={(e) => updateDeletionCountdownMode(e.currentTarget.value as DeletionCountdownMode)}>
				<option value="off">Off</option>
				<option value="static">Static</option>
				<option value="live">Live</option>
			</select>
		</div>
	</div>
</div>

<div class="settings-section">
	<h3>Layout</h3>
	<div class="settings-group-card">
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Home view</span>
				<span class="setting-description">Default home focus.</span>
			</div>
			<select class="theme-select" value={homeExperienceMode} on:change={(e) => updateHomeExperienceMode(e.currentTarget.value as HomeExperienceMode)}>
				<option value="conversations">Conversations</option>
				<option value="community">Community</option>
			</select>
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Nav dock</span>
				<span class="setting-description">Dock side.</span>
			</div>
			<select class="theme-select" value={$layoutStore.navDock} on:change={(e) => updateDockSide(e.currentTarget.value as 'left' | 'right')}>
				<option value="left">Left</option>
				<option value="right">Right</option>
			</select>
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Conversation layout</span>
				<span class="setting-description">Visible rails.</span>
			</div>
			<select class="theme-select" value={$homeLayout} on:change={(e) => updateHomeLayoutMode(e.currentTarget.value as HomeLayoutMode)}>
				<option value="server-browser">Full rails</option>
				<option value="dm-focused">Hide server rail</option>
				<option value="dm-pure">DMs only</option>
			</select>
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Collapse nav</span>
				<span class="setting-description">Fold dock.</span>
			</div>
			<button class="toggle-btn" class:active={$layoutStore.isNavCollapsed} on:click={toggleDockNavCollapsed} aria-label="Collapse navigation"></button>
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Layout preset</span>
				<span class="setting-description">Saved layouts.</span>
			</div>
			<select class="theme-select" value={$layoutStore.activeWorkspace} on:change={(e) => loadWorkspaceByName(e.currentTarget.value)}>
				{#each $layoutStore.workspaces as workspaceName}
					<option value={workspaceName}>{workspaceName}</option>
				{/each}
			</select>
		</div>
		<div class="setting-item-full">
			<div class="settings-row-actions">
				<button type="button" class="action-btn" on:click={saveWorkspaceAsPrompt}>Save as…</button>
				<button type="button" class="action-btn secondary" on:click={renameWorkspacePrompt}>Rename…</button>
				<button type="button" class="action-btn danger" on:click={resetActiveWorkspace}>Reset</button>
			</div>
			<div class="settings-row-actions">
				<button type="button" class="action-btn secondary" on:click={exportWorkspaceJson}>Export JSON</button>
				<button type="button" class="action-btn secondary" on:click={importWorkspaceJsonPrompt}>Import JSON</button>
			</div>
		</div>
		<div class="setting-item setting-item-stack">
			<div class="setting-info">
				<span class="setting-label">Chrome opacity (desktop)</span>
				<span class="setting-description">{Math.round(appChromeOpacity * 100)}% panel alpha.</span>
			</div>
			<input type="range" min="0.2" max="1" step="0.05" bind:value={appChromeOpacity} on:input={(e) => updateAppChromeOpacity(parseFloat(e.currentTarget.value))} class="volume-slider" />
		</div>
	</div>
</div>

<div class="settings-section">
	<h3>Media</h3>
	<div class="settings-group-card">
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Video compression ({videoCompressionRuntimeLabel})</span>
				<span class="setting-description">Compress large uploads.</span>
			</div>
			<button class="toggle-btn" class:active={videoCompressionEnabled} on:click={toggleVideoCompressionEnabled} aria-label="Video compression"></button>
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Default preset</span>
				<span class="setting-description">Upload dialog default.</span>
			</div>
			<select class="theme-select" value={defaultVideoCompressionPreset} on:change={(e) => updateVideoCompressionPreset(e.currentTarget.value as VideoCompressionPresetId)} disabled={!videoCompressionEnabled}>
				{#each videoCompressionPresetOptions as presetOption}
					<option value={presetOption.id}>{presetOption.label}</option>
				{/each}
			</select>
		</div>
		{#if selectedVideoCompressionPresetOption && videoCompressionEnabled}
			<div class="runtime-note" style="padding:0.25rem 0.1rem 0.55rem">{selectedVideoCompressionPresetOption.description}</div>
		{/if}
	</div>
</div>

<div class="settings-section">
	<h3>Theme</h3>
	<div class="setting-item-full" style="padding:0;border:0;background:transparent;box-shadow:none">
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
	<div class="customizer-container settings-customizer-slot">
		<ThemeCustomizer />
	</div>
</div>

<div class="settings-section">
	<div class="customizer-container settings-customizer-slot">
		<UniformFontMode />
	</div>
	<div class="customizer-container settings-customizer-slot">
		<EffectsTab />
	</div>
</div>

<div class="settings-section">
	<h3>Performance</h3>
	<div class="settings-group-card">
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">CSS animations</span>
				<span class="setting-description">
					CSS instead of springs.
					{#if $animationQuality.cssOnly && !$animationQuality.userOverride}
						<span class="auto-badge">Auto</span>
					{/if}
				</span>
			</div>
			<button
				class="toggle-btn"
				class:active={$animationQuality.cssOnly}
				on:click={() => animationQuality.setCssOnly(!$animationQuality.cssOnly)}
				aria-pressed={$animationQuality.cssOnly}
				aria-label="CSS animations"
			></button>
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Disable new windows</span>
				<span class="setting-description">
					No pop-out panels.
					{#if $animationQuality.disableWindows && !$animationQuality.userOverride}
						<span class="auto-badge">Auto</span>
					{/if}
				</span>
			</div>
			<button
				class="toggle-btn"
				class:active={$animationQuality.disableWindows}
				on:click={() => animationQuality.setDisableWindows(!$animationQuality.disableWindows)}
				aria-pressed={$animationQuality.disableWindows}
				aria-label="Disable new windows"
			></button>
		</div>
		{#if !$animationQuality.userOverride}
			<div class="runtime-note" style="padding: 0.35rem 0.1rem">
				Device tier: <strong>{$animationQuality.tier}</strong> — auto-tuned. Toggle above to take control.
			</div>
		{/if}
	</div>
</div>

