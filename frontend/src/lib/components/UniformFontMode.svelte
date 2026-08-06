<script lang="ts">
	import { onDestroy } from 'svelte';
	import { themeStore } from '../theme/themeStore';
	import { themeApi } from '../theme/themeApi';

	// Font options
	const fontFamilies = ['Arial', 'Georgia', 'Times New Roman', 'Comic Sans MS', 'Courier New', 'Trebuchet MS', 'Verdana', 'Impact', 'Palatino', 'Helvetica'];
	const fontSizes = ['Small', 'Medium', 'Large', 'XL'];
	const fontWeights = ['Normal', 'Medium', 'Semi-Bold', 'Bold'];
	const fontStyles = ['Normal', 'Italic'];

	// Map display names to actual values
	const sizeMap = { Small: '0.9em', Medium: '1em', Large: '1.2em', XL: '1.4em' };
	const weightMap = { Normal: '400', Medium: '500', 'Semi-Bold': '600', Bold: '700' };
	const styleMap = { Normal: 'normal', Italic: 'italic' };

	let isSaving = false;
	let saveSuccess = false;
	let saveError: string | null = null;

	let uniformFontEnabled = false;
	let selectedFamily = 'Arial';
	let selectedSize = 'Medium';
	let selectedWeight = 'Semi-Bold';
	let selectedStyle = 'Normal';

	// Subscribe to theme store
	const unsubscribe = themeStore.subscribe((state) => {
		uniformFontEnabled = state.uniformFontEnabled;
		selectedFamily = state.uniformFontFamily !== 'inherit' ? state.uniformFontFamily : 'Arial';
		selectedSize = Object.keys(sizeMap).find(key => sizeMap[key as keyof typeof sizeMap] === state.uniformFontSize) || 'Medium';
		selectedWeight = Object.keys(weightMap).find(key => weightMap[key as keyof typeof weightMap] === state.uniformFontWeight) || 'Semi-Bold';
		selectedStyle = Object.keys(styleMap).find(key => styleMap[key as keyof typeof styleMap] === state.uniformFontStyle) || 'Normal';
	});

	$: previewStyle = `
		font-family: ${selectedFamily};
		font-size: ${sizeMap[selectedSize as keyof typeof sizeMap]};
		font-weight: ${weightMap[selectedWeight as keyof typeof weightMap]};
		font-style: ${styleMap[selectedStyle as keyof typeof styleMap]};
		color: var(--text-heading);
	`;

	async function handleSave() {
		isSaving = true;
		saveSuccess = false;
		saveError = null;
		console.log('[UniformFont] Save button clicked');
		try {
			console.log('[UniformFont] Updating theme store...');
			themeStore.setUniformFont({
				enabled: uniformFontEnabled,
				family: selectedFamily,
				size: sizeMap[selectedSize as keyof typeof sizeMap],
				weight: weightMap[selectedWeight as keyof typeof weightMap],
				style: styleMap[selectedStyle as keyof typeof styleMap]
			});

			console.log('[UniformFont] Sending to server...');
			await themeApi.saveThemePreferences({
				uniform_font_enabled: uniformFontEnabled ? 1 : 0,
				uniform_font_family: selectedFamily,
				uniform_font_size: sizeMap[selectedSize as keyof typeof sizeMap],
				uniform_font_weight: weightMap[selectedWeight as keyof typeof weightMap],
				uniform_font_style: styleMap[selectedStyle as keyof typeof styleMap]
			});

			console.log('[UniformFont] Save successful!');
			// Show success message
			saveSuccess = true;
			setTimeout(() => {
				saveSuccess = false;
			}, 3000);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Failed to save font settings';
			saveError = errorMessage;
			console.error('[UniformFont] Save failed:', error);

			// Auto-dismiss error after 5 seconds
			setTimeout(() => {
				saveError = null;
			}, 5000);
		} finally {
			isSaving = false;
		}
	}

	function handleToggle() {
		uniformFontEnabled = !uniformFontEnabled;
	}

	onDestroy(() => {
		unsubscribe();
	});
</script>

<div class="uniform-font-mode">
	<h3>Uniform Font Mode</h3>
	<p class="description">Use the same font for all usernames, regardless of their custom settings</p>

	<div class="toggle-section">
		<label class="toggle-label">
			<input type="checkbox" bind:checked={uniformFontEnabled} />
			<span>Enable uniform font mode</span>
		</label>
	</div>

	{#if uniformFontEnabled}
		<div class="font-settings">
			<div class="preview-section">
				<p class="preview-label">Preview:</p>
				<div class="preview-box" style={previewStyle}>
					Example Username
				</div>
			</div>

			<div class="controls-section">
				<div class="control-group">
					<label for="font-family">Font Family:</label>
					<select id="font-family" bind:value={selectedFamily}>
						{#each fontFamilies as family}
							<option value={family}>{family}</option>
						{/each}
					</select>
				</div>

				<div class="control-group">
					<label for="font-size">Size:</label>
					<select id="font-size" bind:value={selectedSize}>
						{#each Object.keys(sizeMap) as size}
							<option value={size}>{size}</option>
						{/each}
					</select>
				</div>

				<div class="control-group">
					<label for="font-weight">Weight:</label>
					<select id="font-weight" bind:value={selectedWeight}>
						{#each Object.keys(weightMap) as weight}
							<option value={weight}>{weight}</option>
						{/each}
					</select>
				</div>

				<div class="control-group">
					<label for="font-style">Style:</label>
					<select id="font-style" bind:value={selectedStyle}>
						{#each Object.keys(styleMap) as style}
							<option value={style}>{style}</option>
						{/each}
					</select>
				</div>
			</div>

			<button class="btn btn-primary" on:click={handleSave} disabled={isSaving}>
				{isSaving ? 'Saving...' : 'Save Settings'}
			</button>

			{#if saveSuccess}
				<div class="toast toast-success">
					<span class="toast-icon">✓</span>
					<span class="toast-text">Font settings saved successfully!</span>
				</div>
			{/if}

			{#if saveError}
				<div class="toast toast-error">
					<span class="toast-icon">✕</span>
					<span class="toast-text">{saveError}</span>
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.uniform-font-mode {
		background: var(--surface-base);
		border-radius: var(--radius-md);
		padding: var(--space-4);
		margin-bottom: var(--space-4);
	}

	h3 {
		margin: 0 0 var(--space-1) 0;
		font-size: var(--font-size-lg);
		font-weight: var(--font-weight-semibold);
		color: var(--text-heading);
	}

	.description {
		margin: 0 0 var(--space-4) 0;
		font-size: var(--font-size-base);
		color: var(--text-secondary);
	}

	.toggle-section {
		margin-bottom: var(--space-4);
	}

	.toggle-label {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		cursor: pointer;
		color: var(--text-heading);
		font-size: var(--font-size-base);
	}

	input[type='checkbox'] {
		cursor: pointer;
		width: 18px;
		height: 18px;
		accent-color: var(--accent-primary-color);
	}

	.font-settings {
		background: var(--surface-app);
		border-radius: var(--radius-md);
		padding: var(--space-3);
		margin-bottom: var(--space-3);
	}

	.preview-section {
		margin-bottom: var(--space-3);
	}

	.preview-label {
		margin: 0 0 var(--space-2) 0;
		font-size: var(--font-size-base);
		color: var(--text-secondary);
		font-weight: var(--font-weight-medium);
	}

	.preview-box {
		border: 1px solid var(--surface-raised);
		border-radius: var(--radius-md);
		padding: var(--space-3);
		text-align: center;
		min-height: 2em;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.controls-section {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: var(--space-3);
		margin-bottom: var(--space-3);
	}

	.control-group {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	label {
		font-size: var(--font-size-base);
		font-weight: var(--font-weight-medium);
		color: var(--text-secondary);
	}

	select {
		background: var(--surface-base);
		border: 1px solid var(--surface-raised);
		border-radius: var(--radius-md);
		color: var(--text-heading);
		padding: var(--space-2) var(--space-3);
		font-size: var(--font-size-base);
		cursor: pointer;
		transition: border-color var(--duration-fast);
	}

	select:hover {
		border-color: var(--accent-primary-color);
	}

	select:focus {
		outline: none;
		border-color: var(--accent-primary-color);
		box-shadow: 0 0 0 2px rgba(var(--accent-rgb), 0.2);
	}

	.btn {
		padding: var(--space-2) var(--space-4);
		border: none;
		border-radius: var(--radius-md);
		font-size: var(--font-size-base);
		font-weight: var(--font-weight-medium);
		cursor: pointer;
		transition: all var(--duration-fast);
		width: 100%;
	}

	.btn-primary {
		background: var(--accent-primary-color);
		color: white;
	}

	.btn-primary:hover:not(:disabled) {
		opacity: 0.9;
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.toast {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		margin-top: var(--space-3);
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-md);
		font-size: var(--font-size-base);
		font-weight: var(--font-weight-medium);
		animation: slideUp var(--duration-normal) var(--ease-out);
	}

	.toast-success {
		background: rgba(var(--color-success-rgb, 16, 185, 129), 0.15);
		border: 1px solid var(--color-success, var(--color-success, #10b981));
		color: var(--color-success, var(--color-success, #10b981));
	}

	.toast-error {
		background: var(--accent-danger-soft, rgba(var(--color-danger-rgb, 239, 68, 68), 0.15));
		border: 1px solid var(--color-danger, #ef4444);
		color: var(--color-danger, #ef4444);
	}

	.toast-icon {
		font-weight: bold;
		font-size: var(--font-size-lg);
	}

	.toast-text {
		flex: 1;
	}

	@keyframes slideUp {
		from {
			opacity: 0;
			transform: translateY(10px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
</style>
