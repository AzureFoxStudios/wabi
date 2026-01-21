<script lang="ts">
	import { themeStore, currentTheme } from '$lib/theme/themeStore';
	import { saveThemePreferences, resetThemePreferences } from '$lib/theme/themeApi';
	import ColorPicker from './ColorPicker.svelte';
	import GradientEditor from './GradientEditor.svelte';
	import ThemePreview from './ThemePreview.svelte';
	import BackgroundImageEditor from './BackgroundImageEditor.svelte';
	import type { CustomTheme } from '$lib/types/theme';

	let customColors: CustomTheme['colors'] = {
		bgPrimary: '#0f0c29',
		textPrimary: '#e0e0ff',
		accent: '#ff00ff'
	};

	let customGradients: CustomTheme['gradients'] = {
		primary: 'linear-gradient(to right, #0f0c29 0%, #302b63 100%)',
		accent: 'linear-gradient(to right, #ff00ff 0%, #ff69b4 100%)'
	};

	let isExpanded = false;
	let isSaving = false;
	let showResetConfirm = false;

	// Initialize from current custom theme
	$: if ($themeStore.themeId === 'custom' && $themeStore.customTheme) {
		customColors = { ...$themeStore.customTheme.colors };
		customGradients = { ...$themeStore.customTheme.gradients };
	}

	async function handleSaveCustomTheme() {
		try {
			isSaving = true;
			const customTheme: CustomTheme = {
				colors: customColors,
				gradients: customGradients
			};

			themeStore.setCustomTheme(customTheme);

			// Save to server if registered
			const isRegistered = !!localStorage.getItem('authToken');
			if (isRegistered) {
				await saveThemePreferences({
					theme_id: 'custom',
					custom_theme: customTheme
				});
			}

			alert('Custom theme saved!');
		} catch (error) {
			console.error('Failed to save custom theme:', error);
			alert('Failed to save custom theme. Please try again.');
		} finally {
			isSaving = false;
		}
	}

	async function handleReset() {
		try {
			isSaving = true;
			const isRegistered = !!localStorage.getItem('authToken');

			if (isRegistered) {
				await resetThemePreferences();
			}

			themeStore.reset();
			showResetConfirm = false;
			alert('Theme reset to default!');
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
				gradients: customGradients
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
					alert('Theme imported! Click "Save Custom Theme" to apply it.');
				}
			} catch (error) {
				alert('Failed to import theme. Make sure it\'s a valid JSON file.');
			}
		};
		reader.readAsText(file);
	}
</script>

<div class="theme-customizer">
	<div class="customizer-header" on:click={() => (isExpanded = !isExpanded)}>
		<h3>🎨 Create Custom Theme</h3>
		<span class="expand-icon">{isExpanded ? '▼' : '▶'}</span>
	</div>

	{#if isExpanded}
		<div class="customizer-content">
			<!-- Color Customization -->
			<section class="section">
				<h4>Colors</h4>
				<div class="color-grid">
					<ColorPicker
						label="Background Primary"
						value={customColors.bgPrimary || '#0f0c29'}
						onChange={(c) => (customColors.bgPrimary = c)}
					/>
					<ColorPicker
						label="Text Primary"
						value={customColors.textPrimary || '#e0e0ff'}
						onChange={(c) => (customColors.textPrimary = c)}
					/>
					<ColorPicker
						label="Accent Color"
						value={customColors.accent || '#ff00ff'}
						onChange={(c) => (customColors.accent = c)}
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
						{isSaving ? '💾 Saving...' : '💾 Save Custom Theme'}
					</button>

					<div class="import-export-group">
						<button class="btn btn-secondary" on:click={exportTheme}>
							📥 Export Theme
						</button>
						<label class="btn btn-secondary">
							📤 Import Theme
							<input type="file" accept=".json" on:change={importTheme} style="display: none;" />
						</label>
					</div>

					{#if showResetConfirm}
						<div class="confirm-dialog">
							<p>Reset theme to default? This cannot be undone.</p>
							<div class="confirm-buttons">
								<button class="btn btn-danger" on:click={handleReset} disabled={isSaving}>
									{isSaving ? '⏳ Resetting...' : '🔄 Yes, Reset'}
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
							🔄 Reset to Default
						</button>
					{/if}
				</div>
			</section>
		</div>
	{/if}
</div>

<style>
	.theme-customizer {
		background: var(--bg-secondary);
		border: 1px solid rgba(var(--accent-rgb), 0.2);
		border-radius: 8px;
		overflow: hidden;
	}

	.customizer-header {
		padding: 1rem;
		background: var(--ui-bg-lighter);
		border-bottom: 1px solid rgba(var(--accent-rgb), 0.1);
		display: flex;
		justify-content: space-between;
		align-items: center;
		cursor: pointer;
		transition: all 0.2s;
	}

	.customizer-header:hover {
		background: var(--ui-bg-light);
	}

	.customizer-header h3 {
		margin: 0;
		color: var(--text-primary);
		font-size: 1rem;
	}

	.expand-icon {
		color: var(--text-secondary);
		transition: transform 0.2s;
	}

	.customizer-content {
		padding: 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 2rem;
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
		margin: 0 0 1rem 0;
		color: var(--text-primary);
		font-size: 0.95rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		opacity: 0.8;
	}

	.color-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 1rem;
	}

	.gradient-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
		gap: 1rem;
	}

	.preview-section {
		border-top: 1px solid rgba(var(--accent-rgb), 0.1);
		padding-top: 2rem;
	}

	.actions-section {
		border-top: 1px solid rgba(var(--accent-rgb), 0.1);
		padding-top: 2rem;
	}

	.action-buttons {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.btn {
		padding: 0.75rem 1.25rem;
		border: none;
		border-radius: 6px;
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
		background: var(--accent-hex);
		color: white;
	}

	.btn-primary:hover:not(:disabled) {
		transform: translateY(-2px);
		box-shadow: 0 4px 12px rgba(var(--accent-rgb), 0.3);
	}

	.btn-secondary {
		background: var(--ui-bg-lighter);
		color: var(--text-primary);
		border: 1px solid rgba(var(--accent-rgb), 0.2);
	}

	.btn-secondary:hover:not(:disabled) {
		border-color: var(--accent-hex);
		background: var(--ui-bg-light);
	}

	.btn-warning {
		background: rgba(249, 115, 22, 0.2);
		color: #f97316;
		border: 1px solid #f97316;
	}

	.btn-warning:hover:not(:disabled) {
		background: rgba(249, 115, 22, 0.3);
	}

	.btn-danger {
		background: rgba(239, 68, 68, 0.2);
		color: #ef4444;
		border: 1px solid #ef4444;
	}

	.btn-danger:hover:not(:disabled) {
		background: rgba(239, 68, 68, 0.3);
	}

	.import-export-group {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
	}

	.confirm-dialog {
		padding: 1rem;
		background: rgba(239, 68, 68, 0.1);
		border: 1px solid #ef4444;
		border-radius: 6px;
		color: var(--text-primary);
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
</style>
