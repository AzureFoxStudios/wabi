<script lang="ts">
	import { _ } from '$lib/i18n';

	/** Initial text when entering edit mode */
	export let editText: string;
	/** Receives the final draft so parent does not need two-way bind through rest-props */
	export let onSave: (text: string) => void;
	export let onCancel: () => void;

	// Local draft — never relies on bind:editText through MessageItem rest props.
	// Only reseed when the parent hands us a new seed (different message / reopen).
	let draft = editText;
	let lastSeed = editText;
	$: if (editText !== lastSeed) {
		lastSeed = editText;
		draft = editText;
	}

	function commit() {
		const next = draft.trim();
		if (!next) return;
		onSave(next);
	}
</script>

<div class="edit-mode">
	<textarea
		bind:value={draft}
		class="edit-textarea"
		rows="3"
		autofocus
		on:keydown={(e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				commit();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				onCancel();
			}
		}}
	></textarea>
	<div class="edit-actions">
		<button type="button" class="edit-cancel" on:click={onCancel}>{$_('common.cancel')}</button>
		<button type="button" class="edit-save" on:click={commit}>{$_('common.save')}</button>
	</div>
</div>

<style>
	.edit-mode {
		display: flex;
		flex-direction: column;
		gap: 8px;
		width: 100%;
	}
	.edit-textarea {
		width: 100%;
		min-height: 72px;
		max-height: 240px;
		resize: vertical;
		box-sizing: border-box;
		padding: 10px 12px;
		border-radius: 8px;
		border: 1px solid color-mix(in srgb, var(--border-subtle, var(--border)) 80%, transparent);
		background: var(--surface-raised, var(--surface-base));
		color: var(--text-heading, #e8eef7);
		-webkit-text-fill-color: var(--text-heading, #e8eef7);
		caret-color: var(--accent-primary-color, var(--accent-primary));
		font: inherit;
		font-size: 1rem;
		line-height: 1.375;
		outline: none;
	}
	.edit-textarea:focus {
		border-color: color-mix(in srgb, var(--accent-primary-color, var(--accent-primary)) 55%, transparent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-primary-color, var(--accent-primary)) 18%, transparent);
	}
	.edit-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	.edit-cancel,
	.edit-save {
		border: none;
		border-radius: 6px;
		padding: 6px 12px;
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
	}
	.edit-cancel {
		background: color-mix(in srgb, var(--surface-raised) 70%, transparent);
		border: 1px solid color-mix(in srgb, var(--border-subtle, var(--border)) 70%, transparent);
		color: var(--text-heading);
	}
	.edit-save {
		background: var(--accent-primary-color, var(--accent-primary));
		color: var(--text-on-accent, #0b1220);
	}
</style>
