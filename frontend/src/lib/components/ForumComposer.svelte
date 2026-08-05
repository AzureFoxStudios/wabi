<script lang="ts">
	export let placeholder = 'Write a reply... Ctrl+Enter to post';
	export let showTitle = false;
	export let categoryOptions: string[] = [];
	export let onSubmit: (body: string, title?: string, category?: string) => void;
	export let onCancel: (() => void) | undefined = undefined;

	let titleValue = '';
	let categoryValue = '';
	let bodyValue = '';
	let previewMode = false;

	function handleSubmit() {
		if (!bodyValue.trim()) return;
		onSubmit(
			bodyValue.trim(),
			showTitle ? titleValue.trim() || undefined : undefined,
			showTitle ? categoryValue.trim() || undefined : undefined
		);
		bodyValue = '';
		titleValue = '';
		categoryValue = '';
		previewMode = false;
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			handleSubmit();
		}
	}
</script>

<div class="forum-composer">
	{#if showTitle}
		<input
			type="text"
			class="forum-new-thread-title"
			placeholder="Thread title..."
			bind:value={titleValue}
		/>
		<input
			type="text"
			class="forum-new-thread-category"
			placeholder="Category (optional)"
			bind:value={categoryValue}
			list="forum-category-options"
		/>
		<datalist id="forum-category-options">
			{#each categoryOptions as cat}
				<option value={cat}></option>
			{/each}
		</datalist>
	{/if}
	<div class="forum-composer-tabs">
		<button
			class="forum-composer-tab"
			class:active={!previewMode}
			on:click={() => previewMode = false}
		>
			Write
		</button>
		<button
			class="forum-composer-tab"
			class:active={previewMode}
			on:click={() => previewMode = true}
		>
			Preview
		</button>
	</div>
	{#if previewMode}
		<div class="forum-preview">{bodyValue || 'Nothing to preview'}</div>
	{:else}
		<textarea
			class="forum-composer-textarea"
			bind:value={bodyValue}
			{placeholder}
			on:keydown={handleKeydown}
		></textarea>
	{/if}
	<div class="forum-composer-footer">
		<span class="forum-composer-hint">Ctrl+Enter to post · **bold** `code` @mentions</span>
		<div style="display:flex; gap: var(--space-2);">
			{#if onCancel}
				<button class="forum-composer-post-btn" style="background: var(--surface-hover); color: var(--text-heading);" on:click={onCancel}>
					Cancel
				</button>
			{/if}
			<button
				class="forum-composer-post-btn"
				disabled={!bodyValue.trim()}
				on:click={handleSubmit}
			>
				{showTitle ? 'Create Thread' : 'Post Reply'}
			</button>
		</div>
	</div>
</div>
