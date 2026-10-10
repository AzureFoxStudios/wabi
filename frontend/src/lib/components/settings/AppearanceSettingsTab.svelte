<script lang="ts">
	import { onMount } from 'svelte';
	import { _ as t } from '$lib/i18n';
	import { getAuthToken } from '$lib/authSession';
	import ThemeCustomizer from '../ThemeCustomizer.svelte';
	import BackgroundImageEditor from '../BackgroundImageEditor.svelte';
	import UniformFontMode from '../UniformFontMode.svelte';
	import EffectsTab from '$lib/effects/EffectsTab.svelte';
	import ProfileAppearanceControls from '$lib/components/ProfileAppearanceControls.svelte';
	import PointerEffectsTab from '$lib/effects/PointerEffectsTab.svelte';
	import { layoutStore } from '$lib/layoutStore';
	import { railPeekKey, type RailPeekKey } from '$lib/railPrefs';
	import { dockStackLimit, MAX_DOCK_STACK_LIMIT } from '$lib/layoutStoreStates';
	import {
		homeLayout,
		type HomeLayoutMode,
		railDensity,
		railSide,
		type RailDensity,
		type RailSide
	} from '$lib/layoutStoreStates';
	import { animationQuality } from '$lib/motion/animationQuality';
	import { themeStore } from '$lib/theme/themeStore';
	import { THEMES } from '$lib/theme/themes';
	import { saveThemePreferences } from '$lib/theme/themeApi';
	import { saveThemeToLocalStorage } from '$lib/theme/themeManager';
	import { getOpeningSurface, setOpeningSurface, type OpeningSurface } from '$lib/openingSurface';
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
	let openingSurface: OpeningSurface = 'last-channel';
	let showAllThemes = false;
	let nativeApp = false;
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
	let showAdvanced = false;

	$: selectedVideoCompressionPresetOption =
		videoCompressionPresetOptions.find((option) => option.id === defaultVideoCompressionPreset) || null;

	onMount(() => {
		nativeApp = isTauriRuntime();
		const accessibilitySettings = getStoredAccessibilitySettings();
		ownMessagesOnRight = accessibilitySettings.ownMessagesOnRight;
		openingSurface = getOpeningSurface();
		chatAvatarMode = accessibilitySettings.chatAvatarMode;
		appChromeOpacity = accessibilitySettings.appChromeOpacity;
		messageDensity = accessibilitySettings.messageDensity;
		deletionCountdownMode = accessibilitySettings.deletionCountdownMode;
		clickableSendEnabled = accessibilitySettings.clickableSendEnabled;
		videoCompressionEnabled = isVideoCompressionEnabled();
		applyVideoCompressionRuntimePreferences();
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

	function updateOpeningSurface(surface: OpeningSurface) {
		openingSurface = surface;
		setOpeningSurface(surface);
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

	// Plain-words explanation of the auto-detected device tier (weak | mid | capable).
	function getDeviceTierLabel(tier: string | undefined): string {
		switch (tier) {
			case 'weak':
				return 'low-power device';
			case 'mid':
				return 'mid-range device';
			case 'capable':
				return 'full-power device';
			default:
				return 'this device';
		}
	}
</script>

<!-- Chat -->
<div class="settings-section"><div class="settings-group-card"><ProfileAppearanceControls /></div></div>
<div class="settings-section">
	<h3>Chat</h3>
	<div class="settings-group-card">
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Avatars</span>
				<span class="setting-description">Who shows a profile picture in messages.</span>
			</div>
			<div class="segmented">
				<button type="button" class:active={chatAvatarMode === 'off'} on:click={() => updateChatAvatarMode('off')}>Off</button>
				<button type="button" class:active={chatAvatarMode === 'user'} on:click={() => updateChatAvatarMode('user')}>Others</button>
				<button type="button" class:active={chatAvatarMode === 'all'} on:click={() => updateChatAvatarMode('all')}>All</button>
			</div>
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Density</span>
				<span class="setting-description">How tightly messages pack together.</span>
			</div>
			<div class="segmented">
				<button type="button" class:active={messageDensity === 'cozy'} on:click={() => updateMessageDensity('cozy')}>Default</button>
				<button type="button" class:active={messageDensity === 'compact'} on:click={() => updateMessageDensity('compact')}>Compact</button>
			</div>
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Own messages on right</span>
				<span class="setting-description">Align your messages to the right side.</span>
			</div>
			<button class="toggle-btn" class:active={ownMessagesOnRight} on:click={toggleOwnMessagesOnRight} role="switch" aria-checked={ownMessagesOnRight} aria-label="Own messages on right"></button>
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Send button</span>
				<span class="setting-description">Show a clickable send button in the composer.</span>
			</div>
			<button class="toggle-btn" class:active={clickableSendEnabled} on:click={toggleClickableSendEnabled} role="switch" aria-checked={clickableSendEnabled} aria-label="Clickable send button"></button>
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Deletion timer</span>
				<span class="setting-description">Show when a message expires, or a continuously updating countdown.</span>
			</div>
			<div class="segmented">
				<button type="button" class:active={deletionCountdownMode === 'off'} on:click={() => updateDeletionCountdownMode('off')}>Off</button>
				<button type="button" class:active={deletionCountdownMode === 'static'} on:click={() => updateDeletionCountdownMode('static')}>Expiry label</button>
				<button type="button" class:active={deletionCountdownMode === 'live'} on:click={() => updateDeletionCountdownMode('live')}>Countdown</button>
			</div>
		</div>
	</div>
</div>

<!-- Layout -->
<div class="settings-section">
	<h3>Layout</h3>
	<div class="settings-group-card">
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Open to</span>
				<span class="setting-description">Your starting page on this device, for this account and server.</span>
			</div>
			<div class="segmented">
				<button type="button" class:active={openingSurface === 'last-channel'} on:click={() => updateOpeningSurface('last-channel')}>Last channel</button>
				<button type="button" class:active={openingSurface === 'server'} on:click={() => updateOpeningSurface('server')}>Server home</button>
				<button type="button" class:active={openingSurface === 'messages'} on:click={() => updateOpeningSurface('messages')}>Messages</button>
			</div>
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Nav dock</span>
				<span class="setting-description">Which side the server list appears on.</span>
			</div>
			<div class="segmented">
				<button type="button" class:active={$layoutStore.navDock === 'left'} on:click={() => updateDockSide('left')}>Left</button>
				<button type="button" class:active={$layoutStore.navDock === 'right'} on:click={() => updateDockSide('right')}>Right</button>
			</div>
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Peek a right-rail panel</span>
				<span class="setting-description">Hold this key and hover a rail icon to look at a panel without pinning it. Click an icon to pin it.</span>
			</div>
			<div class="segmented">
				{#each [['shift', 'Shift'], ['alt', 'Alt'], ['ctrl', 'Ctrl'], ['none', 'Hover only']] as [key, label]}
					<button type="button" class:active={$railPeekKey === key} on:click={() => railPeekKey.set(key as RailPeekKey)}>{label}</button>
				{/each}
			</div>
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Panels pinned side by side</span>
				<span class="setting-description">How many right-rail panels can stay open together in the dock (1–{MAX_DOCK_STACK_LIMIT}). Lowering it closes the oldest pins.</span>
			</div>
			<input type="number" class="w-field" style="max-width: 5.5rem" min="1" max={MAX_DOCK_STACK_LIMIT} step="1" value={$dockStackLimit} aria-label="Panels pinned side by side" on:change={(event) => layoutStore.setDockStackLimit(Number(event.currentTarget.value))} />
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Visible navigation</span>
				<span class="setting-description">Choose whether to show the server switcher and channel list.</span>
			</div>
			<div class="segmented">
				<button type="button" class:active={$homeLayout === 'server-browser'} on:click={() => updateHomeLayoutMode('server-browser')}>Servers & channels</button>
				<button type="button" class:active={$homeLayout === 'dm-focused'} on:click={() => updateHomeLayoutMode('dm-focused')}>Channels only</button>
				<button type="button" class:active={$homeLayout === 'dm-pure'} on:click={() => updateHomeLayoutMode('dm-pure')}>Hide both</button>
			</div>
		</div>
		{#if nativeApp}
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Layout preset</span>
				<span class="setting-description">Save and switch between layout configurations.</span>
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
		{/if}
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Server rail density</span>
				<span class="setting-description">How compact the far-left server strip is.</span>
			</div>
			<div class="segmented">
				<button type="button" class:active={$railDensity === 'full'} on:click={() => railDensity.set('full')}>Full</button>
				<button type="button" class:active={$railDensity === 'icons-only'} on:click={() => railDensity.set('icons-only')}>Icons</button>
				<button type="button" class:active={$railDensity === 'hidden'} on:click={() => railDensity.set('hidden')}>Hidden</button>
			</div>
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Server rail side</span>
				<span class="setting-description">Which screen edge the server rail pins to.</span>
			</div>
			<div class="segmented">
				<button type="button" class:active={$railSide === 'left'} on:click={() => railSide.set('left')}>Left</button>
				<button type="button" class:active={$railSide === 'right'} on:click={() => railSide.set('right')}>Right</button>
			</div>
		</div>
		<div class="setting-item setting-item-stack">
			<div class="setting-info">
				<span class="setting-label">Chrome opacity</span>
				<span class="setting-description">{Math.round(appChromeOpacity * 100)}% panel transparency (desktop).</span>
			</div>
			<input type="range" min="0.2" max="1" step="0.05" bind:value={appChromeOpacity} on:input={(e) => updateAppChromeOpacity(parseFloat(e.currentTarget.value))} class="volume-slider" />
		</div>
	</div>
</div>

<!-- Media -->
<div class="settings-section">
	<h3>Media</h3>
	<div class="settings-group-card">
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Video compression ({videoCompressionRuntimeLabel})</span>
				<span class="setting-description">Automatically compress large video uploads.</span>
			</div>
			<button class="toggle-btn" class:active={videoCompressionEnabled} on:click={toggleVideoCompressionEnabled} role="switch" aria-checked={videoCompressionEnabled} aria-label="Video compression"></button>
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Default preset</span>
				<span class="setting-description">Quality preset for the upload dialog.</span>
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

<!-- Theme -->
<div class="settings-section">
	<h3>Theme</h3>
	<div class="setting-item-full" style="padding:0;border:0;background:transparent;box-shadow:none">
		<div class="theme-cards">
			{#each Object.values(THEMES).filter((theme, index) => showAllThemes || index < 4 || theme.id === $themeStore.themeId) as theme}
				<button
					type="button"
					class="theme-card"
					class:active={$themeStore.themeId === theme.id}
					on:click={() => handleThemeChange(theme.id)}
					disabled={savingTheme}
					title={theme.description}
					style="--card-accent: {theme.colors.accentHex};"
				>
					<div class="theme-card-preview" style="background: {theme.colors.bgSecondary};">
						<div class="theme-preview-top" style="background: {theme.colors.bgTertiary};"></div>
						<div class="theme-preview-content">
							<div class="theme-preview-bar long" style="background: {theme.colors.textPrimary}; opacity: 0.55;"></div>
							<div class="theme-preview-bar short" style="background: {theme.colors.textSecondary}; opacity: 0.4;"></div>
							<div class="theme-preview-accent" style="background: {theme.colors.accentHex};"></div>
						</div>
						{#if theme.ambient && theme.ambient.effect !== 'none'}
							<div class="theme-card-glow" style="background: radial-gradient(circle at 30% 40%, {theme.colors.accentHex}33, transparent 70%);"></div>
						{/if}
					</div>
					<div class="theme-card-footer">
						<span class="theme-card-name">{theme.name}</span>
						{#if $themeStore.themeId === theme.id}
							<span class="theme-card-badge">
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
							</span>
						{/if}
					</div>
				</button>
			{/each}
		</div>
	</div>
	<button type="button" class="action-btn secondary" aria-expanded={showAllThemes} on:click={() => showAllThemes = !showAllThemes}>{showAllThemes ? 'Show fewer themes' : `Browse all ${Object.values(THEMES).length} themes`}</button>
	{#if savingTheme}
		<div class="save-indicator"><span class="spinner">...</span> Saving theme...</div>
	{/if}

	<!-- Advanced theme controls — progressive disclosure -->
	<button type="button" class="advanced-toggle" on:click={() => showAdvanced = !showAdvanced}>
		<span class="advanced-label">{showAdvanced ? 'Hide' : 'Tune'} theme</span>
		<svg class="advanced-chevron" class:rotated={showAdvanced} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
	</button>

	{#if showAdvanced}
		<div class="advanced-panel">
			<div class="customizer-container settings-customizer-slot">
				<ThemeCustomizer />
			</div>
			<div class="customizer-container settings-customizer-slot">
				<UniformFontMode />
			</div>
			<div class="customizer-container settings-customizer-slot">
				<EffectsTab />
			</div>
		</div>
	{/if}
</div>

<!-- Pointer effects are device preferences, independent of theme tuning. -->
<PointerEffectsTab />

<!-- Performance -->
<div class="settings-section">
	<h3>Performance</h3>
	<div class="settings-group-card">
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">CSS animations</span>
				<span class="setting-description">
					Use CSS transitions instead of spring animations.
					{#if $animationQuality.cssOnly && !$animationQuality.userOverride}
						<span class="auto-badge">Auto</span>
					{/if}
				</span>
			</div>
			<button
				class="toggle-btn"
				class:active={$animationQuality.cssOnly}
				on:click={() => animationQuality.setCssOnly(!$animationQuality.cssOnly)}
				role="switch"
				aria-checked={$animationQuality.cssOnly}
				aria-label="CSS animations"
			></button>
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Disable pop-out panels</span>
				<span class="setting-description">
					Keep all panels inline instead of opening new windows.
					{#if $animationQuality.disableWindows && !$animationQuality.userOverride}
						<span class="auto-badge">Auto</span>
					{/if}
				</span>
			</div>
			<button
				class="toggle-btn"
				class:active={$animationQuality.disableWindows}
				on:click={() => animationQuality.setDisableWindows(!$animationQuality.disableWindows)}
				role="switch"
				aria-checked={$animationQuality.disableWindows}
				aria-label="Disable new windows"
			></button>
		</div>
		{#if !$animationQuality.userOverride}
			<div class="runtime-note" style="padding: 0.35rem 0.1rem">
				Auto-tuned for a {getDeviceTierLabel($animationQuality.tier)}:
				{$animationQuality.cssOnly ? 'simple CSS animations' : 'full spring animations'}
				·
				{$animationQuality.disableWindows ? 'panels stay inline' : 'pop-out windows on'}.
				Toggle above to take control.
			</div>
		{/if}
		</div>
		</div>

		<!-- Chat background — always visible, not buried under Tune theme -->
		<div class="settings-section">
		<h3>Chat background</h3>
		<div class="settings-group-card">
			<div class="customizer-container settings-customizer-slot">
				<BackgroundImageEditor />
			</div>
		</div>
		</div>

<style>
	.advanced-toggle {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		width: 100%;
		margin-top: 0.85rem;
		padding: 0.6rem 0;
		background: transparent;
		border: 1px dashed color-mix(in srgb, var(--border-subtle) 60%, transparent);
		border-radius: var(--radius-md);
		color: var(--text-secondary);
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-medium);
		cursor: pointer;
		transition: all var(--duration-fast);
	}

	.advanced-toggle:hover {
		border-color: color-mix(in srgb, var(--accent-primary-color) 30%, transparent);
		color: var(--text-heading);
		background: color-mix(in srgb, var(--surface-raised) 40%, transparent);
	}

	.advanced-label {
		letter-spacing: 0.02em;
	}

	.advanced-chevron {
		transition: transform var(--duration-fast);
	}

	.advanced-chevron.rotated {
		transform: rotate(180deg);
	}

	.advanced-panel {
		animation: slideDown 0.2s ease-out;
	}

	@keyframes slideDown {
		from {
			opacity: 0;
			transform: translateY(-6px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.theme-card-glow {
		position: absolute;
		inset: 0;
		pointer-events: none;
		opacity: 0.6;
	}
</style>
