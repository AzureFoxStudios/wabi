<script lang="ts">
	import ReaderIcon from './ReaderIcon.svelte';
	import type { ReaderDocumentFormat } from '$lib/readerWorkspace';

	let {
		importTitle = $bindable(''),
		importContent = $bindable(''),
		importFormat = $bindable<ReaderDocumentFormat>('markdown'),
		onClose = () => {},
		onSubmit = () => {}
	}: {
		importTitle?: string;
		importContent?: string;
		importFormat?: ReaderDocumentFormat;
		onClose?: () => void;
		onSubmit?: () => void;
	} = $props();

	function openDialog(node: HTMLDialogElement) {
		node.showModal();
		return { destroy() { node.close(); } };
	}
</script>

<dialog class="reader-import-dialog" use:openDialog aria-label="Import into Reader" oncancel={onClose}>
	<form onsubmit={(event) => { event.preventDefault(); if (importContent.trim()) onSubmit(); }}>
		<div class="reader-panel-heading"><h2>Open something to read</h2><button class="reader-tool" type="button" onclick={onClose} aria-label="Close import dialog"><ReaderIcon name="close" /></button></div>
		<div class="reader-import-grid">
			<label class="reader-field">Title<input type="text" bind:value={importTitle} maxlength="240" placeholder="Document title" /></label>
			<label class="reader-field">Format<select bind:value={importFormat}><option value="text">Plain text</option><option value="markdown">Markdown</option><option value="html">HTML</option></select></label>
		</div>
		<label class="reader-field">Content<textarea bind:value={importContent} rows="12" placeholder="Paste an article, chapter, essay, or notes here."></textarea></label>
		<div class="reader-import-actions"><button type="button" class="reader-secondary-button" onclick={onClose}>Cancel</button><button class="reader-secondary-button reader-import-submit" type="submit" disabled={!importContent.trim()}>Open in Reader</button></div>
	</form>
</dialog>
