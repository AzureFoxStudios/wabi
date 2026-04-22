<script lang="ts">
	import { onDestroy } from 'svelte';
	import { currentUser } from '$lib/socket';
	import {
		getQuickScratchpadStorageKey,
		readScratchpadText,
		writeScratchpadText
	} from '$lib/notesStore';

	let loadedStorageKey = '';
	let scratchpadText = '';
	let saveState: 'saved' | 'unsaved' = 'saved';
	let persistTimer: ReturnType<typeof setTimeout> | null = null;
	const SAVE_DELAY_MS = 650;

	$: storageKey = getQuickScratchpadStorageKey($currentUser?.id);
	$: if (storageKey && storageKey !== loadedStorageKey) {
		if (persistTimer) {
			clearTimeout(persistTimer);
			persistTimer = null;
		}
		loadedStorageKey = storageKey;
		scratchpadText = readScratchpadText(storageKey);
		saveState = 'saved';
	}

	$: lineCount = scratchpadText ? scratchpadText.split(/\r?\n/).length : 1;
	$: wordCount = scratchpadText.trim() ? scratchpadText.trim().split(/\s+/).length : 0;

	function updateScratchpad(value: string): void {
		scratchpadText = value;
		saveState = 'unsaved';
		if (persistTimer) {
			clearTimeout(persistTimer);
		}
		persistTimer = setTimeout(() => {
			writeScratchpadText(storageKey, value);
			saveState = 'saved';
			persistTimer = null;
		}, SAVE_DELAY_MS);
	}

	onDestroy(() => {
		if (persistTimer) {
			clearTimeout(persistTimer);
			persistTimer = null;
		}
		if (saveState === 'unsaved' && storageKey) {
			writeScratchpadText(storageKey, scratchpadText);
			saveState = 'saved';
		}
	});
</script>

<section class="quick-scratchpad">
	<textarea
		class="scratchpad-input"
		value={scratchpadText}
		on:input={(event) => updateScratchpad((event.currentTarget as HTMLTextAreaElement).value)}
		placeholder="Type or paste notes here."
		spellcheck="true"
	></textarea>

	<div class="scratchpad-footer">
		<span class:dirty={saveState === 'unsaved'}>{saveState === 'saved' ? 'Saved' : 'Unsaved'}</span>
		<span>{lineCount} lines · {wordCount} words</span>
	</div>
</section>

<style>
	.quick-scratchpad {
		height: 100%;
		min-height: 0;
		display: grid;
		grid-template-rows: minmax(0, 1fr) auto;
		background:
			radial-gradient(circle at top right, color-mix(in srgb, var(--accent) 12%, transparent), transparent 45%),
			linear-gradient(180deg, color-mix(in srgb, var(--bg-tertiary) 82%, transparent), var(--bg-secondary));
	}

	.scratchpad-input {
		width: 100%;
		height: 100%;
		min-height: 0;
		resize: none;
		border: none;
		outline: none;
		background: transparent;
		color: var(--text-primary);
		padding: 0.95rem;
		font-size: 0.84rem;
		line-height: 1.55;
		font-family: inherit;
	}

	.scratchpad-input::placeholder {
		color: var(--text-tertiary);
	}

	.scratchpad-footer {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.6rem;
		padding: 0.55rem 0.9rem 0.7rem;
		border-top: 1px solid color-mix(in srgb, var(--border) 84%, transparent);
		font-size: 0.7rem;
		color: var(--text-secondary);
	}

	.scratchpad-footer .dirty {
		color: color-mix(in srgb, #f59e0b 78%, var(--text-primary) 22%);
	}

	@media (max-width: 768px) {
		.scratchpad-footer {
			flex-direction: column;
			align-items: flex-start;
		}
	}
</style>
