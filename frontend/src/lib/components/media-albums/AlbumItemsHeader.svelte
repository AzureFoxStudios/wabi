<script lang="ts">
	import { _ } from '$lib/i18n';
	import type { MediaAlbum } from '$lib/api';

	export let album: MediaAlbum | null = null;
	export let canFeature: boolean = false;
	export let canDelete: boolean = false;
	export let isDeleting: boolean = false;
	export let isSavingFeatured: boolean = false;
	export let loadedItemCount: number | null = null;

	export let onFeature: (album: MediaAlbum) => void = () => {};
	export let onDelete: () => void = () => {};
	export let onAddMedia: () => void = () => {};
</script>

<div class="items-header">
	<div class="items-header-title">
		<strong>{album?.name || $_('album_header.default_name')}</strong>
		<span>
			{album ? $_('album_header.loaded', { values: { count: loadedItemCount ?? album.itemCount ?? 0 } }) : ''}
			{#if album?.isFeatured}
				&middot; {$_('album_header.featured')}
			{/if}
		</span>
	</div>
	<div class="items-header-actions">
		<button
			type="button"
			class="album-plus-btn"
			on:click={onAddMedia}
			title={$_('album_header.add_file')}
			aria-label={$_('album_header.add_file')}
		>
			+
		</button>
		{#if canFeature}
			<button
				class="feature-btn"
				class:active={album?.isFeatured}
				on:click={() => album && onFeature(album)}
				disabled={isSavingFeatured}
				title={album?.isFeatured ? $_('album_header.unpin_featured') : $_('album_header.pin_featured')}
			>
				{album?.isFeatured ? $_('album_header.unfeature') : $_('album_header.feature')}
			</button>
		{/if}
		<button
			class="danger-btn"
			on:click={onDelete}
			disabled={isDeleting || !canDelete}
			title={$_('album_header.delete')}
		>
			{isDeleting ? $_('album_header.deleting') : $_('album_header.delete_album')}
		</button>
	</div>
</div>
