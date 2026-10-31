<script lang="ts">
	/**
	 * My Planner — Journal (design contract §8.6, §8.7). One 680px column on the page, set in the
	 * prose style: a short intro, then the entries newest first, each under its date kicker. A day
	 * opens as a page in the same column (a crumb back to the Journal, ‹ › to step days, Today),
	 * and the editor sits inline in that page: no dialog, no card in a card.
	 *
	 * Truth: where the Journal is kept is said once, by the Planner's row A tag ("Only you · this
	 * device" or "Synced to server"); nothing here repeats it. "Personal entry" is a marker for
	 * the writer only: it never changes who can read an entry, so it carries no lock and is never
	 * called private.
	 *
	 * Svelte 4 (`export let`) — matches the business tree.
	 */
	import { tick } from 'svelte';
	import ImageViewer from '$lib/components/ImageViewer.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import Segmented from '$lib/components/ui/Segmented.svelte';
	import Switch from '$lib/components/ui/Switch.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import { parseMessage } from '$lib/markdown';
	import { journalCodeBlock } from '$lib/business/journalFormatting';
	import { plannerActor as currentUser } from '$lib/business/personalWorkspace';
	import {
		diaryEntries,
		addDiaryEntry,
		updateDiaryEntry,
		deleteDiaryEntry,
		getDiaryEntryForDate
	} from '$lib/business/store';
	import type { DiaryEntry } from '$lib/business/types';
	import { confirmAction } from '$lib/confirm';
	import { DAY_MS, sameDay, startOfDay } from '$lib/business/plannerCalendar';
	import { isMobile } from '$lib/layoutStoreStates';
	import SignatureRow from './SignatureRow.svelte';

	// Props
	// The empty states point at the masthead's New entry. On the phone that control is a bare +
	// glyph, so the sentence names what the person can actually see.
	$: newEntryWords = $isMobile ? '+' : 'New entry';

	export let isReadOnly = false;
	export let embedded = false;
	export let addSignal = 0;

	const uid = Math.random().toString(36).slice(2, 8);

	let selectedDate: Date | null = null;
	let isEditing = false;
	let currentEntry: DiaryEntry | null = null;
	let viewingImage: string | null = null;
	let lastAddSignal = 0;

	// Host "New ▾ → journal entry" trigger
	$: if (addSignal > lastAddSignal) {
		lastAddSignal = addSignal;
		goToToday();
		startEditing();
	}

	// Form state
	let formContent = '';
	let formTags = '';
	let formIsPrivate = false;
	let formImages: string[] = [];
	/** Draft sign-offs for the entry being edited (multi-sign). */
	let draftSignatures: DiaryEntry['signatures'] = [];
	/** Legacy signer name of the loaded entry (read-only display). */
	let legacySignedBy: string | undefined = undefined;
	let fileInput: HTMLInputElement;
	let codeInput: HTMLInputElement;
	let contentEditor: HTMLTextAreaElement;
	let editorMode: 'write' | 'preview' = 'write';
	let attachmentError = '';
	let editorGeneration = 0;

	const editorModes = [
		{ value: 'write' as const, label: 'Write' },
		{ value: 'preview' as const, label: 'Preview' }
	];

	// ── words ──
	const longDate = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
	const kickerDate = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
	const monthFormat = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
	const clockFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
	const shortDate = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

	function relativeDay(date: Date): string | null {
		const today = startOfDay(Date.now());
		const day = startOfDay(date);
		const diff = Math.round((day.getTime() - today.getTime()) / DAY_MS);
		if (diff === 0) return 'Today';
		if (diff === -1) return 'Yesterday';
		return null;
	}

	function written(entry: DiaryEntry): string {
		const at = new Date(entry.createdAt);
		const onDay = sameDay(at, new Date(entry.date));
		const when = onDay ? clockFormat.format(at) : `${shortDate.format(at)}, ${clockFormat.format(at)}`;
		return entry.updatedAt !== entry.createdAt ? `Written ${when} · edited ${shortDate.format(new Date(entry.updatedAt))}` : `Written ${when}`;
	}

	// ── editor helpers ──
	function insertFormatting(before: string, after = '') {
		const start = contentEditor?.selectionStart ?? formContent.length;
		const end = contentEditor?.selectionEnd ?? start;
		formContent = formContent.slice(0, start) + before + formContent.slice(start, end) + after + formContent.slice(end);
		editorMode = 'write';
		void tick().then(() => {
			contentEditor?.focus();
			contentEditor?.setSelectionRange(start + before.length, end + before.length);
		});
	}

	async function importCode(event: Event) {
		const input = event.target as HTMLInputElement;
		const generation = editorGeneration;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		if (file.size > 1024 * 1024) {
			attachmentError = 'Choose a text or code file smaller than 1 MB.';
			return;
		}
		try {
			const content = await file.text();
			if (generation !== editorGeneration) return;
			if (content.includes('\0')) {
				attachmentError = 'This looks like a binary file. Add a link to it instead.';
				return;
			}
			formContent += `\n\n${journalCodeBlock(content, file.name.split('.').pop() || '')}\n`;
			attachmentError = '';
			editorMode = 'write';
		} catch {
			attachmentError = 'Could not read that file. Please try again.';
		}
	}

	function pasteImages(event: ClipboardEvent) {
		const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith('image/'));
		if (files.length) {
			event.preventDefault();
			addImages(files);
		}
	}

	function addImages(files: File[]) {
		const generation = editorGeneration;
		for (const file of files) {
			if (!file.type.startsWith('image/')) continue;
			if (file.size > 5 * 1024 * 1024) {
				attachmentError = 'Choose images smaller than 5 MB each.';
				continue;
			}
			const reader = new FileReader();
			reader.onload = () => {
				if (generation === editorGeneration && typeof reader.result === 'string') formImages = [...formImages, reader.result];
			};
			reader.onerror = () => (attachmentError = 'Could not read that image. Please try again.');
			reader.readAsDataURL(file);
		}
	}

	function handleImageUpload(event: Event) {
		const input = event.target as HTMLInputElement;
		if (!input.files?.length) return;
		addImages(Array.from(input.files));
		// Reset input so the same file can be chosen again
		input.value = '';
	}

	function removeImage(index: number) {
		formImages = formImages.filter((_, i) => i !== index);
	}

	/** The writing area grows with the text (no inner scroller); `value` re-fits it on outside changes. */
	function autogrow(node: HTMLTextAreaElement, value?: string) {
		void value;
		const fit = () => {
			node.style.height = 'auto';
			node.style.height = `${node.scrollHeight + 2}px`;
		};
		fit();
		node.addEventListener('input', fit);
		const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
		observer?.observe(node);
		return {
			update: fit,
			destroy() {
				node.removeEventListener('input', fit);
				observer?.disconnect();
			}
		};
	}

	// ── days ──
	function prevDay() {
		if (!selectedDate) return;
		selectedDate = new Date(selectedDate.getTime() - DAY_MS);
		loadEntry();
	}

	function nextDay() {
		if (!selectedDate || !canGoNext) return;
		selectedDate = new Date(selectedDate.getTime() + DAY_MS);
		loadEntry();
	}

	function goToToday() {
		selectedDate = new Date();
		loadEntry();
	}

	async function clearSelection() {
		selectedDate = null;
		currentEntry = null;
		isEditing = false;
		resetForm();
		await tick();
		document.getElementById(`journal-${uid}-title`)?.focus();
	}

	function loadEntry() {
		editorGeneration++;
		editorMode = 'write';
		attachmentError = '';
		if (!selectedDate) {
			currentEntry = null;
			resetForm();
			return;
		}
		const entry = getDiaryEntryForDate(selectedDate.getTime());
		currentEntry = entry || null;
		if (entry) {
			formContent = entry.content;
			formTags = entry.tags?.join(', ') || '';
			formIsPrivate = entry.isPrivate;
			formImages = entry.images || [];
			draftSignatures = entry.signatures ? [...entry.signatures] : [];
			legacySignedBy = entry.signatures?.length ? undefined : entry.signedBy;
		} else {
			resetForm();
		}
		isEditing = false;
	}

	function resetForm() {
		editorGeneration++;
		editorMode = 'write';
		attachmentError = '';
		formContent = '';
		formTags = '';
		formIsPrivate = false;
		formImages = [];
		draftSignatures = [];
		legacySignedBy = undefined;
	}

	async function startEditing() {
		if (isReadOnly) return;
		isEditing = true;
		await tick();
		contentEditor?.focus();
	}

	function cancelEditing() {
		loadEntry();
	}

	function handleSave() {
		if (!selectedDate) return;
		const entryData = {
			date: new Date(selectedDate).setHours(12, 0, 0, 0), // Normalize to noon
			content: formContent.trim(),
			images: formImages.length > 0 ? formImages : undefined,
			tags: formTags ? formTags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
			isPrivate: formIsPrivate,
			createdBy: $currentUser?.id || 'unknown',
			signatures: draftSignatures.length > 0 ? [...draftSignatures] : undefined,
			// Legacy single-signer mirror (first signer's name) for older clients.
			signedBy: draftSignatures.length > 0 ? draftSignatures[0].name : undefined
		};

		if (currentEntry) {
			updateDiaryEntry(currentEntry.id, entryData);
		} else {
			addDiaryEntry(entryData);
		}

		loadEntry();
	}

	async function handleDelete() {
		if (!currentEntry || !selectedDate) return;
		const confirmed = await confirmAction({
			title: 'Delete this entry?',
			body: `The entry for ${kickerDate.format(selectedDate)} will be removed from your Journal.`,
			confirm: 'Delete entry',
			danger: true
		});
		if (!confirmed || !currentEntry) return;
		deleteDiaryEntry(currentEntry.id);
		currentEntry = null;
		resetForm();
	}

	function selectEntry(entry: DiaryEntry, edit = false) {
		selectedDate = new Date(entry.date);
		loadEntry();
		if (edit) void startEditing();
	}

	function writeToday() {
		goToToday();
		void startEditing();
	}

	/** The editor is a form; Enter in a one-line field must not submit it (only Save does). */
	function keepEditingOnEnter(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.isComposing) event.preventDefault();
	}

	// Sort entries by date (newest first)
	$: sortedEntries = [...$diaryEntries].sort((a, b) => b.date - a.date);

	// Group entries by month for display
	$: months = sortedEntries.reduce(
		(groups, entry) => {
			const date = new Date(entry.date);
			const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
			const last = groups[groups.length - 1];
			if (last && last.key === key) last.entries.push(entry);
			else groups.push({ key, label: monthFormat.format(date), entries: [entry] });
			return groups;
		},
		[] as { key: string; label: string; entries: DiaryEntry[] }[]
	);

	$: todayEntry = (void $diaryEntries, getDiaryEntryForDate(Date.now()));
	$: canGoNext = selectedDate ? startOfDay(selectedDate.getTime() + DAY_MS).getTime() <= Date.now() : false;
	$: onToday = selectedDate ? sameDay(selectedDate, new Date()) : false;
	$: canSave = formContent.trim().length > 0 || formImages.length > 0;
</script>

{#snippet entryFooter(entry: DiaryEntry)}
	{@const names = entry.signatures?.length ? entry.signatures.map((s) => s.name).join(', ') : entry.signedBy}
	<p class="jr-meta">
		<span>{written(entry)}</span>
		{#if entry.isPrivate}<span class="w-tag jr-personal" title="A marker for you; it does not change who can read this entry">Personal</span>{/if}
		{#if names}<span class="jr-names">Names attached: {names}</span>{/if}
	</p>
	{#if entry.tags?.length}
		<ul class="jr-tags" aria-label="Tags">
			{#each entry.tags as tag}<li class="w-tag">{tag}</li>{/each}
		</ul>
	{/if}
{/snippet}

<div class="journal" class:journal--embedded={embedded}>
	{#if !selectedDate}
		<!-- The Journal: an intro and the entries, newest first. -->
		<div class="jr-column">
			<header class="jr-intro">
				<h2 class="jr-title" id={`journal-${uid}-title`} tabindex="-1">Journal</h2>
				<p class="jr-lede">One page a day for sketches, decisions and small discoveries.</p>
				<!-- In My Planner the masthead's "New entry" is this view's one primary and writes today's
				     entry, so the page offers no second copy of it (§7.1). -->
				{#if !isReadOnly && sortedEntries.length > 0 && (todayEntry || !embedded)}
					<div class="jr-intro__actions">
						{#if todayEntry}
							<button type="button" class="w-btn" on:click={() => todayEntry && selectEntry(todayEntry)}>Open today’s entry</button>
						{:else}
							<button type="button" class="w-btn w-btn--primary" on:click={writeToday}><Icon name="pencil" size={16} />Write today’s entry</button>
						{/if}
					</div>
				{/if}
			</header>

			{#if sortedEntries.length === 0}
				<EmptyState
					icon="book"
					as="h3"
					title="No journal entries yet"
					text={embedded && !isReadOnly
						? `Use ${newEntryWords} to write a few lines for today. Photos and sketches are welcome.`
						: 'Write a few lines for today. Photos and sketches are welcome.'}
					action={isReadOnly || embedded ? undefined : 'Write today’s entry'}
					onaction={writeToday}
					class="jr-empty"
				/>
			{:else}
				{#each months as month (month.key)}
					<section class="jr-month" aria-labelledby={`journal-${uid}-${month.key}`}>
						<h3 class="jr-month__title" id={`journal-${uid}-${month.key}`}>{month.label}</h3>
						{#each month.entries as entry (entry.id)}
							{@const day = new Date(entry.date)}
							{@const word = relativeDay(day)}
							<article class="jr-entry" aria-labelledby={`journal-${uid}-e-${entry.id}`}>
								<div class="jr-entry__head">
									<h4 class="jr-kicker" id={`journal-${uid}-e-${entry.id}`}>
										<button type="button" class="jr-kicker__link" on:click={() => selectEntry(entry)}>
											{word ? `${word} · ${kickerDate.format(day)}` : kickerDate.format(day)}
										</button>
									</h4>
									{#if !isReadOnly}
										<button type="button" class="w-btn w-btn--sm w-btn--quiet jr-entry__edit" on:click={() => selectEntry(entry, true)} aria-label={`Edit the entry for ${kickerDate.format(day)}`}>Edit</button>
									{/if}
								</div>
								{#if entry.content.trim()}
									<div class="w-prose jr-prose">{@html parseMessage(entry.content, [], { allowTables: true })}</div>
								{/if}
								{#if entry.images?.length}
									<div class="jr-gallery">
										{#each entry.images.slice(0, 4) as image, i}
											<button type="button" class="jr-thumb" on:click={() => (viewingImage = image)} aria-label={`View picture ${i + 1} of ${entry.images.length}`}>
												<img src={image} alt="" />
											</button>
										{/each}
										{#if entry.images.length > 4}
											<button type="button" class="jr-thumb jr-thumb--more" on:click={() => selectEntry(entry)}>+{entry.images.length - 4}</button>
										{/if}
									</div>
								{/if}
								{@render entryFooter(entry)}
							</article>
						{/each}
					</section>
				{/each}
			{/if}
		</div>
	{:else}
		<!-- One day as a page: crumb, day steppers, the entry or the editor inline. -->
		<div class="jr-column">
			<nav class="jr-crumb" aria-label="Journal">
				<button type="button" class="jr-crumb__back" on:click={clearSelection}><Icon name="chevLeft" size={16} />Journal</button>
				<span class="jr-crumb__steps">
					<Tooltip text="Previous day">
						<button type="button" class="w-ibtn" aria-label="Previous day" on:click={prevDay}><Icon name="chevLeft" /></button>
					</Tooltip>
					<Tooltip text={canGoNext ? 'Next day' : 'Today is the latest day'}>
						<button type="button" class="w-ibtn" aria-label="Next day" on:click={nextDay} disabled={!canGoNext}><Icon name="chevRight" /></button>
					</Tooltip>
					<button type="button" class="w-btn w-btn--sm" on:click={goToToday} disabled={onToday}>Today</button>
				</span>
			</nav>

			<header class="jr-day">
				{#if relativeDay(selectedDate)}<p class="jr-kicker">{relativeDay(selectedDate)}</p>{/if}
				<h2 class="jr-day__title" aria-live="polite">{longDate.format(selectedDate)}</h2>
			</header>

			{#if isEditing}
				<!-- The editor, inline on the page. -->
				<form class="jr-editor" on:submit|preventDefault={handleSave}>
					<div class="jr-toolbar" role="toolbar" aria-label="Formatting">
						<Tooltip text="Bold"><button type="button" class="w-ibtn" aria-label="Bold" on:click={() => insertFormatting('**', '**')}><Icon name="bold" /></button></Tooltip>
						<Tooltip text="Heading"><button type="button" class="w-ibtn" aria-label="Heading" on:click={() => insertFormatting('## ')}><Icon name="heading" /></button></Tooltip>
						<Tooltip text="Link"><button type="button" class="w-ibtn" aria-label="Link" on:click={() => insertFormatting('[', '](https://)')}><Icon name="link" /></button></Tooltip>
						<Tooltip text="List"><button type="button" class="w-ibtn" aria-label="List" on:click={() => insertFormatting('\n- ')}><Icon name="list" /></button></Tooltip>
						<Tooltip text="Code block"><button type="button" class="w-ibtn" aria-label="Code block" on:click={() => insertFormatting('\n```\n', '\n```\n')}><Icon name="code" /></button></Tooltip>
						<span class="jr-toolbar__sep" aria-hidden="true"></span>
						<Tooltip text="Add pictures"><button type="button" class="w-ibtn" aria-label="Add pictures" on:click={() => fileInput.click()}><Icon name="image" /></button></Tooltip>
						<Tooltip text="Add a text or code file (kept as text)"><button type="button" class="w-ibtn" aria-label="Add a text or code file" on:click={() => codeInput.click()}><Icon name="file" /></button></Tooltip>
						<Segmented label="Editor mode" options={editorModes} bind:value={editorMode} class="jr-mode" />
					</div>
					<input bind:this={fileInput} type="file" accept="image/*" multiple on:change={handleImageUpload} hidden />
					<input bind:this={codeInput} type="file" accept=".txt,.md,.js,.ts,.json,.py,.rs,.sh,.css,.html,.yaml,.yml,.toml,.sql,.c,.cpp,.h,.go,.java,.xml,.csv" on:change={importCode} hidden />

					{#if attachmentError}
						<div class="w-notice jr-notice" role="alert">
							<Icon name="alert" size={16} />
							<div class="w-notice__text"><p class="w-notice__title">{attachmentError}</p><p>The entry is unchanged.</p></div>
						</div>
					{/if}

					{#if editorMode === 'preview'}
						<div class="w-prose jr-prose jr-preview" aria-label="Preview">
							{#if formContent.trim()}
								{@html parseMessage(formContent, [], { allowTables: true })}
							{:else}
								<p class="jr-preview__empty">Nothing written yet.</p>
							{/if}
						</div>
					{/if}
					<textarea
						class="jr-text"
						bind:this={contentEditor}
						use:autogrow={formContent}
						aria-label={`Journal entry for ${kickerDate.format(selectedDate)}`}
						on:paste={pasteImages}
						hidden={editorMode === 'preview'}
						bind:value={formContent}
						placeholder="What happened today? Notes, lists, links and pasted pictures all work."
						rows="10"
					></textarea>

					{#if formImages.length > 0}
						<div class="jr-gallery jr-gallery--edit">
							{#each formImages as image, i}
								<figure class="jr-thumb">
									<img src={image} alt={`Picture ${i + 1}`} />
									<button type="button" class="w-ibtn w-ibtn--sm jr-thumb__remove" on:click={() => removeImage(i)} aria-label={`Remove picture ${i + 1}`}><Icon name="x" size={14} /></button>
								</figure>
							{/each}
						</div>
					{/if}

					<div class="jr-fields">
						<div class="jr-field">
							<label class="w-label" for={`journal-${uid}-tags`}>Tags</label>
							<!-- Enter here only ends a tag list; it never saves and closes the editor. -->
							<input id={`journal-${uid}-tags`} class="w-field" type="text" bind:value={formTags} placeholder="Separate tags with commas" enterkeyhint="done" on:keydown={keepEditingOnEnter} />
						</div>
						<div class="w-srow jr-srow">
							<div class="w-srow__text">
								<span class="w-srow__label" id={`journal-${uid}-personal`}>Personal entry</span>
								<span class="w-srow__hint" id={`journal-${uid}-personal-hint`}>A marker for you. It does not change who can read this entry.</span>
							</div>
							<Switch labelledby={`journal-${uid}-personal`} describedby={`journal-${uid}-personal-hint`} bind:checked={formIsPrivate} />
						</div>
						<div class="jr-names-row">
							<SignatureRow bind:draftSignatures {legacySignedBy} label="Names attached" />
						</div>
					</div>

					<div class="jr-actions">
						<button type="button" class="w-btn w-btn--quiet" on:click={cancelEditing}>Cancel</button>
						<button type="submit" class="w-btn w-btn--primary" disabled={!canSave}>{currentEntry ? 'Save changes' : 'Save entry'}</button>
					</div>
				</form>
			{:else if currentEntry}
				<article class="jr-entry jr-entry--page">
					{#if currentEntry.content.trim()}
						<div class="w-prose jr-prose">{@html parseMessage(currentEntry.content, [], { allowTables: true })}</div>
					{/if}
					{#if currentEntry.images?.length}
						<div class="jr-gallery jr-gallery--page">
							{#each currentEntry.images as image, i}
								<button type="button" class="jr-thumb" on:click={() => (viewingImage = image)} aria-label={`View picture ${i + 1} of ${currentEntry.images.length}`}>
									<img src={image} alt="" />
								</button>
							{/each}
						</div>
					{/if}
					{@render entryFooter(currentEntry)}
					{#if !isReadOnly}
						<div class="jr-actions jr-actions--page">
							<button type="button" class="w-btn" on:click={startEditing}><Icon name="pencil" size={16} />Edit entry</button>
							<button type="button" class="w-btn w-btn--danger" on:click={handleDelete}>Delete entry</button>
						</div>
					{/if}
				</article>
			{:else if embedded && !onToday && !isReadOnly}
				<!-- A past day in My Planner: the masthead's ink New entry stays the view's one primary
				     (it writes today), so this day's own action is a default button (§7.1). -->
				<EmptyState icon="book" as="h3" title={`Nothing written for ${kickerDate.format(selectedDate)}`} text="Write a few lines while the day is fresh." class="jr-empty">
					{#snippet actions()}
						<button type="button" class="w-btn" on:click={startEditing}>Write this entry</button>
					{/snippet}
				</EmptyState>
			{:else}
				<EmptyState
					icon="book"
					as="h3"
					title={`Nothing written for ${onToday ? 'today' : kickerDate.format(selectedDate)}`}
					text={embedded && onToday && !isReadOnly
						? `Use ${newEntryWords} to write a few lines while the day is fresh.`
						: 'Write a few lines while the day is fresh.'}
					action={isReadOnly || (embedded && onToday) ? undefined : 'Write this entry'}
					onaction={startEditing}
					class="jr-empty"
				/>
			{/if}
		</div>
	{/if}
</div>

<ImageViewer src={viewingImage || ''} alt="Journal picture" onClose={() => (viewingImage = null)} />
