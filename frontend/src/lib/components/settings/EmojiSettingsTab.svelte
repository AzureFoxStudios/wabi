<script lang="ts">
	import { get } from 'svelte/store';
	import { _ as t } from '$lib/i18n';
	import { emojis, getSocket, connected } from '$lib/socket';
	import { getWabiDB } from '$lib/wabidb';
	import { getServerUrl } from '$lib/serverUrl';
	import { getAuthToken } from '$lib/authSession';

	let emojiFileInput: HTMLInputElement;
	let emojiName = '';
	let emojiDisplayName = '';
	let emojiArtist = '';
	let emojiCategory = 'custom';
	let emojiType: 'emoji' | 'sticker' = 'emoji';
	let selectedEmojiFile: File | null = null;
	let emojiPreview: string | null = null;
	let uploadingEmoji = false;

	let bulkEmojiFileInput: HTMLInputElement;
	let bulkEmojiArtist = '';
	let bulkEmojiFiles: { file: File; name: string; displayName: string; preview: string }[] = [];
	let uploadingBulk = false;

	async function handleEmojiFileSelect(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];

		if (!file) return;

		if (!file.type.startsWith('image/')) {
			alert('Please select an image file (PNG, GIF, JPG, etc.)');
			return;
		}

		if (file.size > 2 * 1024 * 1024) {
			alert('File too large! Maximum size is 2MB');
			return;
		}

		selectedEmojiFile = file;

		const reader = new FileReader();
		reader.onload = (e) => {
			emojiPreview = e.target?.result as string;
		};
		reader.readAsDataURL(file);
	}

	async function uploadEmoji() {
		if (!selectedEmojiFile || !emojiName.trim()) {
			alert('Please select a file and enter an emoji name');
			return;
		}

		uploadingEmoji = true;

		try {
			const serverUrl = getServerUrl();
			const formData = new FormData();
			formData.append('file', selectedEmojiFile);
			formData.append('name', emojiName.trim());
			formData.append('displayName', emojiDisplayName.trim());
			formData.append('artist', emojiArtist.trim());
			formData.append('category', emojiCategory);
			formData.append('type', emojiType);

			const authToken = getAuthToken();
			const headers: HeadersInit = {};
			if (authToken) {
				headers['Authorization'] = `Bearer ${authToken}`;
			}

			const response = await fetch(`${serverUrl}/api/emoji/upload`, {
				method: 'POST',
				headers,
				body: formData
			});

			if (!response.ok) {
				throw new Error('Upload failed');
			}

			const result = await response.json();
			const uploadedType = emojiType;

			const socket = getSocket();
			socket?.emit('emoji-added', result.emoji);

			emojiName = '';
			emojiDisplayName = '';
			emojiArtist = '';
			emojiCategory = 'custom';
			emojiType = 'emoji';
			selectedEmojiFile = null;
			emojiPreview = null;
			if (emojiFileInput) emojiFileInput.value = '';

			alert(
				`${uploadedType === 'sticker' ? 'Sticker' : 'Emoji'} "${result.emoji.displayName || result.emoji.name}" uploaded successfully!`
			);
		} catch (error) {
			console.error('Emoji upload error:', error);
			alert('Failed to upload emoji. Please try again.');
		} finally {
			uploadingEmoji = false;
		}
	}

	async function deleteEmoji(targetName: string) {
		if (!confirm(`Delete emoji ":${targetName}:"?`)) return;
		const sock = getSocket();
		if (!sock) return;
		const db = getWabiDB();
		const online = get(connected);
		if (db && !online) {
			await db.enqueue({ scopeId: 'corechat', type: 'delete-emoji', payload: targetName });
			return;
		}
		sock.emit('delete-emoji', targetName);
	}

	async function handleBulkEmojiFileSelect(event: Event) {
		const input = event.target as HTMLInputElement;
		const files = Array.from(input.files || []);
		if (files.length === 0) return;

		const imageFiles = files.filter((f) => f.type.startsWith('image/'));
		if (imageFiles.length === 0) {
			alert('No valid image files selected');
			return;
		}

		for (const file of imageFiles) {
			if (file.size > 2 * 1024 * 1024) {
				alert(`File "${file.name}" is too large! Maximum size is 2MB`);
				return;
			}
		}

		const filesWithPreviews = await Promise.all(
			imageFiles.map(async (file) => {
				const preview = await new Promise<string>((resolve) => {
					const reader = new FileReader();
					reader.onload = (e) => resolve(e.target?.result as string);
					reader.readAsDataURL(file);
				});

				const baseName = file.name.replace(/\.[^/.]+$/, '');
				const autoName = baseName
					.toLowerCase()
					.replace(/[^a-z0-9_]/g, '_')
					.replace(/_+/g, '_')
					.replace(/^_|_$/g, '');

				const displayName = baseName.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

				return { file, name: autoName, displayName, preview };
			})
		);

		bulkEmojiFiles = filesWithPreviews;
	}

	async function uploadBulkEmojis() {
		if (bulkEmojiFiles.length === 0) {
			alert('No files selected');
			return;
		}

		const emptyNames = bulkEmojiFiles.filter((f) => !f.name.trim());
		if (emptyNames.length > 0) {
			alert('All emojis must have a name');
			return;
		}

		uploadingBulk = true;
		let successCount = 0;
		let failCount = 0;

		try {
			const serverUrl = getServerUrl();
			const authToken = getAuthToken();
			const headers: HeadersInit = {};
			if (authToken) {
				headers['Authorization'] = `Bearer ${authToken}`;
			}

			for (const item of bulkEmojiFiles) {
				try {
					const formData = new FormData();
					formData.append('file', item.file);
					formData.append('name', item.name.trim());
					formData.append('displayName', item.displayName.trim());
					formData.append('artist', bulkEmojiArtist.trim());
					formData.append('category', emojiCategory);
					formData.append('type', emojiType);

					const response = await fetch(`${serverUrl}/api/emoji/upload`, {
						method: 'POST',
						headers,
						body: formData
					});

					if (!response.ok) {
						const error = await response.json();
						console.error(`Failed to upload ${item.name}:`, error);
						failCount++;
						continue;
					}

					const result = await response.json();
					const socket = getSocket();
					socket?.emit('emoji-added', result.emoji);

					successCount++;
				} catch (error) {
					console.error(`Error uploading ${item.name}:`, error);
					failCount++;
				}
			}

			bulkEmojiFiles = [];
			bulkEmojiArtist = '';
			if (bulkEmojiFileInput) bulkEmojiFileInput.value = '';

			alert(`Upload complete!\n\u2705 ${successCount} successful\n\u274C ${failCount} failed`);
		} catch (error) {
			console.error('Bulk upload error:', error);
			alert('Failed to upload emojis. Please try again.');
		} finally {
			uploadingBulk = false;
		}
	}

	function removeBulkEmoji(index: number) {
		bulkEmojiFiles = bulkEmojiFiles.filter((_, i) => i !== index);
	}
</script>

<div class="settings-section">
	<h3>{$t('settings.sections.custom_emojis')}</h3>
	<div class="emoji-upload-form">
		<input
			type="file"
			bind:this={emojiFileInput}
			on:change={handleEmojiFileSelect}
			accept="image/*"
			class="hidden"
		/>

		{#if emojiPreview}
			<div class="emoji-preview">
				<img src={emojiPreview} alt="Preview" />
			</div>
		{/if}

		<button class="emoji-select-btn" on:click={() => emojiFileInput?.click()}>
			{emojiPreview ? 'Change Image' : 'Select Image'}
		</button>

		<input
			type="text"
			bind:value={emojiName}
			placeholder="Shortcode (e.g., tabi_wave)"
			maxlength="30"
			class="emoji-name-input"
		/>

		<input
			type="text"
			bind:value={emojiDisplayName}
			placeholder="Display name (e.g., Tabi Wave)"
			maxlength="60"
			class="emoji-name-input"
		/>

		<input
			type="text"
			bind:value={emojiArtist}
			placeholder="Artist / pack creator (e.g., Tabi)"
			maxlength="60"
			class="emoji-name-input"
		/>

		<select bind:value={emojiType} class="emoji-category-select">
			<option value="emoji">Emoji</option>
			<option value="sticker">Sticker</option>
		</select>

		<select bind:value={emojiCategory} class="emoji-category-select">
			<option value="custom">Custom</option>
			<option value="animated">Animated</option>
			<option value="art">Art</option>
			<option value="memes">Memes</option>
		</select>

		<button
			class="emoji-upload-btn"
			on:click={uploadEmoji}
			disabled={uploadingEmoji || !selectedEmojiFile || !emojiName.trim()}
		>
			{uploadingEmoji ? 'Uploading...' : 'Upload Emoji'}
		</button>

		<p class="emoji-hint">Supports PNG, GIF (animated), JPG. Max 2MB.</p>
	</div>

	<div class="emoji-upload-form bulk">
		<h4>Bulk Upload</h4>
		<input
			type="file"
			bind:this={bulkEmojiFileInput}
			on:change={handleBulkEmojiFileSelect}
			accept="image/*"
			multiple
			class="hidden"
		/>

		<button class="emoji-select-btn" on:click={() => bulkEmojiFileInput?.click()}>
			Select Multiple Images
		</button>

		<input
			type="text"
			bind:value={bulkEmojiArtist}
			placeholder="Artist / pack creator for this batch (e.g., Tabi)"
			maxlength="60"
			class="emoji-name-input"
		/>

		<select bind:value={emojiType} class="emoji-category-select">
			<option value="emoji">Emoji</option>
			<option value="sticker">Sticker</option>
		</select>

		{#if bulkEmojiFiles.length > 0}
			<div class="bulk-emoji-list">
				<p class="bulk-count">{bulkEmojiFiles.length} file(s) selected</p>
				{#each bulkEmojiFiles as item, index (item.preview ?? index)}
					<div class="bulk-emoji-item">
						<img src={item.preview} alt="Preview" class="bulk-preview" />
						<input
							type="text"
							bind:value={item.name}
							placeholder="emoji_name"
							maxlength="30"
							class="bulk-name-input"
						/>
						<input
							type="text"
							bind:value={item.displayName}
							placeholder="Display name"
							maxlength="60"
							class="bulk-name-input"
						/>
						<button
							class="bulk-remove-btn"
							on:click={() => removeBulkEmoji(index)}
							title="Remove"
						>
							&times;
						</button>
					</div>
				{/each}
				<button
					class="emoji-upload-btn"
					on:click={uploadBulkEmojis}
					disabled={uploadingBulk || bulkEmojiFiles.length === 0}
				>
					{uploadingBulk
						? 'Uploading...'
						: `Upload ${bulkEmojiFiles.length} ${emojiType === 'sticker' ? 'Sticker' : 'Emoji'}${bulkEmojiFiles.length > 1 ? 's' : ''}`}
				</button>
			</div>
		{/if}

		<p class="emoji-hint">Set shortcode + display names for search. Artist metadata is searchable in picker.</p>
	</div>

	<div class="emoji-list">
		<h4>Your Custom Emojis ({$emojis.filter((e) => e.isCustom).length})</h4>
		<div class="emoji-grid-list">
			{#each $emojis.filter((e) => e.isCustom) as emoji (emoji.id)}
				<div class="emoji-item">
					<img src={emoji.url} alt={emoji.name} class="emoji-thumb" />
					<div class="emoji-item-meta">
						<span class="emoji-item-name">:{emoji.name}:</span>
						{#if emoji.displayName}
							<span class="emoji-item-sub">{emoji.displayName}</span>
						{/if}
						{#if emoji.artist}
							<span class="emoji-item-sub">by {emoji.artist}</span>
						{/if}
					</div>
					<button
						class="emoji-delete-btn"
						on:click={() => deleteEmoji(emoji.name)}
						title="Delete emoji"
					>
						X
					</button>
				</div>
			{/each}
		</div>
	</div>
</div>
