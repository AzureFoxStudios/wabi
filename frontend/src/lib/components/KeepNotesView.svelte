<script lang="ts">
	import NotesWorkspace from './NotesWorkspace.svelte';

	/**
	 * Notes as a companion (compact) or on the page. The companion's frame (RightPanel) names it
	 * and carries "Open in center stage", so there is no second open button here (spec §8.4).
	 */
	let { compact = false }: { compact?: boolean } = $props();

	// The companion's frame already says "Only you · this device" once in its title row (§9.3),
	// so the compact empty line does not repeat it; center stage keeps the locality in its words.
	const COMPACT_EMPTY_MESSAGE = 'Keep personal notes, links and reminders here.';
	const PAGE_EMPTY_MESSAGE = 'Keep personal notes, links, and reminders on this device.';
</script>

{#if compact}
	<div class="keep-notes-compact">
		<NotesWorkspace
			title="Notes"
			showHeader={false}
			compact
			emptyMessage={COMPACT_EMPTY_MESSAGE}
			placeholder="Write a note…"
		/>
	</div>
{:else}
	<NotesWorkspace
		title="Notes"
		showHeader
		emptyMessage={PAGE_EMPTY_MESSAGE}
		placeholder="Write a note…"
	/>
{/if}

<style>
	/*
	 * Companion skin for NotesWorkspace (design contract §7.21, §8.4 Notes). NotesWorkspace belongs
	 * to the wiki + notes package; until it restyles the notebook itself, these rules are scoped to
	 * the companion so center-stage Notes is untouched:
	 * - the list tools are the panel's row B (40px, hairline = the masthead rule at y = 96);
	 * - list rows are 44px: title, then the date in mono; the preview line and the color bar go
	 *   (a person's color never paints a bar, §5.5);
	 * - the open note reads as prose at 15/26.
	 */
	.keep-notes-compact {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		overflow: hidden;
	}

	.keep-notes-compact :global(.notes-workspace) {
		background: transparent;
	}
	.keep-notes-compact :global(.notes-workspace .note-list) {
		background: transparent;
	}

	/* Row B: search + new note. */
	.keep-notes-compact :global(.notes-workspace .list-tools) {
		display: flex;
		flex: none;
		align-items: center;
		gap: 8px;
		box-sizing: border-box;
		height: var(--w-head-b);
		padding: 0 12px 8px 20px;
		border-bottom: var(--w-bw) solid var(--w-line);
	}
	.keep-notes-compact :global(.notes-workspace .list-tools input) {
		box-sizing: border-box;
		height: 32px;
		min-height: 0;
		padding: 0 10px;
		border: var(--w-bw) solid var(--w-line);
		border-radius: var(--radius-md);
		background: var(--w-sink);
		box-shadow: none;
		color: var(--w-text);
		font: var(--w-t-ui);
	}
	:global(:root[data-mode='light']) .keep-notes-compact :global(.notes-workspace .list-tools input) {
		border-color: color-mix(in srgb, var(--w-text) 16%, transparent);
	}
	.keep-notes-compact :global(.notes-workspace .list-tools input::placeholder) {
		color: var(--w-faint);
		opacity: 1;
	}
	.keep-notes-compact :global(.notes-workspace .list-tools input:focus) {
		border-color: var(--w-accent);
		box-shadow: var(--w-ring);
		outline: none;
	}
	.keep-notes-compact :global(.notes-workspace .list-tools button) {
		display: inline-grid;
		flex: none;
		place-items: center;
		box-sizing: border-box;
		width: 32px;
		height: 32px;
		min-height: 0;
		padding: 0;
		border: var(--w-bw) solid var(--w-line);
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--w-mute);
		font: 400 calc(18px * var(--w-fs)) / 1 var(--w-sans);
	}
	.keep-notes-compact :global(.notes-workspace .list-tools button:hover:not(:disabled)) {
		background: var(--w-raise);
		color: var(--w-text);
	}

	/* Notes | Trash: a quiet tab strip under row B. */
	.keep-notes-compact :global(.notes-workspace .list-tabs) {
		padding: 0 12px 0 20px;
	}
	.keep-notes-compact :global(.notes-workspace .list-tabs button) {
		min-height: 36px;
		padding: 0 2px;
		margin-right: 18px;
		border-bottom-width: 2px;
		color: var(--w-mute);
		font: var(--w-t-label);
		letter-spacing: 0;
		text-transform: none;
	}
	.keep-notes-compact :global(.notes-workspace .list-tabs button:last-child) {
		margin-right: 0;
		padding: 0 6px;
	}

	/* Rows: 44px, title over nothing, date at the end in mono. */
	.keep-notes-compact :global(.notes-workspace .note-rows) {
		padding: 6px 8px 12px;
	}
	.keep-notes-compact :global(.notes-workspace .note-row) {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		column-gap: 12px;
		box-sizing: border-box;
		min-height: 44px;
		margin: 0;
		padding: 0 12px;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		transition: background-color var(--w-dur-1) var(--w-ease);
	}
	.keep-notes-compact :global(.notes-workspace .note-row:hover) {
		background: color-mix(in srgb, var(--w-raise) 70%, transparent);
	}
	.keep-notes-compact :global(.notes-workspace .note-row.selected) {
		background: var(--w-raise);
	}
	:global(:root[data-char='contrast']) .keep-notes-compact :global(.notes-workspace .note-row:hover),
	:global(:root[data-char='contrast']) .keep-notes-compact :global(.notes-workspace .note-row.selected) {
		box-shadow: inset 0 0 0 1px var(--w-line-strong);
	}
	:global(:root[data-char='contrast']) .keep-notes-compact :global(.notes-workspace .note-row:hover) {
		background: transparent;
	}
	.keep-notes-compact :global(.notes-workspace .note-row strong) {
		min-width: 0;
		overflow: hidden;
		color: var(--w-text);
		font: var(--w-t-label);
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.keep-notes-compact :global(.notes-workspace .note-row > span) {
		display: none;
	}
	.keep-notes-compact :global(.notes-workspace .note-row small) {
		color: var(--w-faint);
		font: var(--w-t-micro);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.keep-notes-compact :global(.notes-workspace .list-empty) {
		padding: 24px 12px;
		color: var(--w-mute);
		font: var(--w-t-ui);
	}
	.keep-notes-compact :global(.notes-workspace .notebook-settings) {
		padding: 8px 12px 8px 12px;
		border-top: var(--w-bw) solid var(--w-line);
	}
	.keep-notes-compact :global(.notes-workspace .notebook-settings button) {
		font: var(--w-t-small);
	}

	/* The open note: serif title, prose 15/26. */
	.keep-notes-compact :global(.notes-workspace .note-title) {
		box-sizing: border-box;
		width: calc(100% - 32px);
		margin: 4px 16px 8px;
		padding: 6px 8px;
		border: var(--w-bw) solid transparent;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--w-text);
		font: var(--w-t-heading);
	}
	.keep-notes-compact :global(.notes-workspace .note-title:hover) {
		border-color: var(--w-line);
	}
	.keep-notes-compact :global(.notes-workspace .note-title:focus) {
		border-color: var(--w-accent);
		box-shadow: var(--w-ring);
		outline: none;
	}
	.keep-notes-compact :global(.notes-workspace .note-text),
	.keep-notes-compact :global(.notes-workspace .note-text .cm-content),
	.keep-notes-compact :global(.notes-workspace .note-reading) {
		font: 400 calc(15px * var(--w-fs)) / calc(26px * var(--w-fs)) var(--w-sans);
	}
	.keep-notes-compact :global(.notes-workspace .note-text),
	.keep-notes-compact :global(.notes-workspace .note-reading) {
		padding: 4px 24px 20px;
	}
	.keep-notes-compact :global(.notes-workspace .editor-tools),
	.keep-notes-compact :global(.notes-workspace footer) {
		padding: 8px 12px 8px 20px;
	}
	.keep-notes-compact :global(.notes-workspace .save-status) {
		color: var(--w-faint);
		font: var(--w-t-micro);
	}

	@media (prefers-reduced-motion: reduce) {
		.keep-notes-compact :global(.notes-workspace .note-row) {
			transition: none;
		}
	}
</style>
