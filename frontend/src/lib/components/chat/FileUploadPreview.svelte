<script lang="ts">
	import { _ } from '$lib/i18n';
	import type { FilePreview } from './types';

	export let filePreviews: FilePreview[] = [];
	export let markAsSpoiler = false;
	export let albumEligibleSelection = false;
	export let createAlbumFromUpload = false;
	export let uploadAlbumName = '';
	export let buildDefaultUploadAlbumName: () => string;
	export let onAlbumUploadToggle: (checked: boolean) => void;
	export let onCancelUpload: () => void;
	export let onRemoveFile: (index: number) => void;
	export let onUploadSelectedFiles: () => void | Promise<void>;
</script>

<div class="file-gallery">
	<div class="gallery-header">
		<span>
			{filePreviews.length === 1
				? $_('chat.upload.files_selected_one', { values: { count: filePreviews.length } })
				: $_('chat.upload.files_selected_many', { values: { count: filePreviews.length } })}
		</span>
		<button type="button" class="cancel-gallery" on:click={onCancelUpload}>✕</button>
	</div>
	<div class="gallery-grid">
		{#each filePreviews as { file, preview }, index}
			<div class="gallery-item">
				{#if preview}
					<img src={preview} alt={file.name} class="gallery-preview" />
				{:else}
					<div class="gallery-file-icon">
						{#if file.type.startsWith('video/')}
							🎬
						{:else if file.type.startsWith('audio/')}
							🎵
						{:else}
							📄
						{/if}
					</div>
				{/if}
				<div class="gallery-file-info">
					<div class="gallery-file-name">{file.name}</div>
					<div class="gallery-file-size">{(file.size / 1024 / 1024).toFixed(2)} MB</div>
				</div>
				<button type="button" class="remove-file" on:click={() => onRemoveFile(index)}>✕</button>
			</div>
		{/each}
	</div>
	<div class="spoiler-checkbox-container">
		<label class="spoiler-checkbox-label">
			<input type="checkbox" bind:checked={markAsSpoiler} class="spoiler-checkbox" />
			<span>{$_('chat.upload.mark_spoiler')}</span>
		</label>
		<span class="spoiler-hint" title={$_('chat.upload.spoiler_hint')}>⚠️</span>
	</div>
	{#if albumEligibleSelection}
		<div class="upload-album-row">
			<label class="upload-album-toggle">
				<input
					type="checkbox"
					checked={createAlbumFromUpload}
					on:change={(event) => onAlbumUploadToggle((event.currentTarget as HTMLInputElement).checked)}
				/>
				<span>Turn this multi-photo upload into a shared album</span>
			</label>
			{#if createAlbumFromUpload}
				<label class="upload-album-field">
					<span>Album name</span>
					<input
						class="upload-album-name input"
						type="text"
						bind:value={uploadAlbumName}
						placeholder={buildDefaultUploadAlbumName()}
						maxlength="80"
					/>
				</label>
				<small class="upload-album-hint">This name shows up in chat and in the Albums tab.</small>
			{/if}
		</div>
	{/if}
	<button type="button" class="upload-files-btn" on:click={() => void onUploadSelectedFiles()}>
		{filePreviews.length === 1
			? $_('chat.upload.upload_files_one', { values: { count: filePreviews.length } })
			: $_('chat.upload.upload_files_many', { values: { count: filePreviews.length } })}
	</button>
</div>
