<script lang="ts">
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
		<strong>{album?.name || 'Album'}</strong>
		<span>
			{album ? (loadedItemCount ?? album.itemCount ?? 0) + ' loaded' : ''}
			{#if album?.isFeatured}
				&middot; featured
			{/if}
		</span>
	</div>
	<div class="items-header-actions">
		<button
			type="button"
			class="album-plus-btn"
			on:click={onAddMedia}
			title="Add file to album"
			aria-label="Add file to album"
		>
			+
		</button>
		{#if canFeature}
			<button
				class="feature-btn"
				class:active={album?.isFeatured}
				on:click={() => album && onFeature(album)}
				disabled={isSavingFeatured}
				title={album?.isFeatured ? 'Unpin featured album' : 'Pin as featured album'}
			>
				{album?.isFeatured ? 'Unfeature album' : 'Feature album'}
			</button>
		{/if}
		<button
			class="danger-btn"
			on:click={onDelete}
			disabled={isDeleting || !canDelete}
			title="Delete this album"
		>
			{isDeleting ? 'Deleting...' : 'Delete album'}
		</button>
	</div>
</div>
