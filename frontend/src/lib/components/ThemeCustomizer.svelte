<script lang="ts">
	import { get } from 'svelte/store';
	import { themeStore, currentTheme } from '$lib/theme/themeStore';
	import { saveThemePreferences, resetThemePreferences } from '$lib/theme/themeApi';
	import ColorPicker from './ColorPicker.svelte';
	import GradientEditor from './GradientEditor.svelte';
	import ThemePreview from './ThemePreview.svelte';
	import BackgroundImageEditor from './BackgroundImageEditor.svelte';
	import type { CustomTheme } from '$lib/types/theme';
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

	let isExpanded = false;
	let isSaving = false;
	let showResetConfirm = false;

	// Initialize from current custom theme
	$: if ($themeStore.themeId === 'custom' && $themeStore.customTheme) {
		customColors = { ...$themeStore.customTheme.colors };
		customGradients = { ...$themeStore.customTheme.gradients };
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
			backgroundImage: activeState.customTheme?.backgroundImage
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

	function exportTheme() {
		const data = {
			name: 'Custom Theme',
			theme: {
				colors: customColors,
				gradients: customGradients,
				backgroundImage: get(themeStore).customTheme?.backgroundImage
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
				if (data.theme?.colors || data.theme?.gradients) {
					customColors = { ...customColors, ...data.theme.colors };
					customGradients = { ...customGradients, ...data.theme.gradients };
					if (data.theme.backgroundImage) {
						themeStore.setCustomTheme({
							...get(themeStore).customTheme,
							backgroundImage: data.theme.backgroundImage
						});
					}
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
		background: var(--accent-primary);
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
		border-color: var(--accent-primary);
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
