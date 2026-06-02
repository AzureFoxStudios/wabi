<script lang="ts">
	import type { ReaderDocumentFormat } from '$lib/readerWorkspace';

	export let importTitle = '';
	export let importContent = '';
	export let importFormat: ReaderDocumentFormat = 'markdown';
	export let onClose: () => void = () => {};
	export let onSubmit: () => void = () => {};
</script>

<div class="reader-import-sheet">
	<div class="reader-import-card">
		<div class="reader-import-header">
			<h3>Import Into Reader</h3>
			<button class="reader-action-btn subtle" type="button" on:click={onClose}>Close</button>
		</div>
		<div class="reader-import-grid">
			<label class="reader-field">
				<span>Title</span>
				<input
					type="text"
					bind:value={importTitle}
					placeholder="Document title"
				/>
			</label>
			<label class="reader-field">
				<span>Format</span>
				<select bind:value={importFormat}>
					<option value="markdown">Markdown</option>
					<option value="text">Plain text</option>
					<option value="html">HTML</option>
				</select>
			</label>
		</div>
		<label class="reader-field block">
			<span>Content</span>
			<textarea
				bind:value={importContent}
				rows="14"
				placeholder="Paste an article, chapter, essay, or issue draft here."
			></textarea>
		</label>
		<div class="reader-import-actions">
			<button class="reader-action-btn" type="button" on:click={onSubmit} disabled={!importContent.trim()}>
				Open In Reader
			</button>
		</div>
	</div>
</div>
