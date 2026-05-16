<script lang="ts">
	import { _ } from '$lib/i18n';

	export let editText: string;
	export let onSave: () => void;
	export let onCancel: () => void;
</script>

<div class="edit-mode">
	<textarea
		bind:value={editText}
		class="edit-textarea"
		rows="3"
		on:keydown={(e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				onSave();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				onCancel();
			}
		}}
	></textarea>
	<div class="edit-actions">
		<button class="edit-cancel" on:click={onCancel}>{$_('common.cancel')}</button>
		<button class="edit-save" on:click={onSave}>{$_('common.save')}</button>
	</div>
</div>
