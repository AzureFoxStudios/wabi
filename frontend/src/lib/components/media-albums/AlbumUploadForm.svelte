<script lang="ts">
	import { _ } from '$lib/i18n';
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
			title={$_('aup.choose_file')}
			aria-label={$_('aup.choose_file')}
		>
			+
		</button>
		<div class="upload-local-copy">
			<strong>{$_('aup.add_to_album')}</strong>
			<span>{draftUploadFile ? draftUploadFile.name : $_('aup.pick_file')}</span>
		</div>
		<button
			on:click|stopPropagation={() => onUpload()}
			disabled={isUploadingAlbumFile || !draftUploadFile}
		>
			{isUploadingAlbumFile ? $_('message_content.uploading_ellipsis') : $_('aup.upload')}
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
		placeholder={$_('aup.caption_ph')}
	/>
</div>
