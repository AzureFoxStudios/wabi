<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { getAuthToken } from '$lib/authSession';
	import { currentLocale, getAvailableLocales, setAppLocale } from '$lib/i18n';
	import ThemeCustomizer from '../ThemeCustomizer.svelte';
	import UniformFontMode from '../UniformFontMode.svelte';
	import EffectsTab from '$lib/effects/EffectsTab.svelte';
	import PointerEffectsTab from '$lib/effects/PointerEffectsTab.svelte';
	import ChatBackdropSettings from './ChatBackdropSettings.svelte';
	import Icon from '../ui/Icon.svelte';
	import Segmented from '../ui/Segmented.svelte';
	import Select from '../ui/Select.svelte';
	import Switch from '../ui/Switch.svelte';
	import { layoutStore } from '$lib/layoutStore';
	import { railPeekKey, type RailPeekKey } from '$lib/railPrefs';
	import {
		dockStackLimit,
		homeLayout,
		type HomeLayoutMode,
		railDensity,
		railSide,
		type RailDensity,
		type RailSide
	} from '$lib/layoutStoreStates';
	import { animationQuality } from '$lib/motion/animationQuality';
	import { profileAppearance, profileOsReducedMotion, setProfileAppearance, type ProfileAppearance } from '$lib/profileAppearance';
	import { themeStore } from '$lib/theme/themeStore';
	import { THEMES, getThemeById } from '$lib/theme/themes';
	import { saveThemePreferences } from '$lib/theme/themeApi';
	import { saveThemeToLocalStorage } from '$lib/theme/themeManager';
	import {
		themeCharacterWord,
		themePickerGroups,
		themePreviewAttributes,
		themePreviewStyle
	} from '$lib/theme/themePicker';
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
	import { confirmAction } from '$lib/confirm';
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
	import { APPEARANCE_TEXT_SIZES, textSizeOptions, textSizeValue } from './settingsFrame';

	const themeGroups = themePickerGroups(THEMES);
	const themeCount = Object.keys(THEMES).length;
	const languages = getAvailableLocales().map((locale) => ({ value: locale.code, label: locale.label }));

	let nativeApp = false;
	let ownMessagesOnRight = false;
	let reducedMotion = false;
	let interfaceScale = 1;
	let openingSurface: OpeningSurface = 'last-channel';
	let chatAvatarMode: ChatAvatarMode = 'all';
	let messageDensity: MessageDensity = 'cozy';
	let deletionCountdownMode: DeletionCountdownMode = 'static';
	let clickableSendEnabled = true;
	let videoCompressionEnabled = true;
	let videoCompressionRuntime: VideoCompressionRuntime = 'desktop';
	let videoCompressionRuntimeLabel = 'Desktop';
	let videoCompressionPresetOptions: VideoCompressionPresetOption[] = getVideoCompressionPresetOptions('desktop');
	let defaultVideoCompressionPreset: VideoCompressionPresetId = 'balanced_720p';
	let showAllThemes = false;
	let showThemeTuning = false;
	let themeSaveError = '';
	let themeSaveTimer: ReturnType<typeof setTimeout> | null = null;
	let themeButtons: Record<string, HTMLButtonElement | null> = {};

	$: customThemeActive = $themeStore.themeId === 'custom';
	$: selectedThemeId = customThemeActive ? null : getThemeById($themeStore.themeId)?.id ?? null;
	// Collapsed, the extra group still shows the chosen theme, so the checked radio never disappears.
	$: visibleThemeGroups = themeGroups
		.map((group) =>
			group.id === 'more' && !showAllThemes
				? { ...group, themes: group.themes.filter((theme) => theme.id === selectedThemeId) }
				: group
		)
		.filter((group) => group.themes.length);
	$: visibleThemeIds = visibleThemeGroups.flatMap((group) => group.themes.map((theme) => theme.id));
	// The one radio Tab lands on: the checked theme, else the first one shown.
	$: themeTabStop = selectedThemeId && visibleThemeIds.includes(selectedThemeId) ? selectedThemeId : visibleThemeIds[0];
	$: themeSynced = Boolean(getAuthToken());
	$: textSizes = textSizeOptions(interfaceScale, APPEARANCE_TEXT_SIZES);
	$: textSize = textSizeValue(interfaceScale, textSizes);
	$: selectedPreset = videoCompressionPresetOptions.find((option) => option.id === defaultVideoCompressionPreset) ?? null;
	$: dockLimitOptions = dockLimitChoices($dockStackLimit);
	$: profileDecorations = $profileAppearance.showCosmetics;

	onMount(() => {
		nativeApp = isTauriRuntime();
		const stored = getStoredAccessibilitySettings();
		ownMessagesOnRight = stored.ownMessagesOnRight;
		reducedMotion = stored.reducedMotion;
		interfaceScale = stored.interfaceScale;
		chatAvatarMode = stored.chatAvatarMode;
		messageDensity = stored.messageDensity;
		deletionCountdownMode = stored.deletionCountdownMode;
		clickableSendEnabled = stored.clickableSendEnabled;
		openingSurface = getOpeningSurface();
		videoCompressionEnabled = isVideoCompressionEnabled();
		applyVideoCompressionRuntimePreferences();
		if (customThemeActive) showThemeTuning = true;
	});

	onDestroy(() => {
		if (themeSaveTimer) {
			clearTimeout(themeSaveTimer);
			void persistTheme($themeStore.themeId);
		}
	});

	// ---------------------------------------------------------------- theme
	/** Applies at once; saving waits for a pause, so arrowing through the radios sends one save. */
	function chooseTheme(themeId: string) {
		if (themeId === $themeStore.themeId) return;
		themeStore.setThemeId(themeId);
		themeSaveError = '';
		if (themeSaveTimer) clearTimeout(themeSaveTimer);
		themeSaveTimer = setTimeout(() => {
			themeSaveTimer = null;
			void persistTheme(themeId);
		}, 450);
	}

	async function persistTheme(themeId: string) {
		try {
			if (getAuthToken()) await saveThemePreferences({ theme_id: themeId });
			else saveThemeToLocalStorage(themeId);
		} catch (error) {
			console.error('[Settings] Failed to save theme:', error);
			themeSaveError = 'Your theme could not be saved to the server. It is still applied here; choose it again to retry.';
		}
	}

	/** Radio keys: arrows move and choose (wrapping across groups), Home/End jump. */
	async function handleThemeKeydown(event: KeyboardEvent, themeId: string) {
		const index = visibleThemeIds.indexOf(themeId);
		let next = -1;
		if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % visibleThemeIds.length;
		else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + visibleThemeIds.length) % visibleThemeIds.length;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = visibleThemeIds.length - 1;
		else return;
		event.preventDefault();
		const target = visibleThemeIds[next];
		chooseTheme(target);
		await tick();
		themeButtons[target]?.focus();
	}

	// ---------------------------------------------------------------- reading
	function updateTextSize(value: number) {
		interfaceScale = updateAccessibilitySettings({ interfaceScale: value }).interfaceScale;
	}

	function updateMessageDensity(value: MessageDensity) {
		messageDensity = updateAccessibilitySettings({ messageDensity: value }).messageDensity;
	}

	function setOwnMessagesOnRight(value: boolean) {
		ownMessagesOnRight = updateAccessibilitySettings({ ownMessagesOnRight: value }).ownMessagesOnRight;
	}

	/** The switch also marks <html data-motion="reduce">, which the newer surfaces read (§4.7). */
	function setReducedMotion(value: boolean) {
		reducedMotion = updateAccessibilitySettings({ reducedMotion: value }).reducedMotion;
		if (typeof document !== 'undefined') {
			if (reducedMotion) document.documentElement.setAttribute('data-motion', 'reduce');
			else document.documentElement.removeAttribute('data-motion');
		}
	}

	function changeLanguage(code: string) {
		void setAppLocale(code);
	}

	// ---------------------------------------------------------------- chat
	function updateChatAvatarMode(mode: ChatAvatarMode) {
		chatAvatarMode = updateAccessibilitySettings({ chatAvatarMode: mode }).chatAvatarMode;
	}

	function setClickableSend(value: boolean) {
		clickableSendEnabled = updateAccessibilitySettings({ clickableSendEnabled: value }).clickableSendEnabled;
	}

	function updateDeletionCountdownMode(mode: DeletionCountdownMode) {
		deletionCountdownMode = updateAccessibilitySettings({ deletionCountdownMode: mode }).deletionCountdownMode;
	}

	// ---------------------------------------------------------------- layout
	function updateOpeningSurface(surface: OpeningSurface) {
		openingSurface = surface;
		setOpeningSurface(surface);
	}

	/** 1–4 side by side, plus a saved larger limit so the control shows the real setting. */
	function dockLimitChoices(current: number) {
		const values = [1, 2, 3, 4];
		if (Number.isFinite(current) && !values.includes(current)) values.push(current);
		return values.sort((a, b) => a - b).map((value) => ({ value, label: String(value) }));
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

	async function resetActiveWorkspace() {
		const confirmed = await confirmAction({
			title: 'Reset this layout?',
			body: `“${$layoutStore.activeWorkspace}” goes back to its default panels and sizes.`,
			confirm: 'Reset layout',
			danger: true
		});
		if (confirmed) layoutStore.resetWorkspace($layoutStore.activeWorkspace);
	}

	async function exportWorkspaceJson() {
		const json = layoutStore.exportLayoutJson();
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(json);
			void confirmAction({ title: 'Layout copied', body: 'The layout JSON is on your clipboard.', confirm: 'Done', cancel: null });
			return;
		}
		window.prompt('Copy layout JSON:', json);
	}

	function importWorkspaceJsonPrompt() {
		const pasted = window.prompt('Paste layout JSON');
		if (!pasted) return;
		if (!layoutStore.importLayoutJson(pasted)) {
			void confirmAction({
				title: 'That layout could not be read',
				body: 'Paste the JSON exactly as it was exported. Your current layout is unchanged.',
				confirm: 'Got it',
				cancel: null
			});
		}
	}

	// ---------------------------------------------------------------- media
	function resolveVideoCompressionRuntimeScope(): VideoCompressionRuntime {
		if (!isTauriRuntime()) return 'desktop';
		const runtime = getTauriPlatform();
		return runtime === 'android' || runtime === 'ios' || runtime === 'desktop' ? runtime : 'desktop';
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
		if (resolvedPreset !== storedPreset) setDefaultVideoCompressionPreset(resolvedPreset, videoCompressionRuntime);
	}

	function setVideoCompression(value: boolean) {
		videoCompressionEnabled = value;
		setVideoCompressionEnabled(value);
	}

	function updateVideoCompressionPreset(value: string) {
		defaultVideoCompressionPreset = value as VideoCompressionPresetId;
		setDefaultVideoCompressionPreset(defaultVideoCompressionPreset, videoCompressionRuntime);
	}

	// ---------------------------------------------------------------- profile decorations
	const decorationRows: Array<{ key: Exclude<keyof ProfileAppearance, 'showCosmetics'>; label: string; hint: string }> = [
		{ key: 'names', label: 'Styled names', hint: 'Fonts and colors people chose for their names.' },
		{ key: 'plates', label: 'Nameplates', hint: 'The band behind a name in member lists.' },
		{ key: 'decorations', label: 'Banners and avatar decorations', hint: 'Profile banners and frames around avatars.' },
		{ key: 'animate', label: 'Artwork and name animation', hint: 'Moving profile art and shimmering names.' }
	];

	// ---------------------------------------------------------------- performance
	/** "Auto-tuned for a low-power device" — the article lives with each phrase. */
	function deviceTierPhrase(tier: string | undefined): string {
		switch (tier) {
			case 'weak':
				return 'a low-power device';
			case 'mid':
				return 'a mid-range device';
			case 'capable':
				return 'a full-power device';
			default:
				return 'this device';
		}
	}
</script>

<!-- Theme -->
<section class="settings-block" aria-labelledby="appearance-theme-title">
	<div class="settings-block__head">
		<h3 class="settings-block__title" id="appearance-theme-title">Theme</h3>
		{#if themeSynced}<span class="w-tag" title="Your theme follows your account on this server">Synced to server</span>{/if}
	</div>
	<p class="settings-block__hint">Every theme keeps the same layout; only color, corners and type change.</p>

	<div class="theme-picker" role="radiogroup" aria-labelledby="appearance-theme-title">
		{#each visibleThemeGroups as group (group.id)}
			<div class="theme-picker__kicker w-kicker" id="theme-group-{group.id}">{group.label}</div>
			<div class="theme-picker__grid">
				{#each group.themes as theme (theme.id)}
					{@const selected = theme.id === selectedThemeId}
					{@const word = themeCharacterWord(theme)}
					<button
						type="button"
						role="radio"
						class="theme-option"
						aria-checked={selected}
						aria-describedby="theme-group-{group.id}"
						tabindex={theme.id === themeTabStop ? 0 : -1}
						title={theme.description}
						data-theme-option={theme.id}
						bind:this={themeButtons[theme.id]}
						on:click={() => chooseTheme(theme.id)}
						on:keydown={(event) => handleThemeKeydown(event, theme.id)}
					>
						<span class="theme-preview" style={themePreviewStyle(theme)} {...themePreviewAttributes(theme)} aria-hidden="true">
							<span class="theme-preview__rail"><i></i><i></i><i></i></span>
							<span class="theme-preview__page"><b>Aa</b><i><span class="theme-preview__sig"></span></i><i></i></span>
							<span class="theme-preview__seal"></span>
							<span class="theme-preview__primary"></span>
						</span>
						<span class="theme-option__name">
							{#if selected}<Icon name="check" size={14} stroke={2.25} />{/if}
							<span class="theme-option__label">{theme.name}</span>
							{#if word}<small class="theme-option__word">{word}</small>{/if}
						</span>
					</button>
				{/each}
			</div>
		{/each}
	</div>

	<div class="theme-picker__foot">
		<button
			type="button"
			class="w-btn w-btn--quiet w-btn--sm theme-picker__more"
			aria-expanded={showAllThemes}
			on:click={() => (showAllThemes = !showAllThemes)}
		>
			{showAllThemes ? 'Show fewer themes' : `Show all ${themeCount} themes`}
			<Icon name={showAllThemes ? 'chevUp' : 'chevDown'} size={16} />
		</button>
		{#if customThemeActive}<span class="theme-picker__custom">Using your custom theme</span>{/if}
		<button
			type="button"
			class="w-disclosure theme-picker__tune"
			aria-expanded={showThemeTuning}
			aria-controls="appearance-theme-tuning"
			on:click={() => (showThemeTuning = !showThemeTuning)}
		>
			<Icon name="chevRight" size={16} />
			Customize theme
		</button>
	</div>
	{#if themeSaveError}<p class="w-field-error settings-block__error" role="alert"><Icon name="alert" size={14} />{themeSaveError}</p>{/if}

	{#if showThemeTuning}
		<div class="w-disclosure__body settings-disclosure__body" id="appearance-theme-tuning">
			<div class="settings-embed"><ThemeCustomizer /></div>
			<div class="settings-embed"><UniformFontMode /></div>
			<div class="settings-embed"><EffectsTab /></div>
		</div>
	{/if}
</section>

<!-- Reading -->
<section class="settings-block" aria-labelledby="appearance-reading-title">
	<h3 class="settings-block__title" id="appearance-reading-title">Reading</h3>
	<div class="w-srows">
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-text-size">Text size</p>
				<p class="w-srow__hint">Scales every word in Wabi, chat included.</p>
			</div>
			<div class="w-srow__control">
				<Segmented labelledby="appearance-text-size" options={textSizes} value={textSize} onchange={updateTextSize} />
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-density">Message density</p>
				<p class="w-srow__hint">Cozy shows avatars and room to breathe; compact fits more on screen.</p>
			</div>
			<div class="w-srow__control">
				<Segmented
					labelledby="appearance-density"
					options={[{ value: 'cozy', label: 'Cozy' }, { value: 'compact', label: 'Compact' }]}
					value={messageDensity}
					onchange={(value) => updateMessageDensity(value as MessageDensity)}
				/>
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-reduce-motion">Reduce motion</p>
				<p class="w-srow__hint">
					Panels and menus appear without sliding.{$profileOsReducedMotion ? ' Your device asks for less motion, so this stays on.' : ''}
				</p>
			</div>
			<div class="w-srow__control">
				<Switch
					labelledby="appearance-reduce-motion"
					checked={reducedMotion || $profileOsReducedMotion}
					disabled={$profileOsReducedMotion}
					onchange={setReducedMotion}
				/>
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-own-right">Your messages on the right</p>
				<p class="w-srow__hint">Lines your own messages up along the right edge of the conversation.</p>
			</div>
			<div class="w-srow__control">
				<Switch labelledby="appearance-own-right" checked={ownMessagesOnRight} onchange={setOwnMessagesOnRight} />
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-language">Language</p>
				<p class="w-srow__hint">Menus and labels. Messages stay in the language they were written in.</p>
			</div>
			<div class="w-srow__control">
				<Select ariaLabel="Language" heading="Language" align="end" options={languages} value={$currentLocale || 'en'} onchange={changeLanguage} />
			</div>
		</div>
	</div>
</section>

<!-- Chat background: one picker -->
<ChatBackdropSettings />

<!-- Chat -->
<section class="settings-block" aria-labelledby="appearance-chat-title">
	<h3 class="settings-block__title" id="appearance-chat-title">Chat</h3>
	<div class="w-srows">
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-avatars">Avatars in chat</p>
				<p class="w-srow__hint">Whose profile pictures appear beside messages.</p>
			</div>
			<div class="w-srow__control">
				<Segmented
					labelledby="appearance-avatars"
					options={[{ value: 'off', label: 'None' }, { value: 'user', label: 'Others' }, { value: 'all', label: 'Everyone' }]}
					value={chatAvatarMode}
					onchange={(value) => updateChatAvatarMode(value as ChatAvatarMode)}
				/>
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-send-button">Send button</p>
				<p class="w-srow__hint">Shows a send button in the composer. Enter still sends.</p>
			</div>
			<div class="w-srow__control">
				<Switch labelledby="appearance-send-button" checked={clickableSendEnabled} onchange={setClickableSend} />
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-deletion-timer">Deletion timer</p>
				<p class="w-srow__hint">On messages that expire: when they go, or a live countdown.</p>
			</div>
			<div class="w-srow__control">
				<Segmented
					labelledby="appearance-deletion-timer"
					options={[{ value: 'off', label: 'Off' }, { value: 'static', label: 'Expiry time' }, { value: 'live', label: 'Countdown' }]}
					value={deletionCountdownMode}
					onchange={(value) => updateDeletionCountdownMode(value as DeletionCountdownMode)}
				/>
			</div>
		</div>
	</div>
</section>

<!-- Layout -->
<section class="settings-block" aria-labelledby="appearance-layout-title">
	<h3 class="settings-block__title" id="appearance-layout-title">Layout</h3>
	<div class="w-srows">
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-open-to">Open to</p>
				<p class="w-srow__hint">Where Wabi starts on this device, for this account and server.</p>
			</div>
			<div class="w-srow__control">
				<Segmented
					labelledby="appearance-open-to"
					options={[{ value: 'last-channel', label: 'Last channel' }, { value: 'server', label: 'Server home' }, { value: 'messages', label: 'DMs' }]}
					value={openingSurface}
					onchange={(value) => updateOpeningSurface(value as OpeningSurface)}
				/>
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-visible-nav">Visible navigation</p>
				<p class="w-srow__hint">Whether the server list and the channel list show.</p>
			</div>
			<div class="w-srow__control">
				<Segmented
					labelledby="appearance-visible-nav"
					options={[{ value: 'server-browser', label: 'Servers and channels' }, { value: 'dm-focused', label: 'Channels only' }, { value: 'dm-pure', label: 'Neither' }]}
					value={$homeLayout}
					onchange={(value) => homeLayout.set(value as HomeLayoutMode)}
				/>
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-nav-dock">Navigation side</p>
				<p class="w-srow__hint">Which side the server list docks to.</p>
			</div>
			<div class="w-srow__control">
				<Segmented
					labelledby="appearance-nav-dock"
					options={[{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }]}
					value={$layoutStore.navDock}
					onchange={(value) => layoutStore.setNavDock(value as 'left' | 'right')}
				/>
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-rail-density">Server rail</p>
				<p class="w-srow__hint">How much of the far-left server strip shows.</p>
			</div>
			<div class="w-srow__control">
				<Segmented
					labelledby="appearance-rail-density"
					options={[{ value: 'full', label: 'Full' }, { value: 'icons-only', label: 'Icons' }, { value: 'hidden', label: 'Hidden' }]}
					value={$railDensity}
					onchange={(value) => railDensity.set(value as RailDensity)}
				/>
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-rail-side">Server rail side</p>
				<p class="w-srow__hint">Which screen edge the server rail pins to.</p>
			</div>
			<div class="w-srow__control">
				<Segmented
					labelledby="appearance-rail-side"
					options={[{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }]}
					value={$railSide}
					onchange={(value) => railSide.set(value as RailSide)}
				/>
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-dock-limit">Panels pinned side by side</p>
				<p class="w-srow__hint">How many side panels stay open together. Lowering it closes the oldest pins.</p>
			</div>
			<div class="w-srow__control">
				<Segmented
					labelledby="appearance-dock-limit"
					options={dockLimitOptions}
					value={$dockStackLimit}
					onchange={(value) => layoutStore.setDockStackLimit(value)}
				/>
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-peek-key">Peek a side panel</p>
				<p class="w-srow__hint">Hold this key and point at a stub to look at its panel without pinning it. Click a stub to pin it.</p>
			</div>
			<div class="w-srow__control">
				<Segmented
					labelledby="appearance-peek-key"
					options={[{ value: 'shift', label: 'Shift' }, { value: 'alt', label: 'Alt' }, { value: 'ctrl', label: 'Ctrl' }, { value: 'none', label: 'Hover only' }]}
					value={$railPeekKey}
					onchange={(value) => railPeekKey.set(value as RailPeekKey)}
				/>
			</div>
		</div>
		{#if nativeApp}
			<div class="w-srow">
				<div class="w-srow__text">
					<p class="w-srow__label" id="appearance-layout-preset">Layout preset</p>
					<p class="w-srow__hint">Save and switch between window layouts in the desktop app.</p>
				</div>
				<div class="w-srow__control">
					<Select
						ariaLabel="Layout preset"
						align="end"
						options={$layoutStore.workspaces.map((name) => ({ value: name, label: name }))}
						value={$layoutStore.activeWorkspace}
						onchange={loadWorkspaceByName}
					/>
				</div>
			</div>
			<div class="settings-actions">
				<button type="button" class="w-btn w-btn--sm" on:click={saveWorkspaceAsPrompt}>Save as…</button>
				<button type="button" class="w-btn w-btn--sm" on:click={renameWorkspacePrompt}>Rename…</button>
				<button type="button" class="w-btn w-btn--sm" on:click={exportWorkspaceJson}>Copy layout JSON</button>
				<button type="button" class="w-btn w-btn--sm" on:click={importWorkspaceJsonPrompt}>Paste layout JSON…</button>
				<button type="button" class="w-btn w-btn--sm w-btn--danger" on:click={resetActiveWorkspace}>Reset layout…</button>
			</div>
		{/if}
	</div>
</section>

<!-- Media -->
<section class="settings-block" aria-labelledby="appearance-media-title">
	<h3 class="settings-block__title" id="appearance-media-title">Media</h3>
	<div class="w-srows">
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-video-compression">Video compression</p>
				<p class="w-srow__hint">Shrinks large video uploads before they are sent ({videoCompressionRuntimeLabel}).</p>
			</div>
			<div class="w-srow__control">
				<Switch labelledby="appearance-video-compression" checked={videoCompressionEnabled} onchange={setVideoCompression} />
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-video-preset">Default quality</p>
				<p class="w-srow__hint">
					{#if !videoCompressionEnabled}Turn on video compression to choose a quality.{:else}{selectedPreset?.description ?? 'Quality the upload dialog starts with.'}{/if}
				</p>
			</div>
			<div class="w-srow__control">
				<Select
					ariaLabel="Default quality"
					align="end"
					disabled={!videoCompressionEnabled}
					options={videoCompressionPresetOptions.map((option) => ({ value: option.id, label: option.label }))}
					value={defaultVideoCompressionPreset}
					onchange={updateVideoCompressionPreset}
				/>
			</div>
		</div>
	</div>
</section>

<!-- Profile decorations (how other people's profiles look here) -->
<section class="settings-block" aria-labelledby="appearance-decorations-title">
	<h3 class="settings-block__title" id="appearance-decorations-title">Profile decorations</h3>
	<p class="settings-block__hint">How other people's profiles look on this device. Nobody's saved design changes.</p>
	<div class="w-srows">
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-decorations">Show profile decorations</p>
				<p class="w-srow__hint">Off shows every profile plainly. Your choices below are kept for when you turn it back on.</p>
			</div>
			<div class="w-srow__control">
				<Switch labelledby="appearance-decorations" checked={profileDecorations} onchange={(value) => setProfileAppearance({ showCosmetics: value })} />
			</div>
		</div>
		{#each decorationRows as row (row.key)}
			<div class="w-srow settings-srow--sub" class:settings-srow--off={!profileDecorations}>
				<div class="w-srow__text">
					<p class="w-srow__label" id="appearance-decoration-{row.key}">{row.label}</p>
					<p class="w-srow__hint">
						{#if !profileDecorations}Turn on profile decorations to change this.{:else if row.key === 'animate'}{row.hint} Reduce motion keeps artwork still.{:else}{row.hint}{/if}
					</p>
				</div>
				<div class="w-srow__control">
					<Switch
						labelledby="appearance-decoration-{row.key}"
						disabled={!profileDecorations}
						checked={$profileAppearance[row.key]}
						onchange={(value) => setProfileAppearance({ [row.key]: value })}
					/>
				</div>
			</div>
		{/each}
	</div>
</section>

<!-- Pointer effects are device preferences, independent of theme tuning. -->
<div class="settings-embed settings-embed--section"><PointerEffectsTab /></div>

<!-- Performance -->
<section class="settings-block" aria-labelledby="appearance-performance-title">
	<h3 class="settings-block__title" id="appearance-performance-title">Performance</h3>
	{#if !$animationQuality.userOverride}
		<p class="settings-block__hint">
			Tuned for {deviceTierPhrase($animationQuality.tier)}: {$animationQuality.cssOnly ? 'simple animations' : 'full spring animations'},
			{$animationQuality.disableWindows ? 'panels stay inline' : 'pop-out windows allowed'}. Change either switch to choose yourself.
		</p>
	{/if}
	<div class="w-srows">
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-css-animations">
					Simple animations
					{#if $animationQuality.cssOnly && !$animationQuality.userOverride}<span class="w-tag settings-auto-tag">Auto</span>{/if}
				</p>
				<p class="w-srow__hint">Uses plain transitions instead of spring animations. Lighter on older devices.</p>
			</div>
			<div class="w-srow__control">
				<Switch
					labelledby="appearance-css-animations"
					checked={$animationQuality.cssOnly}
					onchange={(value) => animationQuality.setCssOnly(value)}
				/>
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-disable-windows">
					Keep panels inline
					{#if $animationQuality.disableWindows && !$animationQuality.userOverride}<span class="w-tag settings-auto-tag">Auto</span>{/if}
				</p>
				<p class="w-srow__hint">Opens panels inside Wabi instead of in new windows.</p>
			</div>
			<div class="w-srow__control">
				<Switch
					labelledby="appearance-disable-windows"
					checked={$animationQuality.disableWindows}
					onchange={(value) => animationQuality.setDisableWindows(value)}
				/>
			</div>
		</div>
	</div>
</section>
