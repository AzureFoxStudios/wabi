<script lang="ts">
	import { _ } from '$lib/i18n';
	import ForumBody from './ForumBody.svelte';
	import ProfileMedia from './ProfileMedia.svelte';
	import { mediaUrl } from '$lib/mediaUrl';
	import { onDestroy, onMount, tick } from 'svelte';
	import { forumDrafts, type ForumDraft } from '$lib/forumDraftState';
	import { captureGroupAccess } from '$lib/groupAccess';
	import { composerDraftRealm } from '$lib/composerDraftState';
	import type { ForumAttachment } from '$lib/forumStore';
	import { uploadFileResumable } from './chat/uploadResumable';
	import { confirmAction } from '$lib/confirm';
	import { currentUser } from '$lib/presenceIdentity';
	import { inkFor } from '$lib/theme/identity';
	import Icon from './ui/Icon.svelte';
	import Select from './ui/Select.svelte';
	import Segmented from './ui/Segmented.svelte';
	import Tooltip from './ui/Tooltip.svelte';

	export let placeholder = $_('forum.write_reply_placeholder');
	/** New-thread form (title, category, body) instead of the reply dock. */
	export let showTitle = false;
	export let categoryOptions: string[] = [];
	/** The category a new thread starts in (the list's applied filter). */
	export let initialCategory = '';
	/** Reply dock: whose thread this answers ("Reply to Mira…"). */
	export let replyTo = '';
	export let channelId = '';
	export let draftSurface = 'center';
	export let draftKey = 'new';
	export let onSubmit: (body: string, title?: string, category?: string) => Promise<boolean>;
	export let onCancel: (() => void) | undefined = undefined;
	/** The reply dock opened or folded: while it is open its "Post reply" is the view's primary. */
	export let onExpandedChange: ((expanded: boolean) => void) | undefined = undefined;

	const MAX_FORUM_IMAGES = 8;
	const MAX_FORUM_IMAGE_BYTES = 25 * 1024 * 1024;
	const NEW_CATEGORY = '\u0000new';
	const uid = `forum-composer-${draftSurface}-${draftKey}`.replace(/[^A-Za-z0-9_-]/g, '-');

	const draftOwner = forumDrafts.open(channelId, captureGroupAccess(channelId), `${draftSurface}:${draftKey}`);
	const restored = draftOwner.initial;
	let mounted = true;
	let discarded = false;
	let titleValue = restored?.title || '';
	let categoryChoice = '';
	let newCategoryName = '';
	let bodyValue = restored?.body || '';
	let view: 'write' | 'preview' = 'write';
	let selectedFiles: File[] = restored?.files || [];
	let previews: string[] = selectedFiles.map(file => URL.createObjectURL(file));
	let fileInput: HTMLInputElement | null = null;
	let textarea: HTMLTextAreaElement | null = null;
	let openButton: HTMLButtonElement | null = null;
	let isUploading = false;
	let isSubmitting = draftOwner.isSending();
	const uploadedFiles = new Map<File, ForumAttachment>(restored?.uploaded || []);
	let uploadedScope = JSON.stringify([composerDraftRealm(), channelId]);
	let uploadProgress = 0;
	let uploadError: string | null = null;
	setCategory(restored ? restored.category : initialCategory);
	// The reply dock starts collapsed (a field-button), unless a kept draft is waiting in it.
	let expanded = showTitle || hasContent();

	$: categorySelectOptions = [
		{ value: '', label: $_('forum_composer.no_category') },
		...categoryOptions.map((cat) => ({ value: cat, label: cat })),
		{ value: NEW_CATEGORY, label: $_('forum_composer.new_category') },
	];
	$: categoryValue = categoryChoice === NEW_CATEGORY ? newCategoryName : categoryChoice;
	$: canSubmit = (bodyValue.trim().length > 0 || selectedFiles.length > 0) && !isSubmitting;
	$: idleLabel = showTitle ? $_('forum.post_thread') : $_('forum.post_reply');
	$: busyLabel = isUploading ? $_('wb.uploading') : $_('forum_composer.posting');
	$: me = $currentUser;
	$: draftShown = bodyValue.trim().length > 0 || titleValue.trim().length > 0 || selectedFiles.length > 0;
	$: onExpandedChange?.(expanded);
	$: meInitial = ((me?.username || '?').trim().charAt(0) || '?').toUpperCase();

	function hasContent(): boolean {
		return Boolean(bodyValue.trim() || titleValue.trim() || selectedFiles.length);
	}

	function setCategory(category: string) {
		const name = category.trim();
		if (!name || categoryOptions.includes(name)) {
			categoryChoice = name;
			newCategoryName = '';
		} else {
			categoryChoice = NEW_CATEGORY;
			newCategoryName = name;
		}
	}

	function snapshot(): ForumDraft {
		return { body: bodyValue, title: titleValue, category: categoryValue, files: selectedFiles, uploaded: [...uploadedFiles] };
	}

	function restore(draft: ForumDraft) {
		revokePreviews();
		bodyValue = draft.body;
		titleValue = draft.title;
		setCategory(draft.category);
		selectedFiles = draft.files;
		previews = selectedFiles.map(file => URL.createObjectURL(file));
		uploadedFiles.clear();
		for (const [file, uploaded] of draft.uploaded) uploadedFiles.set(file, uploaded);
		if (hasContent()) expanded = true;
		void tick().then(autosize);
	}

	onMount(() => {
		const latest = draftOwner.read();
		if (latest) restore(latest);
		isSubmitting = draftOwner.isSending();
		void tick().then(autosize);
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

	function revokePreviews() {
		for (const url of previews) {
			try {
				URL.revokeObjectURL(url);
			} catch {
				// no-op
			}
		}
	}

	/** The field grows with the text (CSS caps the reply dock at 280px; the new-thread form scrolls). */
	function autosize() {
		if (!textarea) return;
		textarea.style.height = 'auto';
		textarea.style.height = `${textarea.scrollHeight + 2}px`;
	}

	async function expand() {
		expanded = true;
		view = 'write';
		await tick();
		autosize();
		textarea?.focus();
	}

	async function showWrite() {
		await tick();
		autosize();
	}
	$: if (view === 'write') void showWrite();

	function handleFilesPicked(event: Event) {
		if (isSubmitting) return;
		uploadError = null;
		const input = event.target as HTMLInputElement;
		const picked = Array.from(input.files || []).filter((f) => f.type.startsWith('image/'));
		input.value = '';
		if (picked.length === 0) return;
		const room = MAX_FORUM_IMAGES - selectedFiles.length;
		if (room <= 0) {
			uploadError = $_('forum_composer.max_images', { values: { max: MAX_FORUM_IMAGES } });
			return;
		}
		const accepted: File[] = [];
		for (const file of picked.slice(0, room)) {
			if (file.size > MAX_FORUM_IMAGE_BYTES) {
				uploadError = $_('forum_composer.too_big', { values: { name: file.name } });
				continue;
			}
			accepted.push(file);
		}
		if (picked.length > room) {
			uploadError = $_('forum_composer.max_images', { values: { max: MAX_FORUM_IMAGES } });
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
		setCategory(initialCategory);
		view = 'write';
		revokePreviews();
		selectedFiles = [];
		previews = [];
		uploadError = null;
		uploadProgress = 0;
		void tick().then(autosize);
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
				if (mounted && draftOwner.current()) {
					resetComposer();
					// The posted reply is in the thread; focus goes back to the dock's field-button.
					if (!showTitle) void collapse();
				}
			}
			else uploadError = $_('forum_composer.not_confirmed');
		} catch (err) {
			// The cause goes to the console; the page says what happened and what is unchanged (§7.16).
			console.error('[forum] posting failed', err);
			uploadError = showTitle ? $_('forum_composer.thread_failed') : $_('forum_composer.reply_failed');
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
			return;
		}
		// Esc folds an empty reply dock back to its field-button (a draft stays open until Cancel).
		if (e.key === 'Escape' && !showTitle && !hasContent() && !isSubmitting) {
			e.preventDefault();
			void collapse();
		}
	}

	async function collapse() {
		expanded = false;
		await tick();
		openButton?.focus();
	}

	/** Enter in a single-line field moves on to the body instead of submitting the form. */
	function nextOnEnter(e: KeyboardEvent) {
		if (e.key !== 'Enter' || e.ctrlKey || e.metaKey) return;
		e.preventDefault();
		view = 'write';
		void tick().then(() => textarea?.focus());
	}

	function askDiscard(): Promise<boolean> {
		if (!hasContent()) return Promise.resolve(true);
		return confirmAction({
			title: showTitle ? $_('forum_composer.discard_thread_title') : $_('forum_composer.discard_reply_title'),
			body: $_('forum_composer.discard_body'),
			confirm: showTitle ? $_('forum_composer.discard_thread') : $_('forum_composer.discard_reply'),
			danger: true,
		});
	}

	/** Leaving the thread or the form: asks before a non-empty draft is dropped. */
	export async function confirmDiscard(): Promise<boolean> {
		if (isSubmitting) return false;
		if (!(await askDiscard())) return false;
		discarded = true;
		resetComposer();
		draftOwner.clear();
		return true;
	}

	async function handleCancel() {
		if (isSubmitting) return;
		if (showTitle) {
			if (!(await confirmDiscard())) return;
			onCancel?.();
			return;
		}
		// The reply dock stays mounted: drop the draft and fold back to the field-button.
		if (!(await askDiscard())) return;
		resetComposer();
		draftOwner.clear();
		await collapse();
	}
</script>

{#if !expanded}
	<div class="forum-reply-dock">
		<button type="button" class="forum-reply-open" bind:this={openButton} on:click={() => void expand()}>
			<!-- The same stamp as the byline and the replies: the picture when there is one. -->
			<span class="forum-av forum-av--24" style={$inkFor(me?.color || me?.roleColor)} aria-hidden="true">
				{#if me?.profilePicture}<ProfileMedia src={mediaUrl(me.profilePicture)} alt="" />{:else}{meInitial}{/if}
			</span>
			<span class="forum-reply-open-text">{replyTo ? $_('forum_composer.reply_to', { values: { name: replyTo } }) : $_('forum_composer.write_reply')}</span>
		</button>
	</div>
{:else}
	<form
		class="forum-composer"
		class:forum-reply-dock={!showTitle}
		class:is-open={!showTitle}
		class:forum-new-thread={showTitle}
		aria-label={showTitle ? $_('forum.new_thread') : replyTo ? $_('forum_composer.reply_to_aria', { values: { name: replyTo } }) : $_('messages.actions.reply')}
		on:submit|preventDefault={() => void handleSubmit()}
	>
		<div class="forum-composer-inner">
			{#if showTitle}
				<h2 class="forum-new-thread-heading">{$_('forum.new_thread')}</h2>
				<div class="forum-form-row">
					<label class="w-label" for="{uid}-title">{$_('reader_doc.title_label')}</label>
					<input
						id="{uid}-title"
						type="text"
						class="w-field forum-new-thread-title"
						placeholder={$_('forum_composer.title_placeholder')}
						bind:value={titleValue}
						disabled={isSubmitting}
						on:keydown={nextOnEnter}
					/>
				</div>
				<div class="forum-form-row">
					<span class="w-label" id="{uid}-category">{$_('forum.category')}</span>
					<div class="forum-category-choice">
						<Select
							ariaLabel={$_('forum.category')}
							heading={$_('forum.category')}
							options={categorySelectOptions}
							bind:value={categoryChoice}
							disabled={isSubmitting}
						/>
						{#if categoryChoice === NEW_CATEGORY}
							<input
								type="text"
								class="w-field w-field--chrome forum-new-category"
								placeholder={$_('forum_composer.new_category_placeholder')}
								aria-label={$_('forum_composer.new_category_label')}
								bind:value={newCategoryName}
								disabled={isSubmitting}
								on:keydown={nextOnEnter}
							/>
						{/if}
					</div>
				</div>
			{/if}
			<div class="forum-composer-head">
				{#if showTitle}<span class="w-label" id="{uid}-body-label">{$_('forum_composer.post')}</span>{/if}
				<Segmented label={showTitle ? $_('forum_composer.post_editor') : $_('forum_composer.reply_editor')} options={[{ value: 'write', label: $_('forum.write') }, { value: 'preview', label: $_('messages.zip_preview.preview.show') }]} bind:value={view} />
			</div>
			{#if view === 'preview'}
				<div class="forum-preview" role="group" aria-label={$_('messages.zip_preview.preview.show')}>
					{#if bodyValue.trim()}
						<ForumBody text={bodyValue} />
					{:else}
						<p class="forum-preview-empty">{$_('wiki.nothing_to_preview')}</p>
					{/if}
				</div>
			{:else}
				<textarea
					id="{uid}-body"
					class="w-field forum-composer-textarea"
					bind:this={textarea}
					bind:value={bodyValue}
					disabled={isSubmitting}
					{placeholder}
					aria-label={showTitle ? $_('forum_composer.post') : replyTo ? $_('forum_composer.reply_to_aria', { values: { name: replyTo } }) : $_('messages.actions.reply')}
					aria-keyshortcuts="Control+Enter"
					on:keydown={handleKeydown}
					on:input={autosize}
				></textarea>
			{/if}
			{#if previews.length > 0}
				<div class="forum-attach-strip">
					{#each previews as preview, i}
						<div class="forum-attach-thumb">
							<img src={preview} alt={selectedFiles[i]?.name || $_('forum_composer.image_alt', { values: { n: i + 1 } })} />
							<button
								type="button"
								class="forum-attach-remove"
								aria-label={$_('forum_composer.remove_image', { values: { name: selectedFiles[i]?.name || i + 1 } })}
								on:click={() => removeImage(i)}
								disabled={isSubmitting}
							><Icon name="x" size={14} /></button>
						</div>
					{/each}
				</div>
			{/if}
			{#if uploadError}
				<p class="w-field-error forum-composer-error" role="alert"><Icon name="alert" size={14} />{uploadError}</p>
			{/if}
			{#if isUploading}
				<div class="forum-upload-progress" role="status">
					<span>{$_('forum_composer.uploading_images', { values: { pct: uploadProgress } })}</span>
					<div class="forum-upload-bar"><div class="forum-upload-fill" style="width: {uploadProgress}%"></div></div>
				</div>
			{/if}
			<input
				type="file"
				accept="image/*"
				multiple
				class="forum-file-input-hidden"
				tabindex="-1"
				aria-hidden="true"
				bind:this={fileInput}
				on:change={handleFilesPicked}
			/>
			<div class="forum-composer-foot">
				<Tooltip text={selectedFiles.length ? $_('forum_composer.attach_count', { values: { count: selectedFiles.length, max: MAX_FORUM_IMAGES } }) : $_('forum_composer.attach')}>
					<button
						type="button"
						class="w-ibtn forum-attach-btn"
						aria-label={selectedFiles.length ? $_('forum_composer.attach_added', { values: { count: selectedFiles.length, max: MAX_FORUM_IMAGES } }) : $_('forum_composer.attach')}
						on:click={() => fileInput?.click()}
						disabled={isSubmitting || selectedFiles.length >= MAX_FORUM_IMAGES}
					><Icon name="image" /></button>
				</Tooltip>
				{#if draftShown}
					<span class="forum-draft-note" title={$_('forum_composer.draft_note_title')}>{$_('locality.draft_kept')}</span>
				{/if}
				<span class="forum-composer-actions">
					{#if !showTitle || onCancel}
						<button type="button" class="w-btn w-btn--quiet" on:click={() => void handleCancel()} disabled={isSubmitting}>{$_('common.cancel')}</button>
					{/if}
					<Tooltip text={idleLabel} shortcut="Ctrl Enter">
						<button type="submit" class="w-btn w-btn--primary forum-post-btn" aria-busy={isSubmitting} disabled={!canSubmit} aria-keyshortcuts="Control+Enter">
							<span class="w-btn__swap"><span>{idleLabel}</span><span>{busyLabel}</span></span>
						</button>
					</Tooltip>
				</span>
			</div>
		</div>
	</form>
{/if}
