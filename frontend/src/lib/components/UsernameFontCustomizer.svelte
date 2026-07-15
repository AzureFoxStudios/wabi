<script lang="ts">
	import { currentUser, getSocket } from '../socket';
	import { onMount, onDestroy } from 'svelte';

	// Font options
	const fontFamilies = ['Arial', 'Georgia', 'Times New Roman', 'Comic Sans MS', 'Courier New', 'Trebuchet MS', 'Verdana', 'Impact', 'Palatino', 'Helvetica'];
	const fontSizes = ['Small', 'Medium', 'Large', 'XL'];
	const fontWeights = ['Normal', 'Medium', 'Semi-Bold', 'Bold'];
	const fontStyles = ['Normal', 'Italic'];

	// Map display names to actual values
	const sizeMap = { Small: '0.9em', Medium: '1em', Large: '1.2em', XL: '1.4em' };
	const weightMap = { Normal: '400', Medium: '500', 'Semi-Bold': '600', Bold: '700' };
	const styleMap = { Normal: 'normal', Italic: 'italic' };

	let selectedFamily = $currentUser?.usernameFont?.family || 'inherit';
	let selectedSize = Object.keys(sizeMap).find(key => sizeMap[key as keyof typeof sizeMap] === ($currentUser?.usernameFont?.size || 'inherit')) || 'Medium';
	let selectedWeight = Object.keys(weightMap).find(key => weightMap[key as keyof typeof weightMap] === ($currentUser?.usernameFont?.weight || '600')) || 'Semi-Bold';
	let selectedStyle = Object.keys(styleMap).find(key => styleMap[key as keyof typeof styleMap] === ($currentUser?.usernameFont?.style || 'normal')) || 'Normal';

	let isSaving = false;
	let saveError: string | null = null;
	
	onMount(() => {
		const socket = getSocket();
		if (socket) {
			socket.on('profile-update-failed', (error) => {
				console.error('[FontCustomizer] Profile update failed:', error);
				saveError = error.message || 'An unknown error occurred.';
				alert(`Failed to save font settings: ${saveError}`);
				isSaving = false;
			});
		}

		return () => {
			if (socket) {
				socket.off('profile-update-failed');
			}
		}
	});

	$: previewStyle = `
		font-family: ${selectedFamily !== 'inherit' ? selectedFamily : 'inherit'};
		font-size: ${sizeMap[selectedSize as keyof typeof sizeMap]};
		font-weight: ${weightMap[selectedWeight as keyof typeof weightMap]};
		font-style: ${styleMap[selectedStyle as keyof typeof styleMap]};
		color: ${$currentUser?.color || '#ffffff'};
	`;

	async function handleSave() {
		const socket = getSocket();
		console.log('[FontCustomizer] handleSave called.');
		if (!$currentUser || !socket) {
			console.error('[FontCustomizer] Cannot save: No current user or socket connection.');
			alert('Error: Not connected to the server. Cannot save settings.');
			return;
		}

		isSaving = true;
		saveError = null;
		console.log('[FontCustomizer] isSaving set to true.');
		
		try {
			const payload = {
				usernameFont: {
					family: selectedFamily,
					size: sizeMap[selectedSize as keyof typeof sizeMap],
					weight: weightMap[selectedWeight as keyof typeof weightMap],
					style: styleMap[selectedStyle as keyof typeof styleMap]
				}
			};
			
			console.log('[FontCustomizer] Emitting "update-profile" with payload:', payload);
			socket.emit('update-profile', payload, (ack) => {
				isSaving = false;
				if (ack.success) {
					console.log('[FontCustomizer] Profile update acknowledged successfully.');
					alert('Font settings saved!');
				} else {
					console.error('[FontCustomizer] Profile update failed:', ack.error);
					saveError = ack.error || 'The server rejected the update.';
					alert(`Failed to save font settings: ${saveError}`);
				}
			});

		} catch (error) {
			console.error('Failed to save username font:', error);
			saveError = error.message;
			alert(`An unexpected error occurred: ${saveError}`);
			isSaving = false;
		}
	}

	function handleReset() {
		selectedFamily = 'inherit';
		selectedSize = 'Medium';
		selectedWeight = 'Semi-Bold';
		selectedStyle = 'Normal';
		handleSave();
	}
</script>

<div class="font-customizer">
	<h3>Username Font</h3>
	<p class="description">Customize how your username appears to others</p>

	<div class="preview-section">
		<p class="preview-label">Preview:</p>
		<div class="preview-box" style={previewStyle}>
			{$currentUser?.username || 'Username'}
		</div>
	</div>

	<div class="controls-section">
		<div class="control-group">
			<label for="font-family">Font Family:</label>
			<select id="font-family" bind:value={selectedFamily}>
				<option value="inherit">Default</option>
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

	<div class="button-group">
		<button class="btn btn-primary" on:click={handleSave} disabled={isSaving}>
			{isSaving ? 'Saving...' : 'Save'}
		</button>
		<button class="btn btn-secondary" on:click={handleReset} disabled={isSaving}>
			Reset
		</button>
	</div>
</div>

<style>
	.font-customizer {
		background: var(--surface-base);
		border-radius: 8px;
		padding: 16px;
		margin-bottom: 16px;
	}

	h3 {
		margin: 0 0 4px 0;
		font-size: 1rem;
		font-weight: 600;
		color: var(--text-heading);
	}

	.description {
		margin: 0 0 16px 0;
		font-size: 0.875rem;
		color: var(--text-secondary);
	}

	.preview-section {
		margin-bottom: 16px;
	}

	.preview-label {
		margin: 0 0 8px 0;
		font-size: 0.875rem;
		color: var(--text-secondary);
		font-weight: 500;
	}

	.preview-box {
		background: var(--surface-app);
		border: 1px solid var(--surface-raised);
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
		margin-bottom: 16px;
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
		background: var(--surface-app);
		border: 1px solid var(--surface-raised);
		border-radius: 6px;
		color: var(--text-heading);
		padding: 8px 12px;
		font-size: 0.875rem;
		cursor: pointer;
		transition: border-color 0.2s;
	}

	select:hover {
		border-color: var(--accent-primary-color);
	}

	select:focus {
		outline: none;
		border-color: var(--accent-primary-color);
		box-shadow: 0 0 0 2px rgba(var(--accent-primary, 100, 150, 255), 0.1);
	}

	.button-group {
		display: flex;
		gap: 8px;
	}

	.btn {
		padding: 8px 16px;
		border: none;
		border-radius: 6px;
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.2s;
	}

	.btn-primary {
		background: var(--accent-primary-color);
		color: white;
	}

	.btn-primary:hover:not(:disabled) {
		opacity: 0.9;
	}

	.btn-secondary {
		background: var(--surface-raised);
		color: var(--text-heading);
	}

	.btn-secondary:hover:not(:disabled) {
		background: var(--surface-hover);
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	@media (max-width: 640px) {
		.controls-section {
			grid-template-columns: 1fr;
		}

		.button-group {
			flex-direction: column;
		}

		.btn {
			width: 100%;
		}
	}
</style>
