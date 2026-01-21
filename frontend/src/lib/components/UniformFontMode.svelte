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
		color: var(--text-primary);
	`;

	async function handleSave() {
		isSaving = true;
		try {
			themeStore.setUniformFont({
				enabled: uniformFontEnabled,
				family: selectedFamily,
				size: sizeMap[selectedSize as keyof typeof sizeMap],
				weight: weightMap[selectedWeight as keyof typeof weightMap],
				style: styleMap[selectedStyle as keyof typeof styleMap]
			});

			await themeApi.saveThemePreferences({
				uniform_font_enabled: uniformFontEnabled ? 1 : 0,
				uniform_font_family: selectedFamily,
				uniform_font_size: sizeMap[selectedSize as keyof typeof sizeMap],
				uniform_font_weight: weightMap[selectedWeight as keyof typeof weightMap],
				uniform_font_style: styleMap[selectedStyle as keyof typeof styleMap]
			});
		} catch (error) {
			console.error('Failed to save uniform font settings:', error);
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
			<input type="checkbox" bind:checked={uniformFontEnabled} on:change={handleToggle} />
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
		</div>
	{/if}
</div>

<style>
	.uniform-font-mode {
		background: var(--bg-secondary);
		border-radius: 8px;
		padding: 16px;
		margin-bottom: 16px;
	}

	h3 {
		margin: 0 0 4px 0;
		font-size: 1rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.description {
		margin: 0 0 16px 0;
		font-size: 0.875rem;
		color: var(--text-secondary);
	}

	.toggle-section {
		margin-bottom: 16px;
	}

	.toggle-label {
		display: flex;
		align-items: center;
		gap: 8px;
		cursor: pointer;
		color: var(--text-primary);
		font-size: 0.9rem;
	}

	input[type='checkbox'] {
		cursor: pointer;
		width: 18px;
		height: 18px;
		accent-color: var(--accent);
	}

	.font-settings {
		background: var(--bg-primary);
		border-radius: 6px;
		padding: 12px;
		margin-bottom: 12px;
	}

	.preview-section {
		margin-bottom: 12px;
	}

	.preview-label {
		margin: 0 0 8px 0;
		font-size: 0.875rem;
		color: var(--text-secondary);
		font-weight: 500;
	}

	.preview-box {
		border: 1px solid var(--bg-tertiary);
		border-radius: 6px;
		padding: 12px;
		text-align: center;
		min-height: 2em;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.controls-section {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 12px;
		margin-bottom: 12px;
	}

	.control-group {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	label {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--text-secondary);
	}

	select {
		background: var(--bg-secondary);
		border: 1px solid var(--bg-tertiary);
		border-radius: 6px;
		color: var(--text-primary);
		padding: 8px 12px;
		font-size: 0.875rem;
		cursor: pointer;
		transition: border-color 0.2s;
	}

	select:hover {
		border-color: var(--accent);
	}

	select:focus {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 2px rgba(var(--accent-hex, 100, 150, 255), 0.1);
	}

	.btn {
		padding: 8px 16px;
		border: none;
		border-radius: 6px;
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.2s;
		width: 100%;
	}

	.btn-primary {
		background: var(--accent);
		color: white;
	}

	.btn-primary:hover:not(:disabled) {
		opacity: 0.9;
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
