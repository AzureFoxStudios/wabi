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
		{ value: 'emoji', label: 'Emoji' },
		{ value: 'sticker', label: 'Sticker' }
	];
	$: communityName = $currentSavedServer?.effectiveName?.trim() || 'this server';
	$: folderOptions = [{ value: 'all', label: 'All folders' }, ...existingFolders.map((folder) => ({ value: folder, label: folder }))];

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
		if (!SUPPORTED_IMAGE_TYPES.has(file.type)) return 'Please select a PNG, GIF, JPG, or WebP image.';
		if (file.size > 2 * 1024 * 1024) return `"${file.name}" is too large. Maximum size is 2MB.`;
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
			singleNote = { text: 'Choose an image and give it a shortcode first.', error: true };
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
			singleNote = { text: `Added ${uploadedType === 'sticker' ? 'sticker' : 'emoji'} “${result.emoji.displayName || result.emoji.name}” to ${normalizeFolder(emojiFolder)}.`, error: false };
		} catch (error) {
			console.error('Emoji upload error:', error);
			singleNote = { text: emojiUploadFailureMessage(error), error: true };
		} finally {
			uploadingEmoji = false;
		}
	}

	async function deleteEmoji(target: Emoji) {
		const kind = target.type === 'sticker' ? 'sticker' : 'emoji';
		const confirmed = await confirmAction({
			title: `Delete :${target.name}:?`,
			body: `Members of ${communityName} can no longer use this ${kind}. Messages that used it show its shortcode.`,
			confirm: `Delete ${kind}`,
			danger: true
		});
		if (!confirmed) return;
		const sock = getSocket();
		if (!sock) {
			libraryNote = { text: `Not connected, so :${target.name}: was not deleted.`, error: true };
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
			bulkNote = { text: 'None of those files is a PNG, GIF, JPG or WebP image.', error: true };
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
			bulkNote = { text: 'Choose some images first.', error: true };
			return;
		}
		if (bulkEmojiFiles.some((item) => !item.name.trim())) {
			bulkNote = { text: 'Give every image a shortcode before adding them.', error: true };
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
				? { text: `Added ${successCount} to ${normalizeFolder(bulkEmojiFolder)}.`, error: false }
				: {
					text: `Added ${successCount} of ${successCount + failCount} to ${normalizeFolder(bulkEmojiFolder)}. The rest stay below so you can fix them and try again.`,
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
		<h3 class="settings-block__title" id="emoji-add-title">Custom emojis</h3>
		<p class="settings-block__hint">Add one at a time with its shortcode, name, credit and folder.</p>
		<input type="file" bind:this={emojiFileInput} on:change={handleEmojiFileSelect} accept="image/png,image/gif,image/jpeg,image/webp" class="hidden-file-input" tabindex="-1" aria-hidden="true" />
		<div class="emoji-single">
			<button type="button" class="emoji-drop" on:click={() => emojiFileInput?.click()} aria-label={emojiPreview ? 'Change image' : 'Choose image'}>
				{#if emojiPreview}<img src={emojiPreview} alt="" />{:else}<Icon name="image" size={28} />{/if}
				<span class="emoji-drop__label">{emojiPreview ? 'Change image' : 'Choose image'}</span>
				<span class="emoji-drop__hint">PNG, GIF, JPG or WebP, up to 2 MB</span>
			</button>
			<div class="emoji-fields">
				<label class="emoji-field"><span class="w-label">Shortcode</span><input class="w-field" type="text" bind:value={emojiName} placeholder="tabi_wave" maxlength="30" /></label>
				<label class="emoji-field"><span class="w-label">Name</span><input class="w-field" type="text" bind:value={emojiDisplayName} placeholder="Tabi wave" maxlength="60" /></label>
				<label class="emoji-field"><span class="w-label">Artist</span><input class="w-field" type="text" bind:value={emojiArtist} placeholder="Optional credit" maxlength="60" /></label>
				<label class="emoji-field"><span class="w-label">Folder</span><input class="w-field" type="text" list="emoji-folder-options" bind:value={emojiFolder} placeholder="Reactions" maxlength="48" /></label>
				<div class="emoji-field"><span class="w-label" id="emoji-single-type">Kind</span><Segmented labelledby="emoji-single-type" options={TYPE_OPTIONS} value={emojiType} onchange={(value) => (emojiType = value === 'sticker' ? 'sticker' : 'emoji')} /></div>
			</div>
		</div>
		<div class="emoji-actions">
			{#if singleNote}<p class="emoji-note" class:is-error={singleNote.error} role={singleNote.error ? 'alert' : 'status'}>{#if singleNote.error}<Icon name="alert" size={14} />{/if}{singleNote.text}</p>{/if}
			<button type="button" class="w-btn w-btn--primary" on:click={uploadEmoji} disabled={uploadingEmoji || !selectedEmojiFile || !emojiName.trim()} aria-busy={uploadingEmoji}>
				{uploadingEmoji ? 'Adding…' : `Add ${emojiType === 'sticker' ? 'sticker' : 'emoji'}`}
			</button>
		</div>
	</section>

	<section class="settings-block" aria-labelledby="emoji-bulk-title">
		<h3 class="settings-block__title" id="emoji-bulk-title">Add several at once</h3>
		<p class="settings-block__hint">File names become shortcodes. Check them before adding.</p>
		<input type="file" bind:this={bulkEmojiFileInput} on:change={handleBulkEmojiFileSelect} accept="image/png,image/gif,image/jpeg,image/webp" multiple class="hidden-file-input" tabindex="-1" aria-hidden="true" />
		<div class="emoji-bulk-bar">
			<button type="button" class="w-btn" on:click={() => bulkEmojiFileInput?.click()}><Icon name="upload" size={16} />Choose images…</button>
			<label class="emoji-field"><span class="w-label">Folder</span><input class="w-field" type="text" list="emoji-folder-options" bind:value={bulkEmojiFolder} placeholder="Reactions" maxlength="48" /></label>
			<label class="emoji-field"><span class="w-label">Artist</span><input class="w-field" type="text" bind:value={bulkEmojiArtist} placeholder="Optional credit" maxlength="60" /></label>
			<div class="emoji-field"><span class="w-label" id="emoji-bulk-type">Kind</span><Segmented labelledby="emoji-bulk-type" options={TYPE_OPTIONS} value={bulkEmojiType} onchange={(value) => (bulkEmojiType = value === 'sticker' ? 'sticker' : 'emoji')} /></div>
		</div>

		{#if bulkEmojiFiles.length > 0}
			<ul class="emoji-sheet" aria-label="Images to add">
				{#each bulkEmojiFiles as item, index (item.preview ?? index)}
					<li class="emoji-sheet__item">
						<img src={item.preview} alt="" />
						<label class="emoji-field"><span class="w-label">Shortcode</span><input class="w-field" type="text" bind:value={item.name} placeholder="emoji_name" maxlength="30" /></label>
						<label class="emoji-field"><span class="w-label">Name</span><input class="w-field" type="text" bind:value={item.displayName} placeholder="Display name" maxlength="60" /></label>
						<button type="button" class="w-ibtn w-ibtn--sm emoji-sheet__remove" on:click={() => removeBulkEmoji(index)} aria-label={`Leave out ${item.displayName || item.name}`}><Icon name="x" /></button>
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
					{uploadingBulk ? 'Adding…' : `Add ${bulkEmojiFiles.length} ${bulkEmojiType === 'sticker' ? (bulkEmojiFiles.length === 1 ? 'sticker' : 'stickers') : 'emoji'}`}
				</button>
			{/if}
		</div>
	</section>

	<section class="settings-block" aria-labelledby="emoji-library-title">
		<h3 class="settings-block__title" id="emoji-library-title">Library</h3>
		<p class="settings-block__hint">What every member sees in the picker, grouped by folder. Other servers keep their own.</p>
		<div class="emoji-filters">
			<Select ariaLabel="Folder" label="Folder" options={folderOptions} value={libraryFolder} applied={libraryFolder !== 'all'} onchange={(value) => (libraryFolder = value)} />
			<Segmented label="Kind" options={[{ value: 'all', label: 'All' }, { value: 'emoji', label: 'Emoji' }, { value: 'sticker', label: 'Stickers' }]} value={libraryType} onchange={(value) => (libraryType = value === 'emoji' || value === 'sticker' ? value : 'all')} />
			<span class="w-count emoji-filters__count">{filteredCustomEntries.length === customEntries.length ? `${customEntries.length} in the library` : `${filteredCustomEntries.length} of ${customEntries.length} shown`}</span>
		</div>
		{#if libraryNote}<p class="emoji-note" class:is-error={libraryNote.error} role={libraryNote.error ? 'alert' : 'status'}>{libraryNote.text}</p>{/if}

		{#if groupedEntries.length === 0}
			<div class="emoji-empty">
				<Icon name="smile" size={28} />
				<p class="emoji-empty__title">{customEntries.length === 0 ? 'No custom emoji yet' : 'Nothing in this folder'}</p>
				<p class="emoji-empty__text">{customEntries.length === 0 ? 'Add one above and every member can use it.' : 'Choose another folder or kind.'}</p>
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
									<span class="emoji-item__meta">{labelFor(emoji)} · {(emoji.type || 'emoji') === 'sticker' ? 'Sticker' : 'Emoji'}{#if emoji.artist} · by {emoji.artist}{/if}</span>
								</span>
								<button type="button" class="w-ibtn w-ibtn--sm emoji-item__delete" on:click={() => deleteEmoji(emoji)} aria-label={`Delete :${emoji.name}:`}><Icon name="trash" /></button>
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
