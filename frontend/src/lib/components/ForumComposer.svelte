<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { forumDrafts, type ForumDraft } from '$lib/forumDraftState';
	import { captureGroupAccess } from '$lib/groupAccess';
	import { composerDraftRealm } from '$lib/composerDraftState';
	import type { ForumAttachment } from '$lib/forumStore';
	import { uploadFileResumable } from './chat/uploadResumable';

	export let placeholder = 'Write a reply... Ctrl+Enter to post';
	export let showTitle = false;
	export let categoryOptions: string[] = [];
	export let channelId = '';
	export let draftSurface = 'center';
	export let draftKey = 'new';
	export let onSubmit: (body: string, title?: string, category?: string) => Promise<boolean>;
	export let onCancel: (() => void) | undefined = undefined;

	const MAX_FORUM_IMAGES = 8;
	const MAX_FORUM_IMAGE_BYTES = 25 * 1024 * 1024;

	const draftOwner = forumDrafts.open(channelId, captureGroupAccess(channelId), `${draftSurface}:${draftKey}`);
	const restored = draftOwner.initial;
	let mounted = true;
	let discarded = false;
	let titleValue = restored?.title || '';
	let categoryValue = restored?.category || '';
	let bodyValue = restored?.body || '';
	let previewMode = false;
	let selectedFiles: File[] = restored?.files || [];
	let previews: string[] = selectedFiles.map(file => URL.createObjectURL(file));
	let fileInput: HTMLInputElement | null = null;
	let isUploading = false;
	let isSubmitting = draftOwner.isSending();
	const uploadedFiles = new Map<File, ForumAttachment>(restored?.uploaded || []);
	let uploadedScope = JSON.stringify([composerDraftRealm(), channelId]);
	let uploadProgress = 0;
	let uploadError: string | null = null;

	function snapshot(): ForumDraft {
		return { body: bodyValue, title: titleValue, category: categoryValue, files: selectedFiles, uploaded: [...uploadedFiles] };
	}

	function restore(draft: ForumDraft) {
		revokePreviews();
		bodyValue = draft.body;
		titleValue = draft.title;
		categoryValue = draft.category;
		selectedFiles = draft.files;
		previews = selectedFiles.map(file => URL.createObjectURL(file));
		uploadedFiles.clear();
		for (const [file, uploaded] of draft.uploaded) uploadedFiles.set(file, uploaded);
	}

	onMount(() => {
		const latest = draftOwner.read();
		if (latest) restore(latest);
		isSubmitting = draftOwner.isSending();
		return draftOwner.onSendState((pending, update) => {
			if (!mounted || !draftOwner.current()) return;
			isSubmitting = pending;
			if (update) {
				const next = update(snapshot());
				restore(next);
				draftOwner.save(next);
			}
		});
	});

	onDestroy(() => {
		if (!discarded) draftOwner.save(snapshot());
		mounted = false;
		revokePreviews();
	});

	$: canSubmit = (bodyValue.trim().length > 0 || selectedFiles.length > 0) && !isSubmitting;

	function revokePreviews() {
		for (const url of previews) {
			try {
				URL.revokeObjectURL(url);
			} catch {
				// no-op
			}
		}
	}

	function handleFilesPicked(event: Event) {
		if (isSubmitting) return;
		uploadError = null;
		const input = event.target as HTMLInputElement;
		const picked = Array.from(input.files || []).filter((f) => f.type.startsWith('image/'));
		input.value = '';
		if (picked.length === 0) return;
		const room = MAX_FORUM_IMAGES - selectedFiles.length;
		if (room <= 0) {
			uploadError = `Up to ${MAX_FORUM_IMAGES} images per post.`;
			return;
		}
		const accepted: File[] = [];
		for (const file of picked.slice(0, room)) {
			if (file.size > MAX_FORUM_IMAGE_BYTES) {
				uploadError = `"${file.name}" is over 25MB and was skipped.`;
				continue;
			}
			accepted.push(file);
		}
		if (picked.length > room) {
			uploadError = `Up to ${MAX_FORUM_IMAGES} images per post.`;
		}
		selectedFiles = [...selectedFiles, ...accepted];
		previews = [...previews, ...accepted.map((f) => URL.createObjectURL(f))];
	}

	function removeImage(index: number) {
		if (isSubmitting) return;
		uploadedFiles.delete(selectedFiles[index]);
		const url = previews[index];
		if (url) {
			try {
				URL.revokeObjectURL(url);
			} catch {
				// no-op
			}
		}
		selectedFiles = selectedFiles.filter((_, i) => i !== index);
		previews = previews.filter((_, i) => i !== index);
	}

	function resetComposer() {
		uploadedFiles.clear();
		bodyValue = '';
		titleValue = '';
		categoryValue = '';
		previewMode = false;
		revokePreviews();
		selectedFiles = [];
		previews = [];
		uploadError = null;
		uploadProgress = 0;
	}

	async function handleSubmit() {
		if (isSubmitting || !canSubmit) return;
		const text = bodyValue.trim();
		if (!text && selectedFiles.length === 0) return;
		const submittingChannel = channelId;
		const submittingRealm = composerDraftRealm();
		const scope = JSON.stringify([submittingRealm, submittingChannel]);
		if (uploadedScope !== scope) { uploadedFiles.clear(); uploadedScope = scope; }
		const isCurrent = () => mounted && draftOwner.current() && channelId === submittingChannel && composerDraftRealm() === submittingRealm;
		draftOwner.save(snapshot());
		const transaction = draftOwner.beginSend();
		if (!transaction) return;
		isSubmitting = true;
		uploadError = null;
		uploadProgress = 0;
		try {
			const uploaded: ForumAttachment[] = [];
			isUploading = selectedFiles.some(file => !uploadedFiles.has(file));
			for (let i = 0; i < selectedFiles.length; i++) {
				const file = selectedFiles[i];
				let attachment = uploadedFiles.get(file);
				if (!attachment) {
					const result = await uploadFileResumable(file, submittingChannel || 'forum', (pct) => {
						uploadProgress = Math.round(((i + pct / 100) / selectedFiles.length) * 100);
					}, true, undefined, isCurrent);
					attachment = { url: result.fileUrl, name: result.fileName || file.name,
						size: result.fileSize ?? file.size, mime: file.type || 'image/*' };
					uploadedFiles.set(file, attachment);
				}
				uploaded.push(attachment);
			}
			isUploading = false;
			const markdown = uploaded.map((a) => `![${a.name.replace(/[\[\]\n]/g, '')}](${a.url})`).join('\n');
			const finalBody = markdown ? (text ? `${text}\n\n${markdown}` : markdown) : text;
			if (!isCurrent()) throw new Error('Account or channel changed; post was not sent');
			const accepted = await onSubmit(finalBody,
				showTitle ? titleValue.trim() || undefined : undefined,
				showTitle ? categoryValue.trim() || undefined : undefined);
			if (accepted) {
				transaction.settle(() => ({ body: '', title: '', category: '', files: [], uploaded: [] }));
				if (mounted && draftOwner.current()) resetComposer();
			}
			else uploadError = 'Post was not confirmed. Your draft is still here; check the thread before retrying.';
		} catch (err) {
			uploadError = `${err instanceof Error ? err.message : 'Posting failed'}. Your draft is still here.`;
		} finally {
			if (mounted) draftOwner.save(snapshot());
			transaction.finish();
			isUploading = false;
			isSubmitting = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			void handleSubmit();
		}
	}

	export function confirmDiscard(): boolean {
		if (isSubmitting) return false;
		if ((bodyValue.trim() || titleValue.trim() || selectedFiles.length) && !window.confirm('Discard this unsaved forum draft?')) return false;
		discarded = true;
		resetComposer();
		draftOwner.clear();
		return true;
	}

	function handleCancel() {
		if (!confirmDiscard()) return;
		resetComposer();
		onCancel?.();
	}
</script>

<div class="forum-composer">
	{#if showTitle}
		<input
			type="text"
			class="forum-new-thread-title"
			placeholder="Thread title..."
			bind:value={titleValue}
			disabled={isSubmitting}
		/>
		<input
			type="text"
			class="forum-new-thread-category"
			placeholder="Category (optional)"
			bind:value={categoryValue}
			disabled={isSubmitting}
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
			disabled={isSubmitting}
			{placeholder}
			on:keydown={handleKeydown}
		></textarea>
	{/if}
	{#if previews.length > 0}
		<div class="forum-attach-strip">
			{#each previews as preview, i}
				<div class="forum-attach-thumb">
					<img src={preview} alt={selectedFiles[i]?.name || `Image ${i + 1}`} />
					<button
						class="forum-attach-remove"
						title="Remove image"
						aria-label="Remove image {selectedFiles[i]?.name || i + 1}"
						on:click={() => removeImage(i)}
						disabled={isSubmitting}
					>&#10005;</button>
				</div>
			{/each}
		</div>
	{/if}
	{#if uploadError}
		<div class="forum-attach-error" role="alert">{uploadError}</div>
	{/if}
	{#if isUploading}
		<div class="forum-upload-progress" role="status">
			<span>Uploading images… {uploadProgress}%</span>
			<div class="forum-upload-bar"><div class="forum-upload-fill" style="width: {uploadProgress}%"></div></div>
		</div>
	{/if}
	<input
		type="file"
		accept="image/*"
		multiple
		class="forum-file-input-hidden"
		bind:this={fileInput}
		on:change={handleFilesPicked}
	/>
	<div class="forum-composer-footer">
		<span class="forum-composer-hint">Ctrl+Enter to post · **bold** `code` @mentions</span>
		<div style="display:flex; gap: var(--space-2);">
			<button
				class="forum-attach-btn"
				title="Attach images"
				aria-label="Attach images"
				on:click={() => fileInput?.click()}
				disabled={isSubmitting || selectedFiles.length >= MAX_FORUM_IMAGES}
			>
				<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<rect x="3" y="3" width="18" height="18" rx="2" />
					<circle cx="8.5" cy="8.5" r="1.5" />
					<path d="m21 15-5-5L5 21" />
				</svg>
				{#if selectedFiles.length > 0}<span class="forum-attach-count">{selectedFiles.length}</span>{/if}
			</button>
			{#if onCancel}
				<button class="forum-composer-post-btn" style="background: var(--surface-hover); color: var(--text-heading);" on:click={handleCancel} disabled={isSubmitting}>
					Cancel
				</button>
			{/if}
			<button
				class="forum-composer-post-btn"
				disabled={!canSubmit}
				on:click={() => void handleSubmit()}
			>
				{isUploading ? 'Uploading…' : isSubmitting ? 'Posting…' : showTitle ? 'Create Thread' : 'Post Reply'}
			</button>
		</div>
	</div>
</div>
