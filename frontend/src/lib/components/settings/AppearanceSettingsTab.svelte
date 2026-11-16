<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { getAuthToken } from '$lib/authSession';
	import { _ as t, currentLocale, getAvailableLocales, setAppLocale } from '$lib/i18n';
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
	import { persistRailLayout } from '$lib/railLayout';
	import {
		MAX_DOCK_STACK_LIMIT,
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
		themeChoiceAction,
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
	import { APPEARANCE_TEXT_SIZES, appearanceLayoutScopeHint, dockLimitOptions, textSizeOptions, textSizeValue } from './settingsFrame';

	/** Signed in to an account (Settings knows): some choices here are saved to it. */
	export let signedIn = false;

	const themeGroups = themePickerGroups(THEMES);
	const themeCount = Object.keys(THEMES).length;
	const languages = getAvailableLocales().map((locale) => ({ value: locale.code, label: locale.label }));
	const dockLimits = dockLimitOptions(MAX_DOCK_STACK_LIMIT);

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
	/** Failed saves so far: each failure re-creates the alert so it is read out again. */
	let themeSaveFailures = 0;
	let themeSaveSeq = 0;
	let themeRetrying = false;
	let themeRetryButton: HTMLButtonElement | null = null;
	let themeSaveTimer: ReturnType<typeof setTimeout> | null = null;
	let themeButtons: Record<string, HTMLButtonElement | null> = {};

	const THEME_SAVE_FAILED = $t('appset.theme_save_failed');
	const THEME_SAVE_FAILED_AGAIN = $t('appset.theme_save_failed_again');

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
	$: textSizes = textSizeOptions(interfaceScale, APPEARANCE_TEXT_SIZES);
	$: textSize = textSizeValue(interfaceScale, textSizes);
	$: selectedPreset = videoCompressionPresetOptions.find((option) => option.id === defaultVideoCompressionPreset) ?? null;
	$: profileDecorations = $profileAppearance.showCosmetics;
	$: languageLabel = translatedOr($t, 'settings.language', $t('settings.language'));
	$: layoutScopeHint = appearanceLayoutScopeHint(signedIn, nativeApp);

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

	function translatedOr(translate: (key: string) => string, key: string, fallback: string): string {
		const translated = translate(key);
		return translated && translated !== key ? translated : fallback;
	}

	// ---------------------------------------------------------------- theme
	/**
	 * Applies at once; saving waits for a pause, so arrowing through the radios sends one save.
	 * Choosing the shown theme again after a failed save retries it (themeChoiceAction).
	 */
	function chooseTheme(themeId: string) {
		const action = themeChoiceAction(themeId, $themeStore.themeId, Boolean(themeSaveError));
		if (action === 'none') return;
		if (action === 'apply') themeStore.setThemeId(themeId);
		themeSaveError = '';
		if (themeSaveTimer) clearTimeout(themeSaveTimer);
		themeSaveTimer = setTimeout(() => {
			themeSaveTimer = null;
			void persistTheme(themeId);
		}, action === 'retry' ? 0 : 450);
	}

	/**
	 * Try again keeps its row, and so its focus, while the save runs (aria-busy). A repeat failure
	 * re-reads the alert in new words; a success hands focus to the checked theme before the row
	 * goes, so keyboard focus never falls out of the dialog.
	 */
	async function retryThemeSave() {
		if (themeRetrying) return;
		if (themeSaveTimer) {
			clearTimeout(themeSaveTimer);
			themeSaveTimer = null;
		}
		themeRetrying = true;
		// persistTheme takes the next sequence number; a newer save started meanwhile owns the
		// alert (and the account's copy), so this older retry must not clear it.
		const retrySeq = themeSaveSeq + 1;
		const saved = await persistTheme($themeStore.themeId);
		themeRetrying = false;
		if (!saved || retrySeq !== themeSaveSeq) return;
		if (themeRetryButton && document.activeElement === themeRetryButton) {
			const checked = (selectedThemeId && themeButtons[selectedThemeId]) || (themeTabStop && themeButtons[themeTabStop]) || null;
			checked?.focus();
		}
		themeSaveError = '';
		themeSaveFailures = 0;
	}

	/** True when saved. Only the latest attempt reports, so an older failure never covers a newer choice. */
	async function persistTheme(themeId: string): Promise<boolean> {
		const seq = ++themeSaveSeq;
		try {
			if (getAuthToken()) await saveThemePreferences({ theme_id: themeId });
			else saveThemeToLocalStorage(themeId);
			// Once no error shows, the next failure is a first failure again.
			if (seq === themeSaveSeq && !themeSaveError) themeSaveFailures = 0;
			return true;
		} catch (error) {
			console.error('[Settings] Failed to save theme:', error);
			if (seq === themeSaveSeq) {
				themeSaveError = themeSaveFailures > 0 ? THEME_SAVE_FAILED_AGAIN : THEME_SAVE_FAILED;
				themeSaveFailures += 1;
			}
			return false;
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

	/**
	 * The server rail's density and side live in the account's layout container (railLayout.ts).
	 * These rows are their only writer, so they save through it: without this a change here never
	 * reached the account and the account's older copy came back on the next load.
	 */
	function setRailDensity(value: RailDensity) {
		railDensity.set(value);
		persistRailLayout();
	}

	function setRailSide(value: RailSide) {
		railSide.set(value);
		persistRailLayout();
	}

	function loadWorkspaceByName(name: string) {
		layoutStore.loadWorkspace(name);
	}

	function saveWorkspaceAsPrompt() {
		const suggested = `${$layoutStore.activeWorkspace}-copy`;
		const name = window.prompt($t('appset.prompt_save_layout'), suggested);
		if (!name) return;
		layoutStore.saveWorkspace(name);
	}

	function renameWorkspacePrompt() {
		const current = $layoutStore.activeWorkspace;
		const nextName = window.prompt($t('appset.prompt_rename_layout'), current);
		if (!nextName) return;
		layoutStore.renameWorkspace(current, nextName);
	}

	async function resetActiveWorkspace() {
		const confirmed = await confirmAction({
			title: $t('appset.reset_title'),
			body: $t('appset.reset_body', { values: { name: $layoutStore.activeWorkspace } }),
			confirm: $t('appset.reset_confirm'),
			danger: true
		});
		if (confirmed) layoutStore.resetWorkspace($layoutStore.activeWorkspace);
	}

	async function exportWorkspaceJson() {
		const json = layoutStore.exportLayoutJson();
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(json);
			void confirmAction({ title: $t('appset.layout_copied'), body: $t('appset.layout_copied_body'), confirm: $t('login.wizard.step_done'), cancel: null });
			return;
		}
		window.prompt($t('appset.prompt_copy_json'), json);
	}

	function importWorkspaceJsonPrompt() {
		const pasted = window.prompt($t('appset.prompt_paste_json'));
		if (!pasted) return;
		if (!layoutStore.importLayoutJson(pasted)) {
			void confirmAction({
				title: $t('appset.import_fail_title'),
				body: $t('appset.import_fail_body'),
				confirm: $t('appset.got_it'),
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
		{ key: 'names', label: 'appset.dec_names', hint: 'appset.dec_names_hint' },
		{ key: 'plates', label: 'appset.dec_plates', hint: 'appset.dec_plates_hint' },
		{ key: 'decorations', label: 'appset.dec_banners', hint: 'appset.dec_banners_hint' },
		{ key: 'animate', label: 'appset.dec_anim', hint: 'appset.dec_anim_hint' }
	];

	// ---------------------------------------------------------------- performance
	/** "Auto-tuned for a low-power device" — the article lives with each phrase. */
	function deviceTierPhrase(tier: string | undefined): string {
		switch (tier) {
			case 'weak':
				return 'appset.tier_weak';
			case 'mid':
				return 'appset.tier_mid';
			case 'capable':
				return 'appset.tier_capable';
			default:
				return 'appset.tier_this';
		}
	}
</script>

<!-- Theme -->
<section class="settings-block" aria-labelledby="appearance-theme-title">
	<h3 class="settings-block__title" id="appearance-theme-title">{$t('settings.appearance.theme')}</h3>
	<p class="settings-block__hint">{$t('appset.theme_hint')}</p>

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
			{showAllThemes ? $t('appset.show_fewer') : $t('settings.appearance.show_all_themes', { values: { count: themeCount } })}
			<Icon name={showAllThemes ? 'chevUp' : 'chevDown'} size={16} />
		</button>
		{#if customThemeActive}<span class="theme-picker__custom">{$t('appset.custom_theme_active')}</span>{/if}
	</div>
	{#if themeSaveError}
		<div class="settings-block__error settings-error-row">
			{#key themeSaveFailures}
				<p class="w-field-error" role="alert"><Icon name="alert" size={14} />{themeSaveError}</p>
			{/key}
			<button
				type="button"
				class="w-btn w-btn--sm"
				aria-busy={themeRetrying}
				bind:this={themeRetryButton}
				on:click={retryThemeSave}>{$t('messages.zip_preview.retry')}</button
			>
		</div>
	{/if}

	<!-- The older theme editors, behind their own disclosure row under the picker (§7.25). -->
	<button
		type="button"
		class="w-disclosure theme-tuning__toggle"
		aria-expanded={showThemeTuning}
		aria-controls={showThemeTuning ? 'appearance-theme-tuning' : undefined}
		on:click={() => (showThemeTuning = !showThemeTuning)}
	>
		<Icon name="chevRight" size={16} />
		{$t('appset.customize_theme')}
	</button>
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
	<h3 class="settings-block__title" id="appearance-reading-title">{$t('settings.appearance.reading')}</h3>
	<div class="w-srows">
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-text-size">{$t('settings.appearance.text_size')}</p>
				<p class="w-srow__hint">{$t('appset.text_size_hint')}</p>
			</div>
			<div class="w-srow__control">
				<Segmented labelledby="appearance-text-size" options={textSizes} value={textSize} onchange={updateTextSize} />
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-density">{$t('settings.appearance.density')}</p>
				<p class="w-srow__hint">{$t('appset.density_hint')}</p>
			</div>
			<div class="w-srow__control">
				<Segmented
					labelledby="appearance-density"
					options={[{ value: 'cozy', label: $t('settings.appearance.cozy') }, { value: 'compact', label: $t('settings.appearance.compact') }]}
					value={messageDensity}
					onchange={(value) => updateMessageDensity(value as MessageDensity)}
				/>
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-reduce-motion">{$t('settings.appearance.reduce_motion')}</p>
				<p class="w-srow__hint">
					{$t('appset.reduce_motion_hint')}{$profileOsReducedMotion ? ' ' + $t('appset.os_motion') : ''}
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
				<p class="w-srow__label" id="appearance-own-right">{$t('settings.appearance.own_right')}</p>
				<p class="w-srow__hint">{$t('appset.own_right_hint')}</p>
			</div>
			<div class="w-srow__control">
				<Switch labelledby="appearance-own-right" checked={ownMessagesOnRight} onchange={setOwnMessagesOnRight} />
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-language">{languageLabel}</p>
				<p class="w-srow__hint">{$t('appset.language_hint')}</p>
			</div>
			<div class="w-srow__control">
				<Select ariaLabel={languageLabel} heading={languageLabel} align="end" options={languages} value={$currentLocale || 'en'} onchange={changeLanguage} />
			</div>
		</div>
	</div>
</section>

<!-- Chat background: one picker -->
<ChatBackdropSettings />

<!-- Chat -->
<section class="settings-block" aria-labelledby="appearance-chat-title">
	<h3 class="settings-block__title" id="appearance-chat-title">{$t('shell.mobile.chat')}</h3>
	<div class="w-srows">
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-avatars">{$t('appset.avatars')}</p>
				<p class="w-srow__hint">{$t('appset.avatars_hint')}</p>
			</div>
			<div class="w-srow__control">
				<Segmented
					labelledby="appearance-avatars"
					options={[{ value: 'off', label: $t('wb.pattern_none') }, { value: 'user', label: $t('appset.avatars_others') }, { value: 'all', label: $t('panels.everyone') }]}
					value={chatAvatarMode}
					onchange={(value) => updateChatAvatarMode(value as ChatAvatarMode)}
				/>
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-send-button">{$t('appset.send_button')}</p>
				<p class="w-srow__hint">{$t('appset.send_button_hint')}</p>
			</div>
			<div class="w-srow__control">
				<Switch labelledby="appearance-send-button" checked={clickableSendEnabled} onchange={setClickableSend} />
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-deletion-timer">{$t('appset.deletion_timer')}</p>
				<p class="w-srow__hint">{$t('appset.deletion_timer_hint')}</p>
			</div>
			<div class="w-srow__control">
				<Segmented
					labelledby="appearance-deletion-timer"
					options={[{ value: 'off', label: $t('audio_settings.off') }, { value: 'static', label: $t('appset.deletion_expiry') }, { value: 'live', label: $t('appset.deletion_countdown') }]}
					value={deletionCountdownMode}
					onchange={(value) => updateDeletionCountdownMode(value as DeletionCountdownMode)}
				/>
			</div>
		</div>
	</div>
</section>

<!-- Layout -->
<section class="settings-block" aria-labelledby="appearance-layout-title">
	<h3 class="settings-block__title" id="appearance-layout-title">{$t('appset.h_layout')}</h3>
	{#if layoutScopeHint}<p class="settings-block__hint" id="appearance-layout-scope">{layoutScopeHint}</p>{/if}
	<div class="w-srows">
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-open-to">{$t('appset.open_to')}</p>
				<p class="w-srow__hint">{$t('appset.open_to_hint')}</p>
			</div>
			<div class="w-srow__control">
				<Segmented
					labelledby="appearance-open-to"
					options={[{ value: 'last-channel', label: $t('appset.open_last') }, { value: 'server', label: $t('places.server_home') }, { value: 'messages', label: $t('shell.mobile.messages') }]}
					value={openingSurface}
					onchange={(value) => updateOpeningSurface(value as OpeningSurface)}
				/>
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-visible-nav">{$t('appset.visible_nav')}</p>
				<p class="w-srow__hint">{$t('appset.visible_nav_hint')}</p>
			</div>
			<div class="w-srow__control">
				<Segmented
					labelledby="appearance-visible-nav"
					options={[{ value: 'server-browser', label: $t('appset.nav_both') }, { value: 'dm-focused', label: $t('appset.nav_channels') }, { value: 'dm-pure', label: $t('appset.nav_none') }]}
					value={$homeLayout}
					onchange={(value) => homeLayout.set(value as HomeLayoutMode)}
				/>
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-nav-dock">{$t('appset.nav_side')}</p>
				<p class="w-srow__hint">{$t('appset.nav_side_hint')}</p>
			</div>
			<div class="w-srow__control">
				<Segmented
					labelledby="appearance-nav-dock"
					options={[{ value: 'left', label: $t('panels.left') }, { value: 'right', label: $t('panels.right') }]}
					value={$layoutStore.navDock}
					onchange={(value) => layoutStore.setNavDock(value as 'left' | 'right')}
				/>
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-rail-density">{$t('appset.rail_density')}</p>
				<p class="w-srow__hint">{$t('appset.rail_density_hint')}</p>
			</div>
			<div class="w-srow__control">
				<Segmented
					labelledby="appearance-rail-density"
					options={[{ value: 'full', label: $t('appset.rail_full') }, { value: 'icons-only', label: $t('appset.rail_icons') }, { value: 'hidden', label: $t('appset.rail_hidden') }]}
					value={$railDensity}
					onchange={(value) => setRailDensity(value as RailDensity)}
				/>
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-rail-side">{$t('appset.rail_side')}</p>
				<p class="w-srow__hint">{$t('appset.rail_side_hint')}</p>
			</div>
			<div class="w-srow__control">
				<Segmented
					labelledby="appearance-rail-side"
					options={[{ value: 'left', label: $t('panels.left') }, { value: 'right', label: $t('panels.right') }]}
					value={$railSide}
					onchange={(value) => setRailSide(value as RailSide)}
				/>
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-dock-limit">{$t('appset.dock_limit')}</p>
				<p class="w-srow__hint">{$t('appset.dock_limit_hint')}</p>
			</div>
			<div class="w-srow__control">
				<Select
					ariaLabel={$t('appset.dock_limit')}
					align="end"
					options={dockLimits}
					value={String($dockStackLimit)}
					onchange={(value) => layoutStore.setDockStackLimit(Number(value))}
				/>
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-peek-key">{$t('appset.peek')}</p>
				<p class="w-srow__hint">{$t('appset.peek_hint')}</p>
			</div>
			<div class="w-srow__control">
				<Segmented
					labelledby="appearance-peek-key"
					options={[{ value: 'shift', label: $t('appset.key_shift') }, { value: 'alt', label: $t('appset.key_alt') }, { value: 'ctrl', label: $t('appset.key_ctrl') }, { value: 'none', label: $t('appset.peek_hover') }]}
					value={$railPeekKey}
					onchange={(value) => railPeekKey.set(value as RailPeekKey)}
				/>
			</div>
		</div>
		{#if nativeApp}
			<div class="w-srow">
				<div class="w-srow__text">
					<p class="w-srow__label" id="appearance-layout-preset">{$t('appset.layout_preset')}</p>
					<p class="w-srow__hint">{$t('appset.layout_preset_hint')}</p>
				</div>
				<div class="w-srow__control">
					<Select
						ariaLabel={$t('appset.layout_preset')}
						align="end"
						options={$layoutStore.workspaces.map((name) => ({ value: name, label: name }))}
						value={$layoutStore.activeWorkspace}
						onchange={loadWorkspaceByName}
					/>
				</div>
			</div>
			<div class="settings-actions">
				<button type="button" class="w-btn w-btn--sm" on:click={saveWorkspaceAsPrompt}>{$t('appset.save_as')}</button>
				<button type="button" class="w-btn w-btn--sm" on:click={renameWorkspacePrompt}>{$t('appset.rename')}</button>
				<button type="button" class="w-btn w-btn--sm" on:click={exportWorkspaceJson}>{$t('appset.copy_json')}</button>
				<button type="button" class="w-btn w-btn--sm" on:click={importWorkspaceJsonPrompt}>{$t('appset.paste_json')}</button>
				<button type="button" class="w-btn w-btn--sm w-btn--danger" on:click={resetActiveWorkspace}>{$t('appset.reset_layout')}</button>
			</div>
		{/if}
	</div>
</section>

<!-- Media -->
<section class="settings-block" aria-labelledby="appearance-media-title">
	<h3 class="settings-block__title" id="appearance-media-title">{$t('places.media')}</h3>
	<div class="w-srows">
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-video-compression">{$t('appset.video_comp')}</p>
				<p class="w-srow__hint">{$t('appset.video_hint', { values: { runtime: videoCompressionRuntimeLabel } })}</p>
			</div>
			<div class="w-srow__control">
				<Switch labelledby="appearance-video-compression" checked={videoCompressionEnabled} onchange={setVideoCompression} />
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-video-preset">{$t('appset.default_quality')}</p>
				<p class="w-srow__hint">
					{#if !videoCompressionEnabled}{$t('appset.video_turn_on')}{:else}{selectedPreset?.description ?? $t('appset.quality_default')}{/if}
				</p>
			</div>
			<div class="w-srow__control">
				<Select
					ariaLabel={$t('appset.default_quality')}
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
	<h3 class="settings-block__title" id="appearance-decorations-title">{$t('appset.h_decorations')}</h3>
	<p class="settings-block__hint">{$t('appset.decorations_hint')}</p>
	<div class="w-srows">
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-decorations">{$t('appset.show_decorations')}</p>
				<p class="w-srow__hint">{$t('appset.show_decorations_hint')}</p>
			</div>
			<div class="w-srow__control">
				<Switch labelledby="appearance-decorations" checked={profileDecorations} onchange={(value) => setProfileAppearance({ showCosmetics: value })} />
			</div>
		</div>
		{#each decorationRows as row (row.key)}
			<div class="w-srow settings-srow--sub" class:settings-srow--off={!profileDecorations}>
				<div class="w-srow__text">
					<p class="w-srow__label" id="appearance-decoration-{row.key}">{$t(row.label)}</p>
					<p class="w-srow__hint">
						{#if !profileDecorations}{$t('appset.dec_turn_on')}{:else if row.key === 'animate'}{$t(row.hint)} {$t('appset.dec_reduce_keep')}{:else}{$t(row.hint)}{/if}
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
	<h3 class="settings-block__title" id="appearance-performance-title">{$t('appset.h_performance')}</h3>
	{#if !$animationQuality.userOverride}
		<p class="settings-block__hint">
			{$t('appset.perf_tuned', { values: { tier: $t(deviceTierPhrase($animationQuality.tier)), anim: $animationQuality.cssOnly ? $t('appset.anim_simple') : $t('appset.anim_full'), windows: $animationQuality.disableWindows ? $t('appset.win_inline') : $t('appset.win_popout') } })}
			
		</p>
	{/if}
	<div class="w-srows">
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="appearance-css-animations">
					{$t('appset.simple_anim')}
					{#if $animationQuality.cssOnly && !$animationQuality.userOverride}<span class="w-tag settings-auto-tag">{$t('appset.auto')}</span>{/if}
				</p>
				<p class="w-srow__hint">{$t('appset.simple_anim_hint')}</p>
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
					{$t('appset.keep_inline')}
					{#if $animationQuality.disableWindows && !$animationQuality.userOverride}<span class="w-tag settings-auto-tag">{$t('appset.auto')}</span>{/if}
				</p>
				<p class="w-srow__hint">{$t('appset.keep_inline_hint')}</p>
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
