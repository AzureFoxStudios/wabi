<script lang="ts">
	import { get } from 'svelte/store';
	import { themeStore, currentTheme } from '$lib/theme/themeStore';
	import { saveThemePreferences, resetThemePreferences } from '$lib/theme/themeApi';
	import { applyPanelColors, contrastText } from '$lib/theme/panelColors';
	import ColorPicker from './ColorPicker.svelte';
	import GradientEditor from './GradientEditor.svelte';
	import ThemePreview from './ThemePreview.svelte';
	import BackgroundImageEditor from './BackgroundImageEditor.svelte';
	import type { CustomTheme, PanelColors, PanelColorOverride } from '$lib/types/theme';
	import { getAuthToken } from '$lib/authSession';

	let customColors: CustomTheme['colors'] = {
		bgPrimary: '#0f0c29',
		bgSecondary: '#1a1a2e',
		bgTertiary: '#24243e',
		textPrimary: '#e0e0ff',
		textSecondary: '#b3b3ff',
		textTertiary: '#9999ff',
		accent: '#ff00ff',
		accentHex: '#ff00ff',
		accentRgb: '255, 0, 255',
		border: '#302b63',
		borderRgb: '48, 43, 99'
	};

	let customGradients: CustomTheme['gradients'] = {
		primary: 'linear-gradient(to right, #0f0c29 0%, #302b63 100%)',
		accent: 'linear-gradient(to right, #ff00ff 0%, #ff69b4 100%)',
		accentHover: 'linear-gradient(to right, #ff69b4 0%, #ff1493 100%)'
	};

	// Per-panel color overrides (server rail, left sidebar, center, right panel)
	type PanelKey = 'serverRail' | 'leftSidebar' | 'center' | 'rightPanel';
	const PANEL_META: { key: PanelKey; label: string; solidDefault: string; solidOnly?: boolean }[] = [
		{ key: 'serverRail', label: 'Server Rail', solidDefault: '#0f0c29' },
		{ key: 'leftSidebar', label: 'Left Sidebar', solidDefault: '#1a1a2e' },
		{ key: 'center', label: 'Center Chat', solidDefault: '#0f0c29', solidOnly: true },
		{ key: 'rightPanel', label: 'Right Panel', solidDefault: '#1a1a2e' }
	];

	function defaultOverride(solid: string): PanelColorOverride {
		return { enabled: false, mode: 'solid', bg: solid, autoText: true, text: '#f5f5f7' };
	}

	// Master switch + which panel is being edited (progressive disclosure).
	let panelColorsEnabled = false;
	let selectedPanel: PanelKey = 'leftSidebar';

	let panelColors: PanelColors = {
		enabled: false,
		serverRail: defaultOverride('#0f0c29'),
		leftSidebar: defaultOverride('#1a1a2e'),
		center: defaultOverride('#0f0c29'),
		rightPanel: defaultOverride('#1a1a2e')
	};

	let isExpanded = false;
	let isSaving = false;
	let showResetConfirm = false;
	let panelColorsInitialized = false;

	// Initialize from current custom theme
	$: if ($themeStore.themeId === 'custom' && $themeStore.customTheme) {
		customColors = { ...$themeStore.customTheme.colors };
		customGradients = { ...$themeStore.customTheme.gradients };
		if (!panelColorsInitialized && $themeStore.customTheme.panelColors) {
			const saved = $themeStore.customTheme.panelColors;
			for (const meta of PANEL_META) {
				const savedPanel = saved[meta.key];
				if (savedPanel) panelColors[meta.key] = { ...defaultOverride(meta.solidDefault), ...savedPanel };
			}
			// Master on if explicitly enabled, or any panel is active (older saves).
			panelColorsEnabled =
				saved.enabled ?? PANEL_META.some((m) => panelColors[m.key]?.enabled);
			panelColors.enabled = panelColorsEnabled;
			panelColors = panelColors;
			panelColorsInitialized = true;
		}
	}

	function panelBgValue(key: PanelKey): string {
		return panelColors[key]?.bg || PANEL_META.find((m) => m.key === key)!.solidDefault;
	}

	function syncPanels(): void {
		panelColors.enabled = panelColorsEnabled;
		panelColors = panelColors;
		applyPanelColors(panelColors);
	}

	function toggleMaster(on: boolean): void {
		panelColorsEnabled = on;
		syncPanels();
	}

	function updatePanel(key: PanelKey, patch: Partial<PanelColorOverride>): void {
		panelColors[key] = { ...panelColors[key], ...patch };
		syncPanels();
	}

	function autoTextPreview(key: PanelKey): string {
		return contrastText(panelBgValue(key)).base;
	}

	function normalizeHex(value: string | undefined, fallback: string): string {
		if (!value) return fallback;
		const normalized = value.trim();
		return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized : fallback;
	}

	function hexToRgb(value: string): string {
		const normalized = normalizeHex(value, '#ff00ff').slice(1);
		const red = parseInt(normalized.slice(0, 2), 16);
		const green = parseInt(normalized.slice(2, 4), 16);
		const blue = parseInt(normalized.slice(4, 6), 16);
		return `${red}, ${green}, ${blue}`;
	}

	function composeCustomTheme(): CustomTheme {
		const activeState = get(themeStore);
		const accentHex = normalizeHex(customColors?.accentHex || customColors?.accent, '#ff00ff');
		const borderHex = normalizeHex(customColors?.border, '#302b63');
		return {
			...activeState.customTheme,
			colors: {
				...activeState.customTheme?.colors,
				...customColors,
				accent: customColors?.accent || accentHex,
				accentHex,
				accentRgb: hexToRgb(accentHex),
				border: borderHex,
				borderRgb: hexToRgb(borderHex)
			},
			gradients: {
				...activeState.customTheme?.gradients,
				...customGradients
			},
			backgroundImage: activeState.customTheme?.backgroundImage,
			panelColors: { ...panelColors }
		};
	}

	async function handleSaveCustomTheme() {
		try {
			isSaving = true;
			const customTheme = composeCustomTheme();

			themeStore.setCustomTheme(customTheme);

			// Save to server if registered
			const authToken = getAuthToken();
			const isRegistered = !!authToken;

			if (isRegistered) {
				await saveThemePreferences({
					theme_id: 'custom',
					custom_theme: customTheme
				});
			}

			isExpanded = false;
		} catch (error) {
			console.error('Failed to save custom theme:', error);
			alert(`Failed to save custom theme. ${error instanceof Error ? error.message : 'Please try again.'}`);
		} finally {
			isSaving = false;
		}
	}

	async function handleReset() {
		try {
			isSaving = true;
			const isRegistered = !!getAuthToken();

			if (isRegistered) {
				await resetThemePreferences();
			}

			themeStore.reset();
			showResetConfirm = false;
		} catch (error) {
			console.error('Failed to reset theme:', error);
			alert('Failed to reset theme. Please try again.');
		} finally {
			isSaving = false;
		}
	}

	function captureEffect() {
		const cs = getComputedStyle(document.documentElement);
		return {
			effect: cs.getPropertyValue('--bg-effect-effect').trim() || 'none',
			color: cs.getPropertyValue('--bg-effect-color').trim() || '#6366f1',
			intensity: parseFloat(cs.getPropertyValue('--bg-effect-intensity')) || 0,
			size: parseFloat(cs.getPropertyValue('--bg-effect-size')) || 1,
			speed: parseFloat(cs.getPropertyValue('--bg-effect-speed')) || 1
		};
	}

	function applyEffectVars(effect: Record<string, any>) {
		const root = document.documentElement;
		root.style.setProperty('--bg-effect-effect', effect.effect || 'none');
		root.style.setProperty('--bg-effect-color', effect.color || '#6366f1');
		root.style.setProperty('--bg-effect-intensity', String(effect.intensity ?? 0));
		root.style.setProperty('--bg-effect-size', String(effect.size ?? 1));
		root.style.setProperty('--bg-effect-speed', String(effect.speed ?? 1));
	}

	function exportTheme() {
		const data = {
			name: 'Custom Theme',
			theme: {
				colors: customColors,
				gradients: customGradients,
				panelColors,
				backgroundImage: get(themeStore).customTheme?.backgroundImage,
				effect: captureEffect()
			},
			exportedAt: new Date().toISOString()
		};

		const json = JSON.stringify(data, null, 2);
		const blob = new Blob([json], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `wabi-theme-${Date.now()}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}

	function importTheme(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) return;

		const reader = new FileReader();
		reader.onload = (event) => {
			try {
				const data = JSON.parse(event.target?.result as string);
				if (data.theme?.colors || data.theme?.gradients || data.theme?.panelColors) {
					customColors = { ...customColors, ...data.theme.colors };
					customGradients = { ...customGradients, ...data.theme.gradients };
					if (data.theme.panelColors) {
						for (const meta of PANEL_META) {
							const imported = data.theme.panelColors[meta.key];
							if (imported) panelColors[meta.key] = { ...defaultOverride(meta.solidDefault), ...imported };
						}
						panelColorsEnabled =
							data.theme.panelColors.enabled ??
							PANEL_META.some((m) => panelColors[m.key]?.enabled);
						panelColors.enabled = panelColorsEnabled;
						panelColors = panelColors;
						applyPanelColors(panelColors);
					}
					if (data.theme.backgroundImage) {
						themeStore.setCustomTheme({
							...get(themeStore).customTheme,
							backgroundImage: data.theme.backgroundImage
						});
					}
					if (data.theme.effect) applyEffectVars(data.theme.effect);
					isExpanded = true;
				}
			} catch (error) {
				alert('Failed to import theme. Make sure it\'s a valid JSON file.');
			}
		};
		reader.readAsText(file);
	}
</script>

<div class="theme-customizer">
	<div
		class="customizer-header"
		role="button"
		tabindex="0"
		on:click={() => (isExpanded = !isExpanded)}
		on:keydown={(event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				isExpanded = !isExpanded;
			}
		}}
	>
		<div>
			<h3>Create Custom Theme</h3>
			<p>Start from the active theme, then tune surfaces, text, accent, and background.</p>
		</div>
		<span class="expand-icon">{isExpanded ? 'Hide' : 'Customize'}</span>
	</div>

	{#if isExpanded}
		<div class="customizer-content">
			<!-- Color Customization -->
			<section class="section">
				<h4>Colors</h4>
				<div class="color-grid">
					<ColorPicker
						label="App Background"
						value={customColors.bgPrimary || '#0f0c29'}
						onChange={(c) => (customColors.bgPrimary = c)}
					/>
					<ColorPicker
						label="Panel Surface"
						value={customColors.bgSecondary || '#1a1a2e'}
						onChange={(c) => (customColors.bgSecondary = c)}
					/>
					<ColorPicker
						label="Raised Surface"
						value={customColors.bgTertiary || '#24243e'}
						onChange={(c) => (customColors.bgTertiary = c)}
					/>
					<ColorPicker
						label="Text Primary"
						value={customColors.textPrimary || '#e0e0ff'}
						onChange={(c) => (customColors.textPrimary = c)}
					/>
					<ColorPicker
						label="Text Secondary"
						value={customColors.textSecondary || '#b3b3ff'}
						onChange={(c) => (customColors.textSecondary = c)}
					/>
					<ColorPicker
						label="Accent Color"
						value={customColors.accentHex || customColors.accent || '#ff00ff'}
						onChange={(c) => {
							customColors.accent = c;
							customColors.accentHex = c;
							customColors.accentRgb = hexToRgb(c);
						}}
					/>
					<ColorPicker
						label="Border"
						value={customColors.border || '#302b63'}
						onChange={(c) => {
							customColors.border = c;
							customColors.borderRgb = hexToRgb(c);
						}}
					/>
				</div>
			</section>

			<!-- Gradient Customization -->
			<section class="section">
				<h4>Gradients</h4>
				<div class="gradient-grid">
					<GradientEditor
						label="Primary Gradient"
						value={customGradients.primary || 'linear-gradient(90deg, #0f0c29 0%, #302b63 100%)'}
						onChange={(g) => (customGradients.primary = g)}
					/>
					<GradientEditor
						label="Accent Gradient"
						value={customGradients.accent || 'linear-gradient(90deg, #ff00ff 0%, #ff69b4 100%)'}
						onChange={(g) => (customGradients.accent = g)}
					/>
					<GradientEditor
						label="Accent Hover"
						value={customGradients.accentHover || 'linear-gradient(90deg, #ff69b4 0%, #ff1493 100%)'}
						onChange={(g) => (customGradients.accentHover = g)}
					/>
				</div>
			</section>

			<!-- Per-Panel Colors -->
			<section class="section">
				<h4>Panel Colors</h4>

				<!-- Step 1: separate the panels before touching colors -->
				<label class="panel-master">
					<input
						type="checkbox"
						checked={panelColorsEnabled}
						on:change={(e) => toggleMaster(e.currentTarget.checked)}
					/>
					<span class="panel-master-copy">
						<strong>Color panels independently</strong>
						<small>
							Give the sidebar, chat, and side panels their own colors instead of one
							app-wide look.
						</small>
					</span>
				</label>

				{#if panelColorsEnabled}
					<!-- Step 2: pick which panel to edit -->
					<div class="panel-picker" role="tablist" aria-label="Choose a panel">
						{#each PANEL_META as meta (meta.key)}
							<button
								type="button"
								role="tab"
								aria-selected={selectedPanel === meta.key}
								class="panel-tab-btn"
								class:panel-tab-selected={selectedPanel === meta.key}
								on:click={() => (selectedPanel = meta.key)}
							>
								<span
									class="panel-swatch"
									style:background={panelColors[meta.key]?.enabled
										? panelBgValue(meta.key)
										: 'transparent'}
									class:panel-swatch-empty={!panelColors[meta.key]?.enabled}
								></span>
								{meta.label}
							</button>
						{/each}
					</div>

					<!-- Step 3: basic colors for the selected panel -->
					{#each PANEL_META as meta (meta.key)}
						{#if selectedPanel === meta.key}
							<div class="panel-editor">
								<label class="panel-toggle panel-toggle-inline">
									<input
										type="checkbox"
										checked={panelColors[meta.key]?.enabled ?? false}
										on:change={(e) =>
											updatePanel(meta.key, { enabled: e.currentTarget.checked })}
									/>
									<span>Custom color for {meta.label}</span>
								</label>

								{#if panelColors[meta.key]?.enabled}
									{#if !meta.solidOnly}
										<div class="panel-mode">
											<button
												type="button"
												class="mode-btn"
												class:mode-active={(panelColors[meta.key]?.mode ?? 'solid') === 'solid'}
												on:click={() =>
													updatePanel(meta.key, { mode: 'solid', bg: panelBgValue(meta.key) })}
											>
												Solid
											</button>
											<button
												type="button"
												class="mode-btn"
												class:mode-active={panelColors[meta.key]?.mode === 'gradient'}
												on:click={() =>
													updatePanel(meta.key, {
														mode: 'gradient',
														bg: `linear-gradient(180deg, ${panelBgValue(meta.key)} 0%, ${panelBgValue(meta.key)} 100%)`
													})}
											>
												Gradient
											</button>
										</div>
									{/if}

									{#if panelColors[meta.key]?.mode === 'gradient' && !meta.solidOnly}
										<GradientEditor
											label="Background Gradient"
											value={panelBgValue(meta.key)}
											onChange={(g) => updatePanel(meta.key, { bg: g })}
										/>
									{:else}
										<ColorPicker
											label="Background"
											value={panelBgValue(meta.key)}
											onChange={(c) => updatePanel(meta.key, { bg: c, mode: 'solid' })}
										/>
									{/if}

									<label class="panel-toggle panel-toggle-inline">
										<input
											type="checkbox"
											checked={panelColors[meta.key]?.autoText !== false}
											on:change={(e) =>
												updatePanel(meta.key, { autoText: e.currentTarget.checked })}
										/>
										<span>Auto-contrast text (recommended)</span>
									</label>

									{#if panelColors[meta.key]?.autoText === false}
										<ColorPicker
											label="Text Color"
											value={panelColors[meta.key]?.text || autoTextPreview(meta.key)}
											onChange={(c) => updatePanel(meta.key, { text: c })}
										/>
									{/if}
								{:else}
									<p class="section-hint">
										Turn on “Custom color for {meta.label}” to set its background and text.
									</p>
								{/if}
							</div>
						{/if}
					{/each}
				{/if}
			</section>

			<!-- Background Image -->
			<section class="section">
				<h4>Background Image</h4>
				<BackgroundImageEditor />
			</section>

			<!-- Live Preview -->
			<section class="section preview-section">
				<h4>Preview</h4>
				<ThemePreview theme={{
					id: 'custom-preview',
					name: 'Custom Theme Preview',
					description: 'How your theme will look',
					colors: customColors as any,
					gradients: customGradients as any
				}} />
			</section>

			<!-- Actions -->
			<section class="section actions-section">
				<h4>Actions</h4>
				<div class="action-buttons">
					<button
						class="btn btn-primary"
						on:click={handleSaveCustomTheme}
						disabled={isSaving}
					>
						{isSaving ? 'Saving...' : 'Save Custom Theme'}
					</button>

					<div class="import-export-group">
						<button class="btn btn-secondary" on:click={exportTheme}>
							Export Theme
						</button>
						<label class="btn btn-secondary">
							Import Theme
							<input type="file" accept=".json" on:change={importTheme} class="hidden" />
						</label>
					</div>

					{#if showResetConfirm}
						<div class="confirm-dialog">
							<p>Reset theme to default? This cannot be undone.</p>
							<div class="confirm-buttons">
								<button class="btn btn-danger" on:click={handleReset} disabled={isSaving}>
									{isSaving ? 'Resetting...' : 'Yes, Reset'}
								</button>
								<button class="btn btn-secondary" on:click={() => (showResetConfirm = false)}>
									Cancel
								</button>
							</div>
						</div>
					{:else}
						<button
							class="btn btn-warning"
							on:click={() => (showResetConfirm = true)}
							disabled={isSaving}
						>
							Reset to Default
						</button>
					{/if}
				</div>
			</section>
		</div>
	{/if}
</div>

<style>
	.theme-customizer {
		background:
			linear-gradient(180deg, color-mix(in srgb, var(--surface-base) 92%, transparent), color-mix(in srgb, var(--surface-raised) 88%, transparent)),
			var(--surface-base);
		border: 1px solid color-mix(in srgb, var(--border-subtle) 78%, rgba(var(--accent-rgb), 0.24));
		border-radius: 16px;
		overflow: hidden;
		box-shadow: 0 14px 34px var(--shadow-sm, var(--shadow-sm, rgba(0, 0, 0, 0.14)));
	}

	.customizer-header {
		padding: 1rem 1.1rem;
		background:
			radial-gradient(circle at top right, rgba(var(--accent-rgb), 0.18), transparent 42%),
			color-mix(in srgb, var(--surface-raised) 90%, transparent);
		border-bottom: 1px solid color-mix(in srgb, var(--border-subtle) 82%, transparent);
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		cursor: pointer;
		transition: all 0.2s;
	}

	.customizer-header:hover {
		background: var(--ui-bg-light);
	}

	.customizer-header h3 {
		margin: 0;
		color: var(--text-heading);
		font-size: 1rem;
	}

	.customizer-header p {
		margin: 0.25rem 0 0;
		color: var(--text-secondary);
		font-size: 0.8rem;
		line-height: 1.4;
	}

	.expand-icon {
		flex-shrink: 0;
		padding: 0.38rem 0.66rem;
		border-radius: 999px;
		border: 1px solid rgba(var(--accent-rgb), 0.28);
		background: rgba(var(--accent-rgb), 0.12);
		color: var(--text-heading);
		font-size: 0.76rem;
		font-weight: 700;
	}

	.customizer-content {
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 1.1rem;
		animation: slideDown 0.3s ease-out;
	}

	@keyframes slideDown {
		from {
			opacity: 0;
			transform: translateY(-10px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.section h4 {
		margin: 0 0 0.75rem 0;
		color: var(--text-heading);
		font-size: 0.95rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		opacity: 0.8;
	}

	.color-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(175px, 1fr));
		gap: 0.7rem;
	}

	.gradient-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
		gap: 0.7rem;
	}

	.section-hint {
		margin: 0 0 0.75rem;
		color: var(--text-secondary);
		font-size: 0.8rem;
		line-height: 1.4;
	}

	.panel-master {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
		padding: 0.75rem;
		border: 1px solid color-mix(in srgb, var(--border-subtle) 80%, transparent);
		border-radius: 12px;
		background: color-mix(in srgb, var(--surface-raised) 60%, transparent);
		cursor: pointer;
	}

	.panel-master input {
		margin-top: 0.2rem;
	}

	.panel-master-copy {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.panel-master-copy strong {
		color: var(--text-heading);
		font-size: 0.9rem;
	}

	.panel-master-copy small {
		color: var(--text-secondary);
		font-size: 0.78rem;
		line-height: 1.4;
	}

	.panel-picker {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-top: 0.85rem;
	}

	.panel-tab-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.4rem 0.7rem;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--border-subtle) 80%, transparent);
		background: transparent;
		color: var(--text-secondary);
		font-size: 0.8rem;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.15s;
	}

	.panel-tab-selected {
		border-color: rgba(var(--accent-rgb), 0.5);
		background: rgba(var(--accent-rgb), 0.14);
		color: var(--text-heading);
	}

	.panel-swatch {
		width: 14px;
		height: 14px;
		border-radius: 4px;
		border: 1px solid rgba(var(--text-secondary-rgb, 179, 179, 255), 0.4);
		flex-shrink: 0;
	}

	.panel-swatch-empty {
		background:
			linear-gradient(45deg, transparent 46%, rgba(var(--text-secondary-rgb, 179, 179, 255), 0.5) 46%, rgba(var(--text-secondary-rgb, 179, 179, 255), 0.5) 54%, transparent 54%);
	}

	.panel-editor {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		margin-top: 0.85rem;
		padding: 0.85rem;
		border: 1px solid color-mix(in srgb, var(--border-subtle) 80%, transparent);
		border-radius: 12px;
		background: color-mix(in srgb, var(--surface-raised) 45%, transparent);
	}

	.panel-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.78rem;
		color: var(--text-secondary);
		cursor: pointer;
	}

	.panel-toggle-inline {
		font-size: 0.82rem;
		color: var(--text-heading);
	}

	.panel-mode {
		display: inline-flex;
		border: 1px solid color-mix(in srgb, var(--border-subtle) 80%, transparent);
		border-radius: 999px;
		overflow: hidden;
		align-self: flex-start;
	}

	.mode-btn {
		padding: 0.3rem 0.85rem;
		font-size: 0.78rem;
		font-weight: 600;
		background: transparent;
		color: var(--text-secondary);
		border: none;
		cursor: pointer;
		transition: all 0.15s;
	}

	.mode-active {
		background: rgba(var(--accent-rgb), 0.18);
		color: var(--text-heading);
	}

	.preview-section {
		border-top: 1px solid color-mix(in srgb, var(--border-subtle) 82%, transparent);
		padding-top: 1rem;
	}

	.actions-section {
		border-top: 1px solid color-mix(in srgb, var(--border-subtle) 82%, transparent);
		padding-top: 1rem;
	}

	.action-buttons {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.btn {
		padding: 0.75rem 1.25rem;
		border: 1px solid transparent;
		border-radius: 10px;
		font-size: 0.9rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.2s;
		text-align: center;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-primary {
		background: var(--accent-primary-color);
		color: var(--text-inverse, #fff);
		border-color: rgba(var(--accent-rgb), 0.35);
	}

	.btn-primary:hover:not(:disabled) {
		transform: translateY(-2px);
		box-shadow: 0 4px 12px rgba(var(--accent-rgb), 0.3);
	}

	.btn-secondary {
		background: color-mix(in srgb, var(--surface-raised) 84%, transparent);
		color: var(--text-heading);
		border-color: color-mix(in srgb, var(--border-subtle) 78%, rgba(var(--accent-rgb), 0.18));
	}

	.btn-secondary:hover:not(:disabled) {
		border-color: var(--accent-primary-color);
		background: var(--ui-bg-light);
	}

	.btn-warning {
		background: rgba(249, 115, 22, 0.2);
		color: var(--color-warning, var(--color-warning, #f97316));
		border: 1px solid var(--color-warning, var(--color-warning, #f97316));
	}

	.btn-warning:hover:not(:disabled) {
		background: rgba(249, 115, 22, 0.3);
	}

	.btn-danger {
		background: var(--accent-danger-soft, rgba(var(--color-danger-rgb, 239, 68, 68), 0.2));
		color: var(--color-danger, #ef4444);
		border: 1px solid var(--color-danger, #ef4444);
	}

	.btn-danger:hover:not(:disabled) {
		background: rgba(var(--color-danger-rgb, 239, 68, 68), 0.3);
	}

	.import-export-group {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
	}

	.confirm-dialog {
		padding: 1rem;
		background: var(--accent-danger-soft, rgba(var(--color-danger-rgb, 239, 68, 68), 0.1));
		border: 1px solid var(--color-danger, #ef4444);
		border-radius: 6px;
		color: var(--text-heading);
	}

	.confirm-dialog p {
		margin: 0 0 1rem 0;
		font-size: 0.9rem;
	}

	.confirm-buttons {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
	}

	@media (max-width: 640px) {
		.customizer-header {
			align-items: flex-start;
			flex-direction: column;
		}

		.expand-icon {
			width: 100%;
		}

		.import-export-group,
		.confirm-buttons {
			grid-template-columns: 1fr;
		}
	}
</style>
