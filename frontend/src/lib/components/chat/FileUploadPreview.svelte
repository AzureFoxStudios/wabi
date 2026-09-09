<script lang="ts">
	import { _ } from '$lib/i18n';
	import type { FilePreview } from './types';

	export let filePreviews: FilePreview[] = [];
	export let markAsSpoiler = false;
	export let spoilerLocked = false;
	export let albumEligibleSelection = false;
	export let createAlbumFromUpload = false;
	export let uploadAlbumName = '';
	export let buildDefaultUploadAlbumName: () => string;
	export let onAlbumUploadToggle: (checked: boolean) => void;
	export let onCancelUpload: () => void;
	export let onRemoveFile: (index: number) => void;
	export let onUploadSelectedFiles: () => void | Promise<void>;
	export let albums: { id: number; name: string }[] = [];
	export let targetAlbumId: number;
	export let onAlbumTargetChange: (albumId: number) => void = () => {};
</script>

<div class="file-gallery">
	<div class="gallery-header">
		<span class="gallery-count">
			{filePreviews.length === 1
				? $_('chat.upload.files_selected_one', { values: { count: filePreviews.length } })
				: $_('chat.upload.files_selected_many', { values: { count: filePreviews.length } })}
		</span>
		<button type="button" class="cancel-gallery" aria-label="Cancel upload" on:click={onCancelUpload}>
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"></path></svg>
		</button>
	</div>
	<div class="gallery-grid">
		{#each filePreviews as { file, preview }, index}
			<div class="gallery-item">
				{#if preview && file.type.startsWith('image/')}
					<img src={preview} alt={file.name} class="gallery-preview" />
				{:else if preview && file.type.startsWith('video/')}
					<video src={preview} class="gallery-preview gallery-video-preview" controls muted playsinline preload="metadata"></video>
				{:else if preview && file.type.startsWith('audio/')}
					<div class="gallery-audio-preview"><span aria-hidden="true">🎵</span><audio src={preview} controls preload="metadata"></audio></div>
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
					<div class="gallery-file-name" title={file.name}>{file.name}</div>
					<div class="gallery-file-size">{(file.size / 1024 / 1024).toFixed(2)} MB</div>
				</div>
				<button type="button" class="remove-file" aria-label="Remove {file.name}" on:click={() => onRemoveFile(index)}>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"></path></svg>
				</button>
			</div>
		{/each}
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
				{#if albums.length > 0}
					<label class="upload-album-field">
						<span>Add to album</span>
						<select
							class="upload-album-name input"
							value={targetAlbumId}
							on:change={(e) => onAlbumTargetChange(Number((e.currentTarget as HTMLSelectElement).value))}
						>
							<option value={0}>Create a new album…</option>
							{#each albums as album (album.id)}
								<option value={album.id}>{album.name}</option>
							{/each}
						</select>
					</label>
				{/if}
				{#if targetAlbumId === 0}
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
				{/if}
				<small class="upload-album-hint"
					>{targetAlbumId > 0
						? 'Files are added to the chosen album and posted to chat.'
						: 'This name shows up in chat and in the Albums tab.'}</small
				>
			{/if}
		</div>
	{/if}
	<div class="gallery-footer">
		<div class="spoiler-checkbox-container">
			<span class="spoiler-label-text" title={$_('chat.upload.spoiler_hint')}
				>{spoilerLocked ? '🔒 Spoiler channel' : $_('chat.upload.mark_spoiler')}</span
			>
			<button
				type="button"
				class="toggle-btn settings-switch"
				class:active={markAsSpoiler}
				disabled={spoilerLocked}
				on:click={() => (markAsSpoiler = !markAsSpoiler)}
				role="switch"
				aria-checked={markAsSpoiler}
				aria-label="Mark uploads as spoiler"
			></button>
		</div>
		<button type="button" class="upload-files-btn" on:click={() => void onUploadSelectedFiles()}>
			{filePreviews.length === 1
				? $_('chat.upload.upload_files_one', { values: { count: filePreviews.length } })
				: $_('chat.upload.upload_files_many', { values: { count: filePreviews.length } })}
		</button>
	</div>
</div>
