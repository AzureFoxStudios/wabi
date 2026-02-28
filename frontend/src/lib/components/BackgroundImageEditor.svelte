<script lang="ts">
	import { themeStore } from '../theme/themeStore';
	import { saveThemePreferences } from '../theme/themeApi';
	import type { BackgroundImage, CustomTheme } from '../../types/theme';
	import { getAuthToken } from '$lib/authSession';

	let isUploading = false;
	let uploadError = '';
	let backgroundImage: BackgroundImage | null = null;

	// Customization options
	let opacity = 100;
	let blur = 0;
	let size: 'cover' | 'contain' | 'auto' = 'cover';
	let position = 'center';
	let repeat: 'no-repeat' | 'repeat' | 'repeat-x' | 'repeat-y' = 'no-repeat';
	let blend = 'overlay';

	const positionOptions = ['center', 'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];
	const blendModes = ['normal', 'overlay', 'multiply', 'screen', 'darken', 'lighten', 'color-dodge', 'color-burn'];

	// Subscribe to current custom theme
	$: {
		const unsub = themeStore.subscribe((state) => {
			if (state.customTheme?.backgroundImage) {
				backgroundImage = state.customTheme.backgroundImage;
				opacity = Math.round((backgroundImage.opacity || 0.3) * 100);
				blur = backgroundImage.blur || 0;
				size = backgroundImage.size || 'cover';
				position = backgroundImage.position || 'center';
				repeat = backgroundImage.repeat || 'no-repeat';
				blend = backgroundImage.blend || 'overlay';
			}
		});
	}

	async function handleFileSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		// Validate file type
		const validTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
		if (!validTypes.includes(file.type)) {
			uploadError = 'Invalid file type. Only PNG, JPG, GIF, and WEBP are allowed.';
			return;
		}

		// Validate file size (max 10MB)
		const maxSize = 10 * 1024 * 1024;
		if (file.size > maxSize) {
			uploadError = 'File is too large. Maximum size is 10MB.';
			return;
		}

		isUploading = true;
		uploadError = '';

		try {
			const formData = new FormData();
			formData.append('backgroundImage', file);

			const authToken = getAuthToken();
			const headers: HeadersInit = {};
			if (authToken) {
				headers['Authorization'] = `Bearer ${authToken}`;
			}

			const response = await fetch('/api/upload-background-image', {
				method: 'POST',
				headers,
				credentials: 'include',
				body: formData
			});

			if (!response.ok) {
				const error = await response.json();
				uploadError = error.error || 'Upload failed';
				return;
			}

			const result = await response.json();
			if (result.success) {
				backgroundImage = {
					url: result.backgroundImageUrl,
					opacity: opacity / 100,
					blur,
					size,
					position,
					repeat,
					blend
				};
				await saveBackgroundImage();
			} else {
				uploadError = result.error || 'Upload failed';
			}
		} catch (error) {
			uploadError = 'Failed to upload image';
			console.error(error);
		} finally {
			isUploading = false;
			input.value = '';
		}
	}

	async function saveBackgroundImage() {
		if (!backgroundImage) return;

		try {
			const customTheme: CustomTheme = {
				backgroundImage: {
					url: backgroundImage.url,
					opacity: opacity / 100,
					blur,
					size,
					position,
					repeat,
					blend
				}
			};

			themeStore.setCustomTheme(customTheme);
			await saveThemePreferences({
				custom_theme: customTheme
			});
		} catch (error) {
			console.error('Failed to save background image settings:', error);
		}
	}

	async function handleRemove() {
		backgroundImage = null;
		themeStore.setCustomTheme(null);
		await saveThemePreferences({
			custom_theme: null
		});
	}

	function handleOpacityChange() {
		saveBackgroundImage();
	}

	function handleBlurChange() {
		saveBackgroundImage();
	}

	function handleSizeChange() {
		saveBackgroundImage();
	}

	function handlePositionChange() {
		saveBackgroundImage();
	}

	function handleRepeatChange() {
		saveBackgroundImage();
	}

	function handleBlendChange() {
		saveBackgroundImage();
	}
</script>

<div class="background-editor">
	<h3>Chat Background Image</h3>
	<p class="description">Upload a custom background image for your chat window</p>

	{#if !backgroundImage}
		<div class="upload-section">
			<label for="image-upload" class="upload-button">
				<input
					type="file"
					id="image-upload"
					accept="image/png,image/jpeg,image/gif,image/webp"
					on:change={handleFileSelect}
					disabled={isUploading}
				/>
				{#if isUploading}
					<span>Uploading...</span>
				{:else}
					<span>Choose Image</span>
				{/if}
			</label>
			{#if uploadError}
				<p class="error-message">{uploadError}</p>
			{/if}
		</div>
	{:else}
		<div class="settings-section">
			<div class="preview-section">
				<p class="preview-label">Preview:</p>
				<div
					class="preview-box"
					style="background-image: url({backgroundImage.url}); background-size: {size}; background-position: {position}; background-repeat: {repeat}; opacity: {opacity / 100}; filter: blur({blur}px); background-blend-mode: {blend};"
				>
					<div class="preview-overlay">Background Preview</div>
				</div>
			</div>

			<div class="controls-section">
				<div class="control-group">
					<label for="opacity">Opacity: {opacity}%</label>
					<input
						type="range"
						id="opacity"
						min="0"
						max="100"
						bind:value={opacity}
						on:change={handleOpacityChange}
					/>
				</div>

				<div class="control-group">
					<label for="blur">Blur: {blur}px</label>
					<input
						type="range"
						id="blur"
						min="0"
						max="20"
						bind:value={blur}
						on:change={handleBlurChange}
					/>
				</div>

				<div class="control-group">
					<label for="size">Size:</label>
					<select id="size" bind:value={size} on:change={handleSizeChange}>
						<option value="cover">Cover</option>
						<option value="contain">Contain</option>
						<option value="auto">Auto</option>
					</select>
				</div>

				<div class="control-group">
					<label for="position">Position:</label>
					<select id="position" bind:value={position} on:change={handlePositionChange}>
						{#each positionOptions as pos}
							<option value={pos}>{pos}</option>
						{/each}
					</select>
				</div>

				<div class="control-group">
					<label for="repeat">Repeat:</label>
					<select id="repeat" bind:value={repeat} on:change={handleRepeatChange}>
						<option value="no-repeat">No Repeat</option>
						<option value="repeat">Repeat</option>
						<option value="repeat-x">Repeat X</option>
						<option value="repeat-y">Repeat Y</option>
					</select>
				</div>

				<div class="control-group">
					<label for="blend">Blend Mode:</label>
					<select id="blend" bind:value={blend} on:change={handleBlendChange}>
						{#each blendModes as mode}
							<option value={mode}>{mode}</option>
						{/each}
					</select>
				</div>
			</div>

			<div class="button-group">
				<button class="btn btn-secondary" on:click={handleRemove}>
					Remove Image
				</button>
			</div>
		</div>
	{/if}
</div>

<style>
	.background-editor {
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

	.upload-section {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.upload-button {
		display: inline-block;
		background: var(--accent);
		color: white;
		padding: 12px 16px;
		border-radius: 6px;
		cursor: pointer;
		text-align: center;
		font-weight: 500;
		transition: opacity 0.2s;
	}

	.upload-button:hover {
		opacity: 0.9;
	}

	input[type='file'] {
		display: none;
	}

	.error-message {
		color: #ff6b6b;
		font-size: 0.875rem;
		margin: 0;
	}

	.settings-section {
		display: flex;
		flex-direction: column;
		gap: 12px;
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
		height: 150px;
		position: relative;
		overflow: hidden;
	}

	.preview-overlay {
		position: absolute;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		color: white;
		font-size: 0.875rem;
	}

	.controls-section {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 12px;
		background: var(--bg-primary);
		border-radius: 6px;
		padding: 12px;
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

	input[type='range'] {
		cursor: pointer;
		accent-color: var(--accent);
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

	.btn-secondary {
		background: var(--bg-tertiary);
		color: var(--text-primary);
	}

	.btn-secondary:hover {
		background: var(--bg-hover);
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
