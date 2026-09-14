<script lang="ts">
	import { get } from 'svelte/store';
	import { _ as t } from '$lib/i18n';
	import { emojis, getSocket, connected } from '$lib/socket';
	import { getWabiDB } from '$lib/wabidb';
	import { getServerUrl } from '$lib/serverUrl';
	import { getAuthToken } from '$lib/authSession';
	import type { Emoji } from '$lib/socket-types';

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
		if (error) {
			alert(error);
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
			alert('Please select a file and enter an emoji name');
			return;
		}

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
			if (!response.ok) throw new Error('Upload failed');

			const result = await response.json();
			const uploadedType = emojiType;
			emojiName = '';
			emojiDisplayName = '';
			emojiArtist = '';
			selectedEmojiFile = null;
			emojiPreview = null;
			if (emojiFileInput) emojiFileInput.value = '';
			alert(`${uploadedType === 'sticker' ? 'Sticker' : 'Emoji'} "${result.emoji.displayName || result.emoji.name}" uploaded to ${normalizeFolder(emojiFolder)}.`);
		} catch (error) {
			console.error('Emoji upload error:', error);
			alert('Failed to upload emoji. Please try again.');
		} finally {
			uploadingEmoji = false;
		}
	}

	async function deleteEmoji(target: Emoji) {
		if (!confirm(`Delete ${target.type === 'sticker' ? 'sticker' : 'emoji'} ":${target.name}:"?`)) return;
		const sock = getSocket();
		if (!sock) return;
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
		if (imageFiles.length === 0) {
			alert('No valid image files selected');
			return;
		}

		for (const file of imageFiles) {
			const error = validateImage(file);
			if (error) {
				alert(error);
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
			alert('No files selected');
			return;
		}
		if (bulkEmojiFiles.some((item) => !item.name.trim())) {
			alert('All emojis must have a shortcode');
			return;
		}

		uploadingBulk = true;
		let successCount = 0;
		let failCount = 0;
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
						continue;
					}
					successCount++;
				} catch (error) {
					console.error(`Error uploading ${item.name}:`, error);
					failCount++;
				}
			}

			bulkEmojiFiles = [];
			bulkEmojiArtist = '';
			if (bulkEmojiFileInput) bulkEmojiFileInput.value = '';
			alert(`Upload complete to ${normalizeFolder(bulkEmojiFolder)}.\n✅ ${successCount} successful\n❌ ${failCount} failed`);
		} catch (error) {
			console.error('Bulk upload error:', error);
			alert('Failed to upload emojis. Please try again.');
		} finally {
			uploadingBulk = false;
		}
	}

	function removeBulkEmoji(index: number) {
		bulkEmojiFiles = bulkEmojiFiles.filter((_, itemIndex) => itemIndex !== index);
	}
</script>

<div class="settings-section emoji-settings-v2">
	<div class="emoji-settings-heading">
		<div>
			<h3>{$t('settings.sections.custom_emojis')}</h3>
			<p>Community emoji and stickers live in named folders. Keep everyday reactions together, character packs separate, and seasonal or meme packs out of the way.</p>
		</div>
		<div class="emoji-library-stat"><strong>{customEntries.length}</strong><span>community assets</span></div>
	</div>

	<datalist id="emoji-folder-options">
		{#each existingFolders as folder}<option value={folder}></option>{/each}
		<option value="General"></option>
		<option value="Reactions"></option>
		<option value="Characters"></option>
		<option value="Memes"></option>
		<option value="Seasonal"></option>
	</datalist>

	<section class="emoji-admin-card">
		<div class="emoji-card-heading">
			<div><span class="emoji-card-kicker">Single upload</span><h4>Add one reaction</h4></div>
			<span>Shortcode, readable name, artist, folder.</span>
		</div>

		<input type="file" bind:this={emojiFileInput} on:change={handleEmojiFileSelect} accept="image/png,image/gif,image/jpeg,image/webp" class="hidden" />

		<div class="single-upload-layout">
			<button type="button" class="asset-drop-button" on:click={() => emojiFileInput?.click()}>
				{#if emojiPreview}<img src={emojiPreview} alt="Selected emoji preview" />{:else}<span class="asset-drop-icon" aria-hidden="true">＋</span>{/if}
				<strong>{emojiPreview ? 'Change image' : 'Choose image'}</strong>
				<small>PNG · GIF · JPG · WebP · max 2MB</small>
			</button>

			<div class="emoji-form-grid">
				<label><span>Shortcode</span><input type="text" bind:value={emojiName} placeholder="tabi_wave" maxlength="30" /></label>
				<label><span>Display name</span><input type="text" bind:value={emojiDisplayName} placeholder="Tabi Wave" maxlength="60" /></label>
				<label><span>Artist / pack creator</span><input type="text" bind:value={emojiArtist} placeholder="Optional credit" maxlength="60" /></label>
				<label><span>Folder / pack</span><input type="text" list="emoji-folder-options" bind:value={emojiFolder} placeholder="Reactions" maxlength="48" /></label>
				<label><span>Asset type</span><select bind:value={emojiType}><option value="emoji">Emoji</option><option value="sticker">Sticker</option></select></label>
			</div>
		</div>

		<button class="emoji-upload-btn primary-upload" on:click={uploadEmoji} disabled={uploadingEmoji || !selectedEmojiFile || !emojiName.trim()}>
			{uploadingEmoji ? 'Uploading…' : `Add ${emojiType === 'sticker' ? 'sticker' : 'emoji'} to ${normalizeFolder(emojiFolder)}`}
		</button>
	</section>

	<section class="emoji-admin-card bulk-card">
		<div class="emoji-card-heading">
			<div><span class="emoji-card-kicker">Pack import</span><h4>Upload a batch</h4></div>
			<span>Filenames become shortcodes automatically; fix anything before importing.</span>
		</div>
		<input type="file" bind:this={bulkEmojiFileInput} on:change={handleBulkEmojiFileSelect} accept="image/png,image/gif,image/jpeg,image/webp" multiple class="hidden" />

		<div class="bulk-toolbar">
			<button class="emoji-select-btn" on:click={() => bulkEmojiFileInput?.click()}>Select images</button>
			<label><span>Folder / pack</span><input type="text" list="emoji-folder-options" bind:value={bulkEmojiFolder} placeholder="Reactions" maxlength="48" /></label>
			<label><span>Type</span><select bind:value={bulkEmojiType}><option value="emoji">Emoji</option><option value="sticker">Sticker</option></select></label>
			<label><span>Artist</span><input type="text" bind:value={bulkEmojiArtist} placeholder="Optional credit" maxlength="60" /></label>
		</div>

		{#if bulkEmojiFiles.length > 0}
			<div class="bulk-summary"><strong>{bulkEmojiFiles.length}</strong> files ready for <b>{normalizeFolder(bulkEmojiFolder)}</b></div>
			<div class="bulk-contact-sheet">
				{#each bulkEmojiFiles as item, index (item.preview ?? index)}
					<div class="bulk-asset-card">
						<div class="bulk-asset-preview"><img src={item.preview} alt="" /></div>
						<label><span>Shortcode</span><input type="text" bind:value={item.name} placeholder="emoji_name" maxlength="30" /></label>
						<label><span>Name</span><input type="text" bind:value={item.displayName} placeholder="Display name" maxlength="60" /></label>
						<button type="button" class="bulk-remove-btn" on:click={() => removeBulkEmoji(index)} title="Remove from batch" aria-label={`Remove ${item.displayName || item.name} from batch`}>×</button>
					</div>
				{/each}
			</div>
			<button class="emoji-upload-btn primary-upload" on:click={uploadBulkEmojis} disabled={uploadingBulk || bulkEmojiFiles.length === 0}>
				{uploadingBulk ? 'Uploading pack…' : `Import ${bulkEmojiFiles.length} ${bulkEmojiType === 'sticker' ? 'sticker' : 'emoji'}${bulkEmojiFiles.length === 1 ? '' : 's'}`}
			</button>
		{/if}
	</section>

	<section class="emoji-admin-card library-card">
		<div class="emoji-card-heading">
			<div><span class="emoji-card-kicker">Community library</span><h4>What members can use</h4></div>
			<span>Folders appear in the picker instead of one endless custom-emote wall.</span>
		</div>

		<div class="library-filters">
			<label><span>Folder</span><select bind:value={libraryFolder}><option value="all">All folders</option>{#each existingFolders as folder}<option value={folder}>{folder}</option>{/each}</select></label>
			<label><span>Type</span><select bind:value={libraryType}><option value="all">Emoji + stickers</option><option value="emoji">Emoji</option><option value="sticker">Stickers</option></select></label>
			<div class="library-count"><strong>{filteredCustomEntries.length}</strong><span>shown</span></div>
		</div>

		{#if groupedEntries.length === 0}
			<div class="empty-community-library"><strong>No community assets in this view.</strong><span>Upload a reaction or switch the filters above.</span></div>
		{:else}
			{#each groupedEntries as group (group.folder)}
				<div class="folder-section">
					<div class="folder-heading"><strong>{group.folder}</strong><span>{group.entries.length}</span></div>
					<div class="emoji-grid-list">
						{#each group.entries as emoji (emoji.id)}
							<div class="emoji-item">
								<img src={emoji.url} alt="" class="emoji-thumb" />
								<div class="emoji-item-meta">
									<span class="emoji-item-name">:{emoji.name}:</span>
									<span class="emoji-item-sub">{labelFor(emoji)} · {(emoji.type || 'emoji') === 'sticker' ? 'Sticker' : 'Emoji'}</span>
									{#if emoji.artist}<span class="emoji-item-sub">by {emoji.artist}</span>{/if}
								</div>
								<button class="emoji-delete-btn" on:click={() => deleteEmoji(emoji)} title={`Delete ${emoji.name}`} aria-label={`Delete ${emoji.name}`}>×</button>
							</div>
						{/each}
					</div>
				</div>
			{/each}
		{/if}
	</section>
</div>

<style>
	.emoji-settings-v2 { display: flex; flex-direction: column; gap: 1rem; }
	.emoji-settings-heading, .emoji-card-heading, .bulk-toolbar, .library-filters, .folder-heading { display: flex; align-items: center; }
	.emoji-settings-heading { justify-content: space-between; gap: 1rem; }
	.emoji-settings-heading h3, .emoji-card-heading h4 { margin: 0; color: var(--text-heading); }
	.emoji-settings-heading p { max-width: 52rem; margin: 0.35rem 0 0; color: var(--text-secondary); font-size: 0.86rem; line-height: 1.45; }
	.emoji-library-stat { flex: none; min-width: 92px; padding: 0.65rem 0.8rem; display: flex; flex-direction: column; align-items: flex-end; border: 1px solid var(--border-subtle); border-radius: 10px; background: var(--surface-raised); }
	.emoji-library-stat strong { font-size: 1.15rem; color: var(--text-heading); }
	.emoji-library-stat span { font-size: 0.67rem; color: var(--text-muted); }

	.emoji-admin-card { padding: 1rem; border: 1px solid var(--border-subtle); border-radius: 12px; background: var(--surface-raised); }
	.bulk-card { background: color-mix(in srgb, var(--surface-base) 70%, var(--surface-raised)); }
	.emoji-card-heading { justify-content: space-between; align-items: flex-start; gap: 1rem; margin-bottom: 0.9rem; }
	.emoji-card-heading > span { max-width: 28rem; color: var(--text-muted); font-size: 0.74rem; line-height: 1.35; text-align: right; }
	.emoji-card-kicker { display: block; margin-bottom: 0.15rem; color: var(--accent-primary-color); font-size: 0.65rem; font-weight: 750; letter-spacing: 0.06em; text-transform: uppercase; }

	.single-upload-layout { display: grid; grid-template-columns: minmax(150px, 0.34fr) minmax(0, 1fr); gap: 0.9rem; }
	.asset-drop-button { min-height: 180px; padding: 0.8rem; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.35rem; border: 1px dashed var(--border-strong, var(--border-subtle)); border-radius: 10px; background: var(--surface-app); color: var(--text-heading); cursor: pointer; }
	.asset-drop-button:hover { border-color: var(--accent-primary-color); background: var(--surface-base); }
	.asset-drop-button img { max-width: 112px; max-height: 112px; object-fit: contain; }
	.asset-drop-icon { font-size: 1.55rem; color: var(--accent-primary-color); }
	.asset-drop-button small { color: var(--text-muted); font-size: 0.65rem; text-align: center; }

	.emoji-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.7rem; align-content: start; }
	.emoji-form-grid label, .bulk-toolbar label, .bulk-asset-card label, .library-filters label { min-width: 0; display: flex; flex-direction: column; gap: 0.25rem; }
	.emoji-form-grid label > span, .bulk-toolbar label > span, .bulk-asset-card label > span, .library-filters label > span { color: var(--text-secondary); font-size: 0.68rem; font-weight: 650; }
	.emoji-form-grid input, .emoji-form-grid select, .bulk-toolbar input, .bulk-toolbar select, .bulk-asset-card input, .library-filters select { width: 100%; box-sizing: border-box; min-height: 38px; padding: 0.45rem 0.55rem; border: 1px solid var(--border-subtle); border-radius: 8px; background: var(--surface-app); color: var(--text-heading); font: inherit; font-size: 0.8rem; }
	.emoji-form-grid input:focus, .emoji-form-grid select:focus, .bulk-toolbar input:focus, .bulk-toolbar select:focus, .bulk-asset-card input:focus, .library-filters select:focus { outline: 2px solid color-mix(in srgb, var(--accent-primary-color) 45%, transparent); outline-offset: 1px; border-color: var(--accent-primary-color); }
	.primary-upload { width: 100%; margin-top: 0.85rem; }

	.bulk-toolbar { align-items: end; gap: 0.65rem; flex-wrap: wrap; }
	.bulk-toolbar > button { min-height: 38px; }
	.bulk-toolbar label { flex: 1 1 150px; }
	.bulk-summary { margin: 0.85rem 0 0.6rem; color: var(--text-secondary); font-size: 0.76rem; }
	.bulk-contact-sheet { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0.65rem; }
	.bulk-asset-card { position: relative; padding: 0.65rem; display: grid; gap: 0.5rem; border: 1px solid var(--border-subtle); border-radius: 10px; background: var(--surface-raised); }
	.bulk-asset-preview { height: 96px; display: grid; place-items: center; border-radius: 8px; background: var(--surface-app); }
	.bulk-asset-preview img { max-width: 82px; max-height: 82px; object-fit: contain; }
	.bulk-remove-btn { position: absolute; top: 5px; right: 5px; width: 28px; height: 28px; padding: 0; display: grid; place-items: center; border: 1px solid var(--border-subtle); border-radius: 999px; background: var(--surface-modal); color: var(--text-secondary); }
	.bulk-remove-btn:hover { color: var(--color-danger); }

	.library-filters { gap: 0.65rem; flex-wrap: wrap; margin-bottom: 0.85rem; }
	.library-filters label { flex: 0 1 220px; }
	.library-count { margin-left: auto; display: flex; flex-direction: column; align-items: flex-end; }
	.library-count strong { color: var(--text-heading); }
	.library-count span { color: var(--text-muted); font-size: 0.65rem; }
	.folder-section + .folder-section { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border-subtle); }
	.folder-heading { justify-content: space-between; margin-bottom: 0.5rem; }
	.folder-heading strong { color: var(--text-heading); font-size: 0.82rem; }
	.folder-heading span { min-width: 24px; padding: 0.1rem 0.35rem; border-radius: 999px; background: var(--surface-base); color: var(--text-muted); font-size: 0.65rem; text-align: center; }
	.empty-community-library { min-height: 120px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.25rem; color: var(--text-secondary); text-align: center; }
	.empty-community-library strong { color: var(--text-heading); }
	.empty-community-library span { font-size: 0.75rem; }

	.emoji-delete-btn { color: var(--text-muted); }
	.emoji-delete-btn:hover { color: var(--color-danger); }

	@media (max-width: 760px) {
		.emoji-settings-heading, .emoji-card-heading { align-items: flex-start; flex-direction: column; }
		.emoji-library-stat { align-items: flex-start; }
		.emoji-card-heading > span { text-align: left; }
		.single-upload-layout { grid-template-columns: 1fr; }
		.asset-drop-button { min-height: 140px; }
		.emoji-form-grid { grid-template-columns: 1fr; }
		.library-count { margin-left: 0; align-items: flex-start; }
	}
</style>
