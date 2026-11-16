<script lang="ts">
	import { get } from 'svelte/store';
	import { _ as t } from '$lib/i18n';
	import { emojis, getSocket, connected } from '$lib/socket';
	import { getWabiDB } from '$lib/wabidb';
	import { getServerUrl } from '$lib/serverUrl';
	import { getAuthToken } from '$lib/authSession';
	import type { Emoji } from '$lib/socket-types';
	import { emojiUploadError, emojiUploadFailureMessage } from '$lib/emojiUploadErrors';
	import { confirmAction } from '$lib/confirm';
	import { currentSavedServer } from '$lib/savedServers';
	import Icon from '../ui/Icon.svelte';
	import Select from '../ui/Select.svelte';
	import Segmented from '../ui/Segmented.svelte';

	/** Feedback where each action happened (§7.16), never a browser alert. */
	type Note = { text: string; error: boolean; lines?: string[] } | null;
	let singleNote: Note = null;
	let bulkNote: Note = null;
	let libraryNote: Note = null;
	const TYPE_OPTIONS = [
		{ value: 'emoji', label: $t('emoji_tab.type_emoji') },
		{ value: 'sticker', label: $t('emoji_tab.type_sticker') }
	];
	$: communityName = $currentSavedServer?.effectiveName?.trim() || $t('emoji_tab.this_server');
	$: folderOptions = [{ value: 'all', label: $t('emoji_tab.all_folders') }, ...existingFolders.map((folder) => ({ value: folder, label: folder }))];

	let emojiFileInput: HTMLInputElement;
	let emojiName = '';
	let emojiDisplayName = '';
	let emojiArtist = '';
	let emojiFolder = 'General';
	let emojiType: 'emoji' | 'sticker' = 'emoji';
	let selectedEmojiFile: File | null = null;
	let emojiPreview: string | null = null;
	let uploadingEmoji = false;

	let bulkEmojiFileInput: HTMLInputElement;
	let bulkEmojiArtist = '';
	let bulkEmojiFolder = 'General';
	let bulkEmojiType: 'emoji' | 'sticker' = 'emoji';
	let bulkEmojiFiles: { file: File; name: string; displayName: string; preview: string }[] = [];
	let uploadingBulk = false;

	let libraryFolder = 'all';
	let libraryType: 'all' | 'emoji' | 'sticker' = 'all';

	$: customEntries = $emojis.filter((entry) => entry.isCustom);
	$: existingFolders = [...new Set(customEntries.map((entry) => normalizeFolder(entry.category)))].sort((a, b) => a.localeCompare(b));
	$: filteredCustomEntries = customEntries
		.filter((entry) => libraryType === 'all' || (entry.type || 'emoji') === libraryType)
		.filter((entry) => libraryFolder === 'all' || normalizeFolder(entry.category) === libraryFolder)
		.sort((a, b) => {
			const folderDelta = normalizeFolder(a.category).localeCompare(normalizeFolder(b.category));
			if (folderDelta !== 0) return folderDelta;
			return labelFor(a).localeCompare(labelFor(b));
		});
	$: groupedEntries = groupByFolder(filteredCustomEntries);

	function normalizeFolder(value?: string): string {
		return value?.trim() || 'General';
	}

	function labelFor(entry: Emoji): string {
		return entry.displayName?.trim() || entry.name.replace(/[_-]+/g, ' ');
	}

	function groupByFolder(entries: Emoji[]): Array<{ folder: string; entries: Emoji[] }> {
		const groups = new Map<string, Emoji[]>();
		for (const entry of entries) {
			const folder = normalizeFolder(entry.category);
			const values = groups.get(folder) || [];
			values.push(entry);
			groups.set(folder, values);
		}
		return [...groups.entries()].map(([folder, values]) => ({ folder, entries: values }));
	}

	function authHeaders(): HeadersInit {
		const authToken = getAuthToken();
		return authToken ? { Authorization: `Bearer ${authToken}` } : {};
	}

	const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/gif', 'image/jpeg', 'image/webp']);

	function validateImage(file: File): string | null {
		if (!SUPPORTED_IMAGE_TYPES.has(file.type)) return $t('emoji_tab.bad_type');
		if (file.size > 2 * 1024 * 1024) return $t('emoji_tab.too_large', { values: { name: file.name } });
		return null;
	}

	async function filePreview(file: File): Promise<string> {
		return await new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = (event) => resolve(event.target?.result as string);
			reader.onerror = () => reject(reader.error);
			reader.readAsDataURL(file);
		});
	}

	function filenameToShortcode(filename: string): string {
		return filename
			.replace(/\.[^/.]+$/, '')
			.toLowerCase()
			.replace(/[^a-z0-9_]/g, '_')
			.replace(/_+/g, '_')
			.replace(/^_|_$/g, '');
	}

	function filenameToDisplayName(filename: string): string {
		return filename.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
	}

	async function handleEmojiFileSelect(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		const error = validateImage(file);
		singleNote = null;
		if (error) {
			singleNote = { text: error, error: true };
			input.value = '';
			return;
		}
		selectedEmojiFile = file;
		emojiPreview = await filePreview(file);
		if (!emojiName.trim()) emojiName = filenameToShortcode(file.name);
		if (!emojiDisplayName.trim()) emojiDisplayName = filenameToDisplayName(file.name);
	}

	async function uploadEmoji() {
		if (!selectedEmojiFile || !emojiName.trim()) {
			singleNote = { text: $t('emoji_tab.need_shortcode'), error: true };
			return;
		}
		singleNote = null;

		uploadingEmoji = true;
		try {
			const formData = new FormData();
			formData.append('file', selectedEmojiFile);
			formData.append('name', emojiName.trim());
			formData.append('displayName', emojiDisplayName.trim());
			formData.append('artist', emojiArtist.trim());
			formData.append('category', normalizeFolder(emojiFolder));
			formData.append('type', emojiType);

			const response = await fetch(`${getServerUrl()}/api/emoji/upload`, {
				method: 'POST',
				headers: authHeaders(),
				body: formData
			});
			if (!response.ok) throw new Error(await emojiUploadError(response));

			const result = await response.json();
			const uploadedType = emojiType;
			emojiName = '';
			emojiDisplayName = '';
			emojiArtist = '';
			selectedEmojiFile = null;
			emojiPreview = null;
			if (emojiFileInput) emojiFileInput.value = '';
			singleNote = { text: $t('emoji_tab.added_single', { values: { kind: uploadedType === 'sticker' ? $t('emoji_tab.kind_sticker') : $t('emoji_tab.kind_emoji'), name: result.emoji.displayName || result.emoji.name, folder: normalizeFolder(emojiFolder) } }), error: false };
		} catch (error) {
			console.error('Emoji upload error:', error);
			singleNote = { text: emojiUploadFailureMessage(error), error: true };
		} finally {
			uploadingEmoji = false;
		}
	}

	async function deleteEmoji(target: Emoji) {
		const kind = target.type === 'sticker' ? $t('emoji_tab.kind_sticker') : $t('emoji_tab.kind_emoji');
		const confirmed = await confirmAction({
			title: $t('emoji_tab.delete_title', { values: { name: target.name } }),
			body: $t('emoji_tab.delete_body', { values: { community: communityName, kind } }),
			confirm: $t('emoji_tab.delete_btn', { values: { kind } }),
			danger: true
		});
		if (!confirmed) return;
		const sock = getSocket();
		if (!sock) {
			libraryNote = { text: $t('emoji_tab.not_connected', { values: { name: target.name } }), error: true };
			return;
		}
		const db = getWabiDB();
		const online = get(connected);
		if (db && !online) {
			await db.enqueue({ scopeId: 'corechat', type: 'delete-emoji', payload: target.name });
			return;
		}
		sock.emit('delete-emoji', target.name);
	}

	async function handleBulkEmojiFileSelect(event: Event) {
		const input = event.target as HTMLInputElement;
		const files = Array.from(input.files || []);
		if (files.length === 0) return;

		const imageFiles = files.filter((file) => SUPPORTED_IMAGE_TYPES.has(file.type));
		bulkNote = null;
		if (imageFiles.length === 0) {
			bulkNote = { text: $t('emoji_tab.none_image'), error: true };
			return;
		}

		for (const file of imageFiles) {
			const error = validateImage(file);
			if (error) {
				bulkNote = { text: error, error: true };
				return;
			}
		}

		bulkEmojiFiles = await Promise.all(imageFiles.map(async (file) => ({
			file,
			name: filenameToShortcode(file.name),
			displayName: filenameToDisplayName(file.name),
			preview: await filePreview(file)
		})));
	}

	async function uploadBulkEmojis() {
		if (bulkEmojiFiles.length === 0) {
			bulkNote = { text: $t('emoji_tab.choose_some'), error: true };
			return;
		}
		if (bulkEmojiFiles.some((item) => !item.name.trim())) {
			bulkNote = { text: $t('emoji_tab.give_codes'), error: true };
			return;
		}
		bulkNote = null;

		uploadingBulk = true;
		let successCount = 0;
		let failCount = 0;
		const failedItems: typeof bulkEmojiFiles = [];
		const failures: string[] = [];
		try {
			for (const item of bulkEmojiFiles) {
				try {
					const formData = new FormData();
					formData.append('file', item.file);
					formData.append('name', item.name.trim());
					formData.append('displayName', item.displayName.trim());
					formData.append('artist', bulkEmojiArtist.trim());
					formData.append('category', normalizeFolder(bulkEmojiFolder));
					formData.append('type', bulkEmojiType);

					const response = await fetch(`${getServerUrl()}/api/emoji/upload`, {
						method: 'POST',
						headers: authHeaders(),
						body: formData
					});
					if (!response.ok) {
						failCount++;
						failedItems.push(item);
						failures.push(`:${item.name}: ${await emojiUploadError(response)}`);
						continue;
					}
					successCount++;
				} catch (error) {
					console.error(`Error uploading ${item.name}:`, error);
					failCount++;
					failedItems.push(item);
					failures.push(`:${item.name}: ${emojiUploadFailureMessage(error)}`);
				}
			}

			bulkEmojiFiles = failedItems;
			if (failCount === 0) {
				bulkEmojiArtist = '';
				if (bulkEmojiFileInput) bulkEmojiFileInput.value = '';
			}
			bulkNote = failCount === 0
				? { text: $t('emoji_tab.added_bulk', { values: { count: successCount, folder: normalizeFolder(bulkEmojiFolder) } }), error: false }
				: {
					text: $t('emoji_tab.added_partial', { values: { count: successCount, total: successCount + failCount, folder: normalizeFolder(bulkEmojiFolder) } }),
					error: true,
					lines: failures
				};
		} catch (error) {
			console.error('Bulk upload error:', error);
			bulkNote = { text: emojiUploadFailureMessage(error), error: true };
		} finally {
			uploadingBulk = false;
		}
	}

	function removeBulkEmoji(index: number) {
		bulkEmojiFiles = bulkEmojiFiles.filter((_, itemIndex) => itemIndex !== index);
	}
</script>

<div class="emoji-tab">
	<datalist id="emoji-folder-options">
		{#each existingFolders as folder}<option value={folder}></option>{/each}
		<option value="General"></option>
		<option value="Reactions"></option>
		<option value="Characters"></option>
		<option value="Memes"></option>
		<option value="Seasonal"></option>
	</datalist>

	<section class="settings-block" aria-labelledby="emoji-add-title">
		<h3 class="settings-block__title" id="emoji-add-title">{$t('emoji_tab.custom_title')}</h3>
		<p class="settings-block__hint">{$t('emoji_tab.add_hint')}</p>
		<input type="file" bind:this={emojiFileInput} on:change={handleEmojiFileSelect} accept="image/png,image/gif,image/jpeg,image/webp" class="hidden-file-input" tabindex="-1" aria-hidden="true" />
		<div class="emoji-single">
			<button type="button" class="emoji-drop" on:click={() => emojiFileInput?.click()} aria-label={emojiPreview ? $t('emoji_tab.change_image') : $t('emoji_tab.choose_image')}>
				{#if emojiPreview}<img src={emojiPreview} alt="" />{:else}<Icon name="image" size={28} />{/if}
				<span class="emoji-drop__label">{emojiPreview ? $t('emoji_tab.change_image') : $t('emoji_tab.choose_image')}</span>
				<span class="emoji-drop__hint">{$t('emoji_tab.drop_hint')}</span>
			</button>
			<div class="emoji-fields">
				<label class="emoji-field"><span class="w-label">{$t('emoji_tab.shortcode')}</span><input class="w-field" type="text" bind:value={emojiName} placeholder="tabi_wave" maxlength="30" /></label>
				<label class="emoji-field"><span class="w-label">{$t('emoji_tab.name')}</span><input class="w-field" type="text" bind:value={emojiDisplayName} placeholder={$t('emoji_tab.tabi_name')} maxlength="60" /></label>
				<label class="emoji-field"><span class="w-label">{$t('emoji_tab.artist')}</span><input class="w-field" type="text" bind:value={emojiArtist} placeholder={$t('emoji_tab.optional_credit')} maxlength="60" /></label>
				<label class="emoji-field"><span class="w-label">{$t('emoji_tab.folder')}</span><input class="w-field" type="text" list="emoji-folder-options" bind:value={emojiFolder} placeholder="Reactions" maxlength="48" /></label>
				<div class="emoji-field"><span class="w-label" id="emoji-single-type">{$t('emoji_tab.kind')}</span><Segmented labelledby="emoji-single-type" options={TYPE_OPTIONS} value={emojiType} onchange={(value) => (emojiType = value === 'sticker' ? 'sticker' : 'emoji')} /></div>
			</div>
		</div>
		<div class="emoji-actions">
			{#if singleNote}<p class="emoji-note" class:is-error={singleNote.error} role={singleNote.error ? 'alert' : 'status'}>{#if singleNote.error}<Icon name="alert" size={14} />{/if}{singleNote.text}</p>{/if}
			<!-- One primary per view (§2.4): once several images are chosen, their Add is the primary. -->
			<button type="button" class="w-btn" class:w-btn--primary={bulkEmojiFiles.length === 0} on:click={uploadEmoji} disabled={uploadingEmoji || !selectedEmojiFile || !emojiName.trim()} aria-busy={uploadingEmoji}>
				{uploadingEmoji ? $t('emoji_tab.adding') : $t('emoji_tab.add_kind', { values: { kind: emojiType === 'sticker' ? $t('emoji_tab.kind_sticker') : $t('emoji_tab.kind_emoji') } })}
			</button>
		</div>
	</section>

	<section class="settings-block" aria-labelledby="emoji-bulk-title">
		<h3 class="settings-block__title" id="emoji-bulk-title">{$t('emoji_tab.bulk_title')}</h3>
		<p class="settings-block__hint">{$t('emoji_tab.bulk_hint')}</p>
		<input type="file" bind:this={bulkEmojiFileInput} on:change={handleBulkEmojiFileSelect} accept="image/png,image/gif,image/jpeg,image/webp" multiple class="hidden-file-input" tabindex="-1" aria-hidden="true" />
		<div class="emoji-bulk-bar">
			<span class="emoji-bulk-bar__pick"><button type="button" class="w-btn" on:click={() => bulkEmojiFileInput?.click()}><Icon name="upload" size={16} />{$t('emoji_tab.choose_images')}</button></span>
			<label class="emoji-field"><span class="w-label">{$t('emoji_tab.folder')}</span><input class="w-field" type="text" list="emoji-folder-options" bind:value={bulkEmojiFolder} placeholder="Reactions" maxlength="48" /></label>
			<label class="emoji-field"><span class="w-label">{$t('emoji_tab.artist')}</span><input class="w-field" type="text" bind:value={bulkEmojiArtist} placeholder={$t('emoji_tab.optional_credit')} maxlength="60" /></label>
			<div class="emoji-field"><span class="w-label" id="emoji-bulk-type">{$t('emoji_tab.kind')}</span><span class="emoji-field__seg"><Segmented labelledby="emoji-bulk-type" options={TYPE_OPTIONS} value={bulkEmojiType} onchange={(value) => (bulkEmojiType = value === 'sticker' ? 'sticker' : 'emoji')} /></span></div>
		</div>

		{#if bulkEmojiFiles.length > 0}
			<ul class="emoji-sheet" aria-label={$t('emoji_tab.images_to_add')}>
				{#each bulkEmojiFiles as item, index (item.preview ?? index)}
					<li class="emoji-sheet__item">
						<img src={item.preview} alt="" />
						<label class="emoji-field"><span class="w-label">{$t('emoji_tab.shortcode')}</span><input class="w-field" type="text" bind:value={item.name} placeholder="emoji_name" maxlength="30" /></label>
						<label class="emoji-field"><span class="w-label">{$t('emoji_tab.name')}</span><input class="w-field" type="text" bind:value={item.displayName} placeholder={$t('emoji_tab.display_name')} maxlength="60" /></label>
						<button type="button" class="w-ibtn w-ibtn--sm emoji-sheet__remove" on:click={() => removeBulkEmoji(index)} aria-label={$t('emoji_tab.leave_out', { values: { name: item.displayName || item.name } })}><Icon name="x" /></button>
					</li>
				{/each}
			</ul>
		{/if}
		<div class="emoji-actions">
			{#if bulkNote}
				<div class="emoji-note" class:is-error={bulkNote.error} role={bulkNote.error ? 'alert' : 'status'}>
					{#if bulkNote.error}<Icon name="alert" size={14} />{/if}
					<span>{bulkNote.text}{#if bulkNote.lines?.length}<span class="emoji-note__lines">{#each bulkNote.lines as line}<span>{line}</span>{/each}</span>{/if}</span>
				</div>
			{/if}
			{#if bulkEmojiFiles.length > 0}
				<button type="button" class="w-btn w-btn--primary" on:click={uploadBulkEmojis} disabled={uploadingBulk} aria-busy={uploadingBulk}>
					{uploadingBulk ? $t('emoji_tab.adding') : $t('emoji_tab.add_count', { values: { count: bulkEmojiFiles.length, kind: bulkEmojiType === 'sticker' ? (bulkEmojiFiles.length === 1 ? $t('emoji_tab.kind_sticker') : $t('emoji_tab.kind_stickers')) : $t('emoji_tab.kind_emoji') } })}
				</button>
			{/if}
		</div>
	</section>

	<section class="settings-block" aria-labelledby="emoji-library-title">
		<h3 class="settings-block__title" id="emoji-library-title">{$t('emoji_tab.library_title')}</h3>
		<p class="settings-block__hint">{$t('emoji_tab.library_hint')}</p>
		<div class="emoji-filters">
			<Select ariaLabel={$t('emoji_tab.folder')} label={$t('emoji_tab.folder')} options={folderOptions} value={libraryFolder} applied={libraryFolder !== 'all'} onchange={(value) => (libraryFolder = value)} />
			<Segmented label={$t('emoji_tab.kind')} options={[{ value: 'all', label: $t('emoji_tab.all') }, { value: 'emoji', label: $t('emoji_tab.type_emoji') }, { value: 'sticker', label: $t('emoji_tab.sticker_plural') }]} value={libraryType} onchange={(value) => (libraryType = value === 'emoji' || value === 'sticker' ? value : 'all')} />
			<span class="w-count emoji-filters__count">{filteredCustomEntries.length === customEntries.length ? $t('emoji_tab.in_library', { values: { count: customEntries.length } }) : $t('emoji_tab.shown', { values: { shown: filteredCustomEntries.length, total: customEntries.length } })}</span>
		</div>
		{#if libraryNote}<p class="emoji-note" class:is-error={libraryNote.error} role={libraryNote.error ? 'alert' : 'status'}>{libraryNote.text}</p>{/if}

		{#if groupedEntries.length === 0}
			<div class="emoji-empty">
				<Icon name="smile" size={28} />
				<p class="emoji-empty__title">{customEntries.length === 0 ? $t('emoji_tab.no_custom') : $t('emoji_tab.nothing_folder')}</p>
				<p class="emoji-empty__text">{customEntries.length === 0 ? $t('emoji_tab.add_above') : $t('emoji_tab.choose_other')}</p>
			</div>
		{:else}
			{#each groupedEntries as group (group.folder)}
				<div class="emoji-folder">
					<p class="w-kicker emoji-folder__title">{group.folder}<span class="w-count">{group.entries.length}</span></p>
					<ul class="emoji-grid">
						{#each group.entries as emoji (emoji.id)}
							<li class="emoji-item">
								<img src={emoji.url} alt="" class="emoji-item__img" />
								<span class="emoji-item__text">
									<span class="emoji-item__code">:{emoji.name}:</span>
									<span class="emoji-item__meta">{labelFor(emoji)} · {(emoji.type || 'emoji') === 'sticker' ? 'Sticker' : 'Emoji'}{#if emoji.artist} · {$t('emoji_tab.by', { values: { artist: emoji.artist } })}{/if}</span>
								</span>
								<button type="button" class="w-ibtn w-ibtn--sm emoji-item__delete" on:click={() => deleteEmoji(emoji)} aria-label={$t('emoji_tab.delete_label', { values: { name: emoji.name } })}><Icon name="trash" /></button>
							</li>
						{/each}
					</ul>
				</div>
			{/each}
		{/if}
	</section>
</div>

<style>
	.emoji-tab {
		display: flex;
		flex-direction: column;
		gap: 32px;
	}
	.emoji-tab > :global(.settings-block) {
		margin-block: 0;
	}
	.emoji-single {
		display: grid;
		grid-template-columns: 160px minmax(0, 1fr);
		gap: 16px;
		margin-top: 14px;
	}
	.emoji-drop {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 6px;
		min-height: 168px;
		padding: 12px;
		border: var(--w-bw) dashed var(--w-line-strong);
		border-radius: var(--radius-md);
		background: var(--w-sink);
		color: var(--w-faint);
		cursor: pointer;
		transition: background-color var(--w-dur-1) var(--w-ease), border-color var(--w-dur-1) var(--w-ease);
	}
	.emoji-drop:hover {
		border-color: var(--w-accent);
		background: color-mix(in srgb, var(--w-raise) 70%, var(--w-sink));
	}
	.emoji-drop img {
		max-width: 104px;
		max-height: 104px;
		object-fit: contain;
	}
	.emoji-drop__label {
		color: var(--w-text);
		font: var(--w-t-label);
	}
	.emoji-drop__hint {
		color: var(--w-faint);
		font: var(--w-t-caption);
		text-align: center;
	}
	.emoji-fields {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px 16px;
		align-content: start;
	}
	.emoji-field {
		display: grid;
		align-content: start;
		justify-items: start;
		min-width: 0;
	}
	.emoji-field > .w-field {
		width: 100%;
		box-sizing: border-box;
	}
	.emoji-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: 8px 16px;
		margin-top: 14px;
	}
	.emoji-note {
		display: flex;
		flex: 1 1 260px;
		align-items: flex-start;
		gap: 6px;
		margin: 0;
		color: var(--w-mute);
		font: var(--w-t-small);
	}
	.emoji-note.is-error {
		color: var(--w-danger);
	}
	.emoji-note :global(svg) {
		flex: none;
		margin-top: 2px;
	}
	.emoji-note__lines {
		display: grid;
		gap: 2px;
		margin-top: 4px;
		color: var(--w-mute);
		font: var(--w-t-mono);
	}
	.emoji-bulk-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: 12px;
		margin-top: 14px;
	}
	.emoji-bulk-bar > .emoji-field {
		flex: 1 1 160px;
	}
	.emoji-bulk-bar > .emoji-field:last-child {
		flex: 0 0 auto;
	}
	/* The button and the segment sit on the 38px field line, so every label and control in the
	   bar shares one top and one centre. */
	.emoji-bulk-bar__pick,
	.emoji-field__seg {
		display: flex;
		align-items: center;
		min-height: 38px;
	}
	.emoji-sheet {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
		gap: 12px;
		margin: 16px 0 0;
		padding: 0;
		list-style: none;
	}
	.emoji-sheet__item {
		position: relative;
		display: grid;
		gap: 8px;
		padding: 12px;
		border: var(--w-bw) solid var(--w-line);
		border-radius: var(--radius-md);
		background: var(--w-lift);
		box-shadow: var(--w-shadow-1);
	}
	.emoji-sheet__item > img {
		justify-self: center;
		width: 72px;
		height: 72px;
		object-fit: contain;
	}
	.emoji-sheet__remove {
		position: absolute;
		top: 6px;
		right: 6px;
	}
	.emoji-filters {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 12px;
		margin: 14px 0 6px;
	}
	.emoji-filters__count {
		margin-left: auto;
	}
	.emoji-folder {
		margin-top: 18px;
	}
	.emoji-folder__title {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0 0 8px;
	}
	.emoji-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		margin: 0;
		padding: 0;
		list-style: none;
		border-top: var(--w-bw) solid var(--w-line);
	}
	.emoji-item {
		display: grid;
		grid-template-columns: 32px minmax(0, 1fr) auto;
		align-items: center;
		gap: 10px;
		min-height: 52px;
		padding: 6px 4px 6px 0;
		border-bottom: var(--w-bw) solid var(--w-line);
	}
	.emoji-item__img {
		width: 32px;
		height: 32px;
		object-fit: contain;
	}
	.emoji-item__text {
		display: grid;
		min-width: 0;
	}
	.emoji-item__code {
		overflow: hidden;
		color: var(--w-text);
		font: var(--w-t-mono);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.emoji-item__meta {
		overflow: hidden;
		color: var(--w-faint);
		font: var(--w-t-caption);
		font-weight: 400;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.emoji-item__delete:hover {
		color: var(--w-danger);
	}
	.emoji-empty {
		display: grid;
		justify-items: start;
		gap: 4px;
		padding: 32px 0 8px;
		color: var(--w-faint);
	}
	.emoji-empty__title {
		margin: 8px 0 0;
		color: var(--w-text);
		font: 600 calc(20px * var(--w-fs)) / calc(26px * var(--w-fs)) var(--w-serif);
	}
	.emoji-empty__text {
		margin: 0;
		color: var(--w-mute);
		font: var(--w-t-ui);
	}
	@media (max-width: 760px) {
		.emoji-single,
		.emoji-fields {
			grid-template-columns: 1fr;
		}
		.emoji-drop {
			min-height: 128px;
		}
	}
</style>
