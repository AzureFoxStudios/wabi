<script lang="ts">
	import { onDestroy } from 'svelte';
	import { get } from 'svelte/store';
	import { themeStore } from '../theme/themeStore';
	import { saveThemePreferences } from '../theme/themeApi';
	import type { BackgroundImage, CustomTheme } from '../../types/theme';
	import { getAuthToken } from '$lib/authSession';
	import { getServerUrl } from '../serverUrl';

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

	// Video backgrounds (mp4/webm/mov) play via <video>; images (incl.
	// animated gif/webp) use the CSS background path.
	const VIDEO_EXT_RE = /\.(mp4|webm|mov)(\?|$)/i;
	$: isVideo = !!backgroundImage && VIDEO_EXT_RE.test(backgroundImage.url);

	function isVideoFile(file: File): boolean {
		return file.type.startsWith('video/') || VIDEO_EXT_RE.test(file.name);
	}

	const positionOptions = ['center', 'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];
	const blendModes = ['normal', 'overlay', 'multiply', 'screen', 'darken', 'lighten', 'color-dodge', 'color-burn'];

	const unsubscribeThemeStore = themeStore.subscribe((state) => {
		if (!state.customTheme?.backgroundImage) {
			backgroundImage = null;
			return;
		}
		backgroundImage = state.customTheme.backgroundImage;
		opacity = Math.round((backgroundImage.opacity || 0.3) * 100);
		blur = backgroundImage.blur || 0;
		size = backgroundImage.size || 'cover';
		position = backgroundImage.position || 'center';
		repeat = backgroundImage.repeat || 'no-repeat';
		blend = backgroundImage.blend || 'overlay';
	});

	onDestroy(unsubscribeThemeStore);

	async function handleFileSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		// Validate file type — images (incl. animated gif/webp) and video loops
		const isVideo = isVideoFile(file);
		const validTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
		if (!isVideo && !validTypes.includes(file.type)) {
			uploadError = 'Invalid file type. Only PNG, JPG, GIF, WEBP, MP4, or WEBM are allowed.';
			return;
		}

		// Validate file size (max 25MB for video loops, 10MB for images)
		const maxSize = isVideo ? 25 * 1024 * 1024 : 10 * 1024 * 1024;
		if (file.size > maxSize) {
			uploadError = `File is too large. Maximum size is ${isVideo ? '25MB' : '10MB'}.`;
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

		const response = await fetch(`${getServerUrl()}/api/upload-background-image`, {
			method: 'POST',
			headers,
			credentials: 'include',
			body: formData
		});

			if (!response.ok) {
				const error = await response.json().catch(() => ({ error: 'Upload failed' }));
				uploadError = error.error || 'Upload failed';
				return;
			}

			const result = await response.json();
			// Server returns { backgroundImageUrl }; tolerate { fileUrl } just in case.
			const finalUrl = (result.backgroundImageUrl || result.fileUrl) as string | undefined;
			if (finalUrl) {
				backgroundImage = {
					url: finalUrl,
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
			uploadError = 'Failed to upload background media';
			console.error(error);
		} finally {
			isUploading = false;
			input.value = '';
		}
	}

	async function saveBackgroundImage() {
		if (!backgroundImage) return;

		try {
			const activeTheme = get(themeStore).customTheme;
			const customTheme: CustomTheme = {
				...activeTheme,
				colors: activeTheme?.colors,
				gradients: activeTheme?.gradients,
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
			if (getAuthToken()) {
				await saveThemePreferences({
					theme_id: 'custom',
					custom_theme: customTheme
				});
			}
		} catch (error) {
			console.error('Failed to save background image settings:', error);
		}
	}

	async function handleRemove() {
		backgroundImage = null;
		const activeTheme = get(themeStore).customTheme;
		const customTheme: CustomTheme | null = activeTheme
			? {
					...activeTheme,
					backgroundImage: undefined
		}
			: null;
		themeStore.setCustomTheme(customTheme);
		if (getAuthToken()) {
			await saveThemePreferences({
				theme_id: customTheme ? 'custom' : get(themeStore).themeId,
				custom_theme: customTheme
			});
		}
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
					accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm,video/quicktime"
					on:change={handleFileSelect}
					disabled={isUploading}
				/>
				{#if isUploading}
					<span>Uploading...</span>
				{:else}
					<span>Choose Image or Video</span>
				{/if}
			</label>
			<p class="hint">Animated GIF/WEBP and short MP4/WebM loops work as living backgrounds.</p>
			{#if uploadError}
				<p class="error-message">{uploadError}</p>
			{/if}
		</div>
	{:else}
		<div class="settings-section">
			<div class="preview-section">
				<p class="preview-label">Preview:</p>
				{#if isVideo}
					<video
						class="preview-box video-preview"
						src={backgroundImage.url}
						autoplay
						muted
						loop
						playsinline
						style="opacity: {opacity / 100}; filter: blur({blur}px); object-fit: {size === 'auto' ? 'fill' : size};"
					></video>
					<div class="preview-overlay"><span>Video background preview</span></div>
				{:else}
					<div
						class="preview-box"
						style="background-image: url({backgroundImage.url}); background-size: {size}; background-position: {position}; background-repeat: {repeat}; opacity: {opacity / 100}; filter: blur({blur}px); background-blend-mode: {blend};"
					>
						<div class="preview-overlay">Background Preview</div>
					</div>
				{/if}
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

	.upload-section {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.upload-button {
		display: inline-block;
		background: var(--accent-primary-color);
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
		color: var(--text-danger, #ff6b6b);
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
		border: 1px solid var(--surface-raised);
		border-radius: 6px;
		height: 150px;
		position: relative;
		overflow: hidden;
	}

	.video-preview {
		width: 100%;
		display: block;
	}

	.preview-section {
		position: relative;
	}

	.preview-section .preview-overlay {
		position: absolute;
		top: 34px;
		left: 0;
		right: 0;
		height: 150px;
		display: flex;
		align-items: center;
		justify-content: center;
		color: rgba(255, 255, 255, 0.85);
		font-size: 0.85rem;
		pointer-events: none;
		text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
	}

	.hint {
		margin: 4px 0 0;
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.preview-overlay {
		position: absolute;
		inset: 0;
		background: var(--shadow-md, var(--shadow-lg, var(--surface-modal-overlay, rgba(0, 0, 0, 0.5))));
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
		background: var(--surface-app);
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
		accent-color: var(--accent-primary-color);
	}

	select {
		background: var(--surface-base);
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
		box-shadow: 0 0 0 2px rgba(var(--accent-rgb), 0.12);
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
		background: var(--surface-raised);
		color: var(--text-heading);
	}

	.btn-secondary:hover {
		background: var(--surface-hover);
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
