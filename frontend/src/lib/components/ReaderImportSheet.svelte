<script lang="ts">
	import { _ } from '$lib/i18n';
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

<dialog class="reader-import-dialog" use:openDialog aria-label={$_('ris.dialog')} oncancel={onClose}>
	<form onsubmit={(event) => { event.preventDefault(); if (importContent.trim()) onSubmit(); }}>
		<div class="reader-panel-heading"><h2>{$_('ris.title')}</h2><button class="reader-tool" type="button" onclick={onClose} aria-label={$_('ris.close')}><ReaderIcon name="close" /></button></div>
		<div class="reader-import-grid">
			<label class="reader-field">{$_('reader_doc.title_label')}<input type="text" bind:value={importTitle} maxlength="240" placeholder={importFormat === 'code' ? $_('ris.filename_ph') : $_('office.editor.document_title')} /></label>
			<label class="reader-field">{$_('office.editor.format')}<select bind:value={importFormat}><option value="text">{$_('ris.plain')}</option><option value="markdown">Markdown</option><option value="html">HTML</option><option value="code">{$_('error_page.source_code')}</option></select></label>
		</div>
		<label class="reader-field">{$_('wb.lock_content')}<textarea bind:value={importContent} rows="12" placeholder={importFormat === 'code' ? $_('ris.code_ph') : $_('ris.text_ph')}></textarea></label>
		<div class="reader-import-actions"><button type="button" class="reader-secondary-button" onclick={onClose}>{$_('common.cancel')}</button><button class="reader-secondary-button reader-import-submit" type="submit" disabled={!importContent.trim()}>{$_('ris.open')}</button></div>
	</form>
</dialog>
