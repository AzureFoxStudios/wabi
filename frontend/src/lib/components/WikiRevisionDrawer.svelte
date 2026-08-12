<script lang="ts">
	import { findWikiAuthor, formatWikiTime, type WikiRevision } from '$lib/wikiStore';

	export let revisions: WikiRevision[] = [];
	export let onSelectRevision: ((revision: WikiRevision) => void) | undefined = undefined;
	export let onClose: (() => void) | undefined = undefined;
	export let activeRevisionId: string | null = null;
</script>

<div class="wiki-drawer-pane">
	<div class="wiki-drawer-header">
		<span class="wiki-drawer-header-label">Revisions</span>
		{#if onClose}
			<button type="button" class="wiki-drawer-close" aria-label="Close revision history" on:click={onClose}>&#10005;</button>
		{/if}
	</div>
	<div class="wiki-drawer-list">
		{#if revisions.length === 0}
			<div class="wiki-empty" style="padding: var(--space-8);">
				<p>No revisions</p>
			</div>
		{:else}
			{#each revisions as revision (revision.revisionId)}
				<button
					type="button"
					class="wiki-drawer-item"
					class:active={revision.revisionId === activeRevisionId}
					on:click={() => onSelectRevision?.(revision)}
				>
					<div class="wiki-drawer-item-time">{formatWikiTime(revision.createdAtMicros)}</div>
					<div class="wiki-drawer-item-editor">
						{findWikiAuthor(revision.editorUserId)?.username || `User #${revision.editorUserId}`}
					</div>
					{#if revision.summary}
						<div class="wiki-drawer-item-summary">{revision.summary}</div>
					{/if}
				</button>
			{/each}
		{/if}
	</div>
</div>
