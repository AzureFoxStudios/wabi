<script lang="ts">
	import { formatBytes } from './mediaAlbumHelpers';

	export let draftUploadFile: File | null = null;
	export let draftUploadCaption: string = '';
	export let isUploadingAlbumFile: boolean = false;
	export let uploadInputElement: HTMLInputElement | null = null;

	export let onTriggerPicker: (mode: 'draft' | 'instant') => void = () => {};
	export let onUpload: () => void = () => {};
	export let onFileChange: (event: Event) => void = () => {};
</script>

<div class="upload-local-item">
	<input
		type="file"
		bind:this={uploadInputElement}
		class="album-file-input"
		on:change={onFileChange}
		accept="image/*,video/*,audio/*,.zip,.pdf,.txt,.md"
	/>
	<div
		class="upload-local-row"
		role="button"
		tabindex="0"
		on:click={() => onTriggerPicker('draft')}
		on:keydown={(event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				onTriggerPicker('draft');
			}
		}}
	>
		<button
			type="button"
			class="album-upload-trigger"
			on:click|stopPropagation={() => onTriggerPicker('draft')}
			title="Choose file for this album"
			aria-label="Choose file for this album"
		>
			+
		</button>
		<div class="upload-local-copy">
			<strong>Add to this album</strong>
			<span>{draftUploadFile ? draftUploadFile.name : 'Pick an image, video, or file to add.'}</span>
		</div>
		<button
			on:click|stopPropagation={() => onUpload()}
			disabled={isUploadingAlbumFile || !draftUploadFile}
		>
			{isUploadingAlbumFile ? 'Uploading...' : 'Upload to album'}
		</button>
	</div>
	{#if draftUploadFile}
		<div class="upload-local-meta">
			<span>{draftUploadFile.name}</span>
			<span>{formatBytes(draftUploadFile.size)}</span>
		</div>
	{/if}
	<input
		type="text"
		bind:value={draftUploadCaption}
		placeholder="Caption for uploaded file (optional)"
	/>
</div>
