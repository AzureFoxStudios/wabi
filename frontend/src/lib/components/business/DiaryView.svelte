<script lang="ts">
	import ImageViewer from '$lib/components/ImageViewer.svelte';
	import { currentUser } from '$lib/socket';
	import {
		diaryEntries,
		addDiaryEntry,
		updateDiaryEntry,
		deleteDiaryEntry,
		getDiaryEntryForDate
	} from '$lib/business/store';
	import type { DiaryEntry } from '$lib/business/types';

	// Props
	export let isReadOnly = false;
	export let embedded = false;
	export let addSignal = 0;

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
	let willSign = false;
	let fileInput: HTMLInputElement;

	// Image upload handling
	function handleImageUpload(event: Event) {
		const input = event.target as HTMLInputElement;
		if (!input.files?.length) return;

		Array.from(input.files).forEach(file => {
			if (!file.type.startsWith('image/')) return;

			const reader = new FileReader();
			reader.onload = (e) => {
				const result = e.target?.result as string;
				if (result) {
					formImages = [...formImages, result];
				}
			};
			reader.readAsDataURL(file);
		});

		// Reset input so same file can be selected again
		input.value = '';
	}

	function removeImage(index: number) {
		formImages = formImages.filter((_, i) => i !== index);
	}

	function formatDate(date: Date): string {
		return date.toLocaleDateString('en-US', {
			weekday: 'long',
			year: 'numeric',
			month: 'long',
			day: 'numeric'
		});
	}

	function formatShortDate(timestamp: number): string {
		return new Date(timestamp).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric'
		});
	}

	function prevDay() {
		if (!selectedDate) return;
		selectedDate = new Date(selectedDate.getTime() - 24 * 60 * 60 * 1000);
		loadEntry();
	}

	function nextDay() {
		if (!selectedDate) return;
		const tomorrow = new Date(selectedDate.getTime() + 24 * 60 * 60 * 1000);
		if (tomorrow <= new Date()) {
			selectedDate = tomorrow;
			loadEntry();
		}
	}

	function goToToday() {
		selectedDate = new Date();
		loadEntry();
	}

	function clearSelection() {
		selectedDate = null;
		currentEntry = null;
		isEditing = false;
		resetForm();
	}

	function loadEntry() {
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
			willSign = !!entry.signedBy;
		} else {
			resetForm();
		}
		isEditing = false;
	}

	function resetForm() {
		formContent = '';
		formTags = '';
		formIsPrivate = false;
		formImages = [];
		willSign = false;
	}

	function startEditing() {
		isEditing = true;
	}

	function cancelEditing() {
		loadEntry();
	}

	function handleSave() {
		const entryData = {
			date: new Date(selectedDate).setHours(12, 0, 0, 0), // Normalize to noon
			content: formContent.trim(),
			images: formImages.length > 0 ? formImages : undefined,
			tags: formTags ? formTags.split(',').map(t => t.trim()).filter(Boolean) : undefined,
			isPrivate: formIsPrivate,
			createdBy: $currentUser?.id || 'unknown',
			signedBy: willSign ? ($currentUser?.username || 'Guest') : undefined
		};

		if (currentEntry) {
			updateDiaryEntry(currentEntry.id, entryData);
		} else {
			addDiaryEntry(entryData);
		}

		loadEntry();
	}

	function handleDelete() {
		if (currentEntry && confirm('Are you sure you want to delete this entry?')) {
			deleteDiaryEntry(currentEntry.id);
			currentEntry = null;
			resetForm();
		}
	}

	function selectEntry(entry: DiaryEntry) {
		selectedDate = new Date(entry.date);
		loadEntry();
	}

	// Sort entries by date (newest first)
	$: sortedEntries = [...$diaryEntries].sort((a, b) => b.date - a.date);

	// Group entries by month for display
	$: entriesByMonth = sortedEntries.reduce((groups, entry) => {
		const date = new Date(entry.date);
		const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
		const monthLabel = date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
		if (!groups[monthKey]) {
			groups[monthKey] = { label: monthLabel, entries: [] };
		}
		groups[monthKey].entries.push(entry);
		return groups;
	}, {} as Record<string, { label: string; entries: typeof sortedEntries }>);

	// Check if we can go to next day
	$: canGoNext = selectedDate ? new Date(selectedDate.getTime() + 24 * 60 * 60 * 1000) <= new Date() : false;
</script>

<div class="diary-container">
	<aside class="entries-sidebar">
		<div class="sidebar-header">
			<h2>Journal Entries</h2>
			<span class="entry-count">{$diaryEntries.length}</span>
		</div>
		<div class="entries-list">
			{#if sortedEntries.length === 0}
				<p class="empty-message">No entries yet. Start writing!</p>
			{:else}
				{#each sortedEntries as entry (entry.id)}
					<button
						class="entry-item"
						class:active={currentEntry?.id === entry.id}
						on:click={() => selectEntry(entry)}
					>
						<div class="entry-date-badge">
							<span class="entry-day">{new Date(entry.date).getDate()}</span>
							<span class="entry-month">{new Date(entry.date).toLocaleDateString('en-US', { month: 'short' })}</span>
						</div>
						<div class="entry-preview">
							{#if entry.images?.length}
								<span class="entry-has-images" title="{entry.images.length} image(s)">
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
										<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
										<circle cx="8.5" cy="8.5" r="1.5"/>
										<polyline points="21 15 16 10 5 21"/>
									</svg>
								</span>
							{/if}
							<p class="entry-excerpt">{entry.content.slice(0, 50)}{entry.content.length > 50 ? '...' : ''}</p>
						</div>
						{#if entry.isPrivate}
							<span class="private-badge" title="Private">🔒</span>
						{/if}
					</button>
				{/each}
			{/if}
		</div>
	</aside>

	<main class="diary-main">
		{#if selectedDate}
			<header class="diary-header">
				<div class="date-navigation">
					<button class="back-btn" on:click={clearSelection} title="Back to list">
						<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M19 12H5M12 19l-7-7 7-7"/>
						</svg>
					</button>
					<button class="nav-btn" on:click={prevDay}>&larr;</button>
					<h1>{formatDate(selectedDate)}</h1>
					<button class="nav-btn" on:click={nextDay} disabled={!canGoNext}>&rarr;</button>
				</div>
				<div class="header-actions">
					<button class="today-btn" on:click={goToToday}>Today</button>
					{#if currentEntry && !isEditing}
						<button class="edit-btn" on:click={startEditing} disabled={isReadOnly} title={isReadOnly ? 'Read-only mode' : 'Edit'}>Edit</button>
						<button class="delete-btn" on:click={handleDelete} disabled={isReadOnly} title={isReadOnly ? 'Read-only mode' : 'Delete'}>Delete</button>
					{/if}
				</div>
			</header>
		{:else}
			<header class="diary-header welcome-header" class:embedded={embedded}>
				{#if !embedded}
					<h1>Journal</h1>
				{/if}
				<div class="header-actions">
					<button class="today-btn primary" on:click={goToToday}>+ New Entry</button>
				</div>
			</header>
		{/if}

		<div class="diary-content">
			{#if !selectedDate}
				<!-- Welcome/List View -->
				<div class="welcome-view">
					{#if sortedEntries.length === 0}
						<div class="empty-state">
							<div class="empty-icon">
								<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
									<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
									<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
								</svg>
							</div>
							<h2>No journal entries yet</h2>
							<p>Capture a thought for today. Photos and sketches welcome.</p>
							{#if !isReadOnly}
								<button type="button" class="today-btn primary" on:click={goToToday}>Write today’s entry</button>
							{/if}
						</div>
					{:else}
						<div class="entries-list-view">
							{#each Object.entries(entriesByMonth).sort((a, b) => b[0].localeCompare(a[0])) as [monthKey, { label, entries }] (monthKey)}
								<div class="month-group">
									<h3 class="month-header">{label}</h3>
									<div class="month-entries">
										{#each entries as entry (entry.id)}
											<button class="entry-row" on:click={() => selectEntry(entry)}>
												{#if entry.images?.length}
													<div class="entry-row-image">
														<img src={entry.images[0]} alt="" />
														<div class="image-fade"></div>
														{#if entry.images.length > 1}
															<span class="image-count-badge">+{entry.images.length - 1}</span>
														{/if}
													</div>
												{:else}
													<div class="entry-row-date-badge">
														<span class="date-day">{new Date(entry.date).getDate()}</span>
														<span class="date-weekday">{new Date(entry.date).toLocaleDateString('en-US', { weekday: 'short' })}</span>
													</div>
												{/if}
												<div class="entry-row-content">
													<div class="entry-row-header">
														<span class="entry-row-date">
															{new Date(entry.date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
														</span>
														{#if entry.isPrivate}
															<span class="private-badge-small">🔒</span>
														{/if}
													</div>
													<p class="entry-row-excerpt">{entry.content.slice(0, 200)}{entry.content.length > 200 ? '...' : ''}</p>
													{#if entry.tags?.length}
														<div class="entry-row-tags">
															{#each entry.tags.slice(0, 4) as tag}
																<span class="tag-mini">{tag}</span>
															{/each}
														</div>
													{/if}
												</div>
												<div class="entry-row-arrow">
													<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
														<path d="M9 18l6-6-6-6"/>
													</svg>
												</div>
											</button>
										{/each}
									</div>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{:else if isEditing || !currentEntry}
				<!-- Edit Mode -->
				<div class="editor">
					<textarea
						class="content-editor"
						bind:value={formContent}
						placeholder="Document your learnings, ideas, or notes..."
						rows="12"
					></textarea>

					<!-- Image Upload Section -->
					<div class="image-upload-section">
						<div class="image-upload-header">
							<span class="upload-label">Attach Images</span>
							<button
								type="button"
								class="upload-btn"
								on:click={() => fileInput.click()}
							>
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
									<circle cx="8.5" cy="8.5" r="1.5"/>
									<polyline points="21 15 16 10 5 21"/>
								</svg>
								Add Photo
							</button>
							<input
								bind:this={fileInput}
								type="file"
								accept="image/*"
								multiple
								on:change={handleImageUpload}
								style="display: none;"
							/>
						</div>
						{#if formImages.length > 0}
							<div class="image-preview-grid">
								{#each formImages as image, i}
									<div class="image-preview-item">
										<img src={image} alt="Uploaded {i + 1}" />
										<button
											class="remove-image-btn"
											on:click={() => removeImage(i)}
											title="Remove image"
										>
											<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
												<line x1="18" y1="6" x2="6" y2="18"/>
												<line x1="6" y1="6" x2="18" y2="18"/>
											</svg>
										</button>
									</div>
								{/each}
							</div>
						{/if}
					</div>

					<div class="editor-footer">
						<div class="tags-input">
							<input
								type="text"
								bind:value={formTags}
								placeholder="Tags (comma separated)"
							/>
						</div>

						<label class="private-toggle">
							<input type="checkbox" bind:checked={formIsPrivate} />
							<span>Private entry</span>
						</label>

						<!-- Signature checkbox -->
						<label class="sign-toggle">
							<input type="checkbox" bind:checked={willSign} />
							<span>Sign this entry with my username</span>
						</label>
					</div>

					<div class="editor-actions">
						{#if currentEntry}
							<button class="cancel-btn" on:click={cancelEditing}>Cancel</button>
						{/if}
						<button
							class="save-btn"
							on:click={handleSave}
							disabled={!formContent.trim()}
						>
							{currentEntry ? 'Save Changes' : 'Save Entry'}
						</button>
					</div>
				</div>
			{:else}
				<!-- View Mode -->
				<div class="entry-view">
					<div class="entry-content">
						{#each currentEntry.content.split('\n') as paragraph}
							{#if paragraph.trim()}
								<p>{paragraph}</p>
							{:else}
								<br />
							{/if}
						{/each}
					</div>

					{#if currentEntry.images?.length}
						<div class="entry-images">
							<h3 class="images-header">Attached Images ({currentEntry.images.length})</h3>
							<div class="images-gallery large">
								{#each currentEntry.images as image, i}
									<button
										class="gallery-image-large"
										on:click={() => viewingImage = image}
										title="Click to view full size"
									>
										<img src={image} alt="Note {i + 1}" />
									</button>
								{/each}
							</div>
						</div>
					{/if}

					{#if currentEntry.tags?.length}
						<div class="entry-tags">
							{#each currentEntry.tags as tag}
								<span class="tag">{tag}</span>
							{/each}
						</div>
					{/if}

					<div class="entry-meta">
						<span class="created-at">
							Written on {new Date(currentEntry.createdAt).toLocaleDateString('en-US', {
								month: 'long',
								day: 'numeric',
								year: 'numeric',
								hour: 'numeric',
								minute: '2-digit'
							})}
						</span>
						{#if currentEntry.updatedAt !== currentEntry.createdAt}
							<span class="updated-at">
								(edited {new Date(currentEntry.updatedAt).toLocaleDateString()})
							</span>
						{/if}
						{#if currentEntry.signedBy}
							<span class="signature" title="Signed by {currentEntry.signedBy}">
								✍️ {currentEntry.signedBy}
							</span>
						{/if}
					</div>
				</div>
			{/if}

			{#if selectedDate && !currentEntry && !isEditing}
				<div class="no-entry">
					<p>No entry for this day</p>
					<button class="start-writing-btn" on:click={startEditing} disabled={isReadOnly} title={isReadOnly ? 'Read-only mode' : 'Start Writing'}>
						Start Writing
					</button>
				</div>
			{/if}
		</div>
	</main>
</div>

<ImageViewer src={viewingImage || ''} alt="Diary image" onClose={() => (viewingImage = null)} />

