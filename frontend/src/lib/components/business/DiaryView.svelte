<script lang="ts">
	import { currentUser } from '$lib/socket';
	import {
		diaryEntries,
		addDiaryEntry,
		updateDiaryEntry,
		deleteDiaryEntry,
		getDiaryEntryForDate
	} from '$lib/business/store';
	import type { DiaryEntry } from '$lib/business/types';

	let selectedDate: Date | null = null;
	let isEditing = false;
	let currentEntry: DiaryEntry | null = null;
	let viewingImage: string | null = null; // For full-screen image view

	// Form state
	let formContent = '';
	let formTags = '';
	let formIsPrivate = false;
	let formImages: string[] = [];
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
			createdBy: $currentUser?.id || 'unknown'
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
						<button class="edit-btn" on:click={startEditing}>Edit</button>
						<button class="delete-btn" on:click={handleDelete}>Delete</button>
					{/if}
				</div>
			</header>
		{:else}
			<header class="diary-header welcome-header">
				<h1>Journal</h1>
				<div class="header-actions">
					<button class="today-btn primary" on:click={goToToday}>+ New Entry for Today</button>
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
							<h2>Start Your Journal</h2>
							<p>Document your thoughts, ideas, and memories. Attach photos of handwritten notes, sketches, or anything that inspires you.</p>
							<button class="start-btn" on:click={goToToday}>Write Your First Entry</button>
						</div>
					{:else}
						<div class="entries-list-view">
							{#each Object.entries(entriesByMonth).sort((a, b) => b[0].localeCompare(a[0])) as [monthKey, { label, entries }]}
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
					</div>
				</div>
			{/if}

			{#if selectedDate && !currentEntry && !isEditing}
				<div class="no-entry">
					<p>No entry for this day</p>
					<button class="start-writing-btn" on:click={startEditing}>
						Start Writing
					</button>
				</div>
			{/if}
		</div>
	</main>
</div>

<!-- Full-screen Image Viewer -->
{#if viewingImage}
	<div class="image-viewer-overlay" on:click={() => viewingImage = null}>
		<button class="viewer-close" on:click={() => viewingImage = null}>&times;</button>
		<img src={viewingImage} alt="Full view" class="viewer-image" on:click|stopPropagation />
	</div>
{/if}

<style>
	.diary-container {
		display: flex;
		height: 100%;
		gap: 1rem;
	}

	/* Sidebar */
	.entries-sidebar {
		width: 280px;
		background: var(--biz-bg-secondary, #1a2332);
		border-radius: 12px;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		flex-shrink: 0;
		border: 1px solid var(--biz-border, #2d3a4d);
	}

	.sidebar-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1rem;
		border-bottom: 1px solid var(--biz-border, #2d3a4d);
	}

	.sidebar-header h2 {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		color: var(--biz-text-primary, #f1f5f9);
	}

	.entry-count {
		background: var(--biz-bg-tertiary, #243044);
		padding: 0.2rem 0.5rem;
		border-radius: 10px;
		font-size: 0.75rem;
		color: var(--biz-text-secondary, #94a3b8);
	}

	.entries-list {
		flex: 1;
		overflow-y: auto;
		padding: 0.5rem;
	}

	.empty-message {
		text-align: center;
		color: var(--biz-text-muted, #64748b);
		padding: 2rem 1rem;
		font-size: 0.9rem;
	}

	.entry-item {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		padding: 0.75rem;
		background: transparent;
		border: none;
		border-radius: 8px;
		cursor: pointer;
		text-align: left;
		color: var(--biz-text-primary, #f1f5f9);
		transition: background 0.2s;
		margin-bottom: 0.25rem;
	}

	.entry-item:hover {
		background: var(--biz-bg-tertiary, #243044);
	}

	.entry-item.active {
		background: var(--biz-accent, #f59e0b);
	}

	.entry-date-badge {
		display: flex;
		flex-direction: column;
		align-items: center;
		min-width: 40px;
	}

	.entry-day {
		font-size: 1.1rem;
		font-weight: 700;
		line-height: 1;
	}

	.entry-month {
		font-size: 0.65rem;
		text-transform: uppercase;
		opacity: 0.7;
	}

	.entry-preview {
		flex: 1;
		min-width: 0;
	}

	.entry-excerpt {
		margin: 0;
		font-size: 0.8rem;
		color: var(--biz-text-secondary, #94a3b8);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.entry-item.active .entry-excerpt {
		color: rgba(255, 255, 255, 0.8);
	}

	.private-badge {
		font-size: 0.75rem;
	}

	/* Main Content */
	.diary-main {
		flex: 1;
		display: flex;
		flex-direction: column;
		background: var(--biz-bg-secondary, #1a2332);
		border-radius: 12px;
		overflow: hidden;
		border: 1px solid var(--biz-border, #2d3a4d);
	}

	.diary-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1rem 1.5rem;
		border-bottom: 1px solid var(--biz-border, #2d3a4d);
		flex-wrap: wrap;
		gap: 1rem;
	}

	.date-navigation {
		display: flex;
		align-items: center;
		gap: 1rem;
	}

	.date-navigation h1 {
		margin: 0;
		font-size: 1.25rem;
		min-width: 280px;
		text-align: center;
		color: var(--biz-text-primary, #f1f5f9);
	}

	.nav-btn {
		background: var(--biz-bg-tertiary, #243044);
		border: 1px solid var(--biz-border, #2d3a4d);
		color: var(--biz-text-primary, #f1f5f9);
		padding: 0.5rem 0.75rem;
		border-radius: 8px;
		cursor: pointer;
		transition: all 0.2s;
	}

	.nav-btn:hover:not(:disabled) {
		background: var(--biz-bg-hover, #2a3a4d);
		border-color: var(--biz-accent, #f59e0b);
	}

	.nav-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.header-actions {
		display: flex;
		gap: 0.5rem;
	}

	.today-btn,
	.edit-btn {
		padding: 0.5rem 1rem;
		background: var(--biz-bg-tertiary, #243044);
		border: 1px solid var(--biz-border, #2d3a4d);
		color: var(--biz-text-primary, #f1f5f9);
		border-radius: 8px;
		cursor: pointer;
		transition: all 0.2s;
	}

	.today-btn:hover,
	.edit-btn:hover {
		background: var(--biz-bg-hover, #2a3a4d);
	}

	.delete-btn {
		padding: 0.5rem 1rem;
		background: transparent;
		border: 1px solid var(--biz-danger, #ef4444);
		color: var(--biz-danger, #ef4444);
		border-radius: 8px;
		cursor: pointer;
		transition: all 0.2s;
	}

	.delete-btn:hover {
		background: var(--biz-danger, #ef4444);
		color: white;
	}

	.diary-content {
		flex: 1;
		padding: 1.5rem;
		overflow-y: auto;
	}

	/* Editor */
	.editor {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.content-editor {
		flex: 1;
		width: 100%;
		padding: 1rem;
		background: var(--biz-bg-tertiary, #243044);
		border: 1px solid var(--biz-border, #2d3a4d);
		border-radius: 8px;
		color: var(--biz-text-primary, #f1f5f9);
		font-size: 1rem;
		line-height: 1.6;
		resize: none;
		font-family: inherit;
	}

	.content-editor:focus {
		outline: none;
		border-color: var(--biz-accent, #f59e0b);
	}

	.content-editor::placeholder {
		color: var(--biz-text-muted, #64748b);
	}

	.editor-footer {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-top: 1rem;
		gap: 1rem;
	}

	.tags-input {
		flex: 1;
	}

	.tags-input input {
		width: 100%;
		padding: 0.5rem 0.75rem;
		background: var(--biz-bg-tertiary, #243044);
		border: 1px solid var(--biz-border, #2d3a4d);
		border-radius: 8px;
		color: var(--biz-text-primary, #f1f5f9);
		font-size: 0.9rem;
	}

	.tags-input input:focus {
		outline: none;
		border-color: var(--biz-accent, #f59e0b);
	}

	.private-toggle {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
		font-size: 0.9rem;
		color: var(--biz-text-secondary, #94a3b8);
	}

	.private-toggle input {
		accent-color: var(--biz-accent, #f59e0b);
	}

	.editor-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.75rem;
		margin-top: 1rem;
	}

	.cancel-btn {
		padding: 0.6rem 1rem;
		background: transparent;
		border: 1px solid var(--biz-border, #2d3a4d);
		border-radius: 8px;
		color: var(--biz-text-secondary, #94a3b8);
		cursor: pointer;
		transition: all 0.2s;
	}

	.cancel-btn:hover {
		background: var(--biz-bg-tertiary, #243044);
		color: var(--biz-text-primary, #f1f5f9);
	}

	.save-btn {
		padding: 0.6rem 1.25rem;
		background: var(--biz-accent, #f59e0b);
		border: none;
		border-radius: 8px;
		color: white;
		cursor: pointer;
		font-weight: 500;
		transition: background 0.2s;
	}

	.save-btn:hover {
		background: var(--biz-accent-hover, #d97706);
	}

	.save-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Image Upload Styles */
	.image-upload-section {
		margin-top: 1rem;
		padding: 1rem;
		background: var(--biz-bg-tertiary, #243044);
		border-radius: 8px;
		border: 1px dashed var(--biz-border, #2d3a4d);
	}

	.image-upload-header {
		display: flex;
		align-items: center;
		gap: 1rem;
	}

	.upload-label {
		font-size: 0.9rem;
		color: var(--biz-text-secondary, #94a3b8);
	}

	.upload-btn {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 1rem;
		background: var(--biz-bg-secondary, #1a2332);
		border: 1px solid var(--biz-border, #2d3a4d);
		border-radius: 6px;
		color: var(--biz-text-primary, #f1f5f9);
		font-size: 0.85rem;
		cursor: pointer;
		transition: all 0.2s;
	}

	.upload-btn:hover {
		background: var(--biz-accent, #f59e0b);
		border-color: var(--biz-accent, #f59e0b);
		color: white;
	}

	.image-preview-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
		gap: 0.75rem;
		margin-top: 1rem;
	}

	.image-preview-item {
		position: relative;
		aspect-ratio: 1;
		border-radius: 8px;
		overflow: hidden;
		background: var(--biz-bg-primary, #0f1419);
	}

	.image-preview-item img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.remove-image-btn {
		position: absolute;
		top: 4px;
		right: 4px;
		width: 24px;
		height: 24px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--biz-danger, #ef4444);
		border: none;
		border-radius: 50%;
		color: white;
		cursor: pointer;
		opacity: 0;
		transition: opacity 0.2s;
	}

	.image-preview-item:hover .remove-image-btn {
		opacity: 1;
	}

	/* View Mode */
	.entry-view {
		max-width: 700px;
	}

	.entry-images {
		margin: 1.5rem 0;
	}

	.images-header {
		font-size: 0.9rem;
		font-weight: 500;
		color: var(--biz-text-secondary, #94a3b8);
		margin: 0 0 0.75rem 0;
	}

	.images-gallery {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
		gap: 0.75rem;
	}

	.gallery-image {
		aspect-ratio: 4/3;
		border-radius: 8px;
		overflow: hidden;
		cursor: pointer;
		border: 2px solid transparent;
		background: var(--biz-bg-tertiary, #243044);
		padding: 0;
		transition: all 0.2s;
	}

	.gallery-image:hover {
		border-color: var(--biz-accent, #f59e0b);
		transform: scale(1.02);
	}

	.gallery-image img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.entry-has-images {
		display: inline-flex;
		color: var(--biz-info, #3b82f6);
		margin-right: 0.5rem;
	}

	.entry-content {
		font-size: 1.05rem;
		line-height: 1.8;
		color: var(--biz-text-primary, #f1f5f9);
	}

	.entry-content p {
		margin: 0 0 1rem 0;
	}

	.entry-tags {
		display: flex;
		gap: 0.5rem;
		margin-top: 2rem;
		flex-wrap: wrap;
	}

	.tag {
		font-size: 0.8rem;
		padding: 0.25rem 0.6rem;
		background: var(--biz-info-soft, rgba(59, 130, 246, 0.15));
		color: var(--biz-info, #3b82f6);
		border-radius: 4px;
	}

	.entry-meta {
		margin-top: 2rem;
		padding-top: 1rem;
		border-top: 1px solid var(--biz-border, #2d3a4d);
		font-size: 0.8rem;
		color: var(--biz-text-muted, #64748b);
	}

	.updated-at {
		margin-left: 0.5rem;
	}

	/* No Entry */
	.no-entry {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100%;
		text-align: center;
	}

	.no-entry p {
		color: var(--biz-text-muted, #64748b);
		margin-bottom: 1rem;
	}

	.start-writing-btn {
		padding: 0.75rem 1.5rem;
		background: var(--biz-accent, #f59e0b);
		color: white;
		border: none;
		border-radius: 8px;
		cursor: pointer;
		font-weight: 500;
		font-size: 1rem;
		transition: background 0.2s;
	}

	.start-writing-btn:hover {
		background: var(--biz-accent-hover, #d97706);
	}

	/* Welcome/List View */
	.welcome-header {
		justify-content: space-between;
	}

	.welcome-header h1 {
		font-size: 1.5rem;
		color: var(--biz-text-primary, #f1f5f9);
		margin: 0;
	}

	.today-btn.primary {
		background: var(--biz-accent, #f59e0b);
		border-color: var(--biz-accent, #f59e0b);
		color: white;
	}

	.today-btn.primary:hover {
		background: var(--biz-accent-hover, #d97706);
	}

	.back-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		background: var(--biz-bg-tertiary, #243044);
		border: 1px solid var(--biz-border, #2d3a4d);
		border-radius: 8px;
		color: var(--biz-text-secondary, #94a3b8);
		cursor: pointer;
		transition: all 0.2s;
		padding: 0;
		margin-right: 0.5rem;
	}

	.back-btn:hover {
		background: var(--biz-accent, #f59e0b);
		color: white;
	}

	.welcome-view {
		height: 100%;
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100%;
		text-align: center;
		padding: 2rem;
	}

	.empty-icon {
		color: var(--biz-text-muted, #64748b);
		margin-bottom: 1.5rem;
		opacity: 0.5;
	}

	.empty-state h2 {
		margin: 0 0 0.75rem 0;
		font-size: 1.5rem;
		color: var(--biz-text-primary, #f1f5f9);
	}

	.empty-state p {
		color: var(--biz-text-secondary, #94a3b8);
		max-width: 400px;
		margin: 0 0 1.5rem 0;
		line-height: 1.6;
	}

	.start-btn {
		padding: 0.75rem 1.5rem;
		background: var(--biz-accent, #f59e0b);
		color: white;
		border: none;
		border-radius: 8px;
		cursor: pointer;
		font-weight: 500;
		font-size: 1rem;
		transition: background 0.2s;
	}

	.start-btn:hover {
		background: var(--biz-accent-hover, #d97706);
	}

	/* Entries Row List View */
	.entries-list-view {
		display: flex;
		flex-direction: column;
		gap: 2rem;
	}

	.month-group {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.month-header {
		font-size: 0.85rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--biz-text-muted, #64748b);
		padding: 0.5rem 0;
		border-bottom: 1px solid var(--biz-border, #2d3a4d);
		margin: 0;
	}

	.month-entries {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.entry-row {
		display: flex;
		align-items: center;
		gap: 1rem;
		width: 100%;
		padding: 0.75rem;
		background: var(--biz-bg-tertiary, #243044);
		border: 1px solid var(--biz-border, #2d3a4d);
		border-radius: 12px;
		cursor: pointer;
		text-align: left;
		color: var(--biz-text-primary, #f1f5f9);
		transition: all 0.2s;
	}

	.entry-row:hover {
		border-color: var(--biz-accent, #f59e0b);
		background: var(--biz-bg-hover, #2a3a4d);
	}

	.entry-row-image {
		position: relative;
		width: 100px;
		height: 70px;
		border-radius: 8px;
		overflow: hidden;
		flex-shrink: 0;
	}

	.entry-row-image img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.entry-row-image .image-fade {
		position: absolute;
		top: 0;
		right: 0;
		bottom: 0;
		width: 50%;
		background: linear-gradient(to right, transparent, var(--biz-bg-tertiary, #243044));
		pointer-events: none;
	}

	.entry-row:hover .entry-row-image .image-fade {
		background: linear-gradient(to right, transparent, var(--biz-bg-hover, #2a3a4d));
	}

	.image-count-badge {
		position: absolute;
		bottom: 4px;
		left: 4px;
		background: rgba(0, 0, 0, 0.7);
		color: white;
		padding: 2px 6px;
		border-radius: 4px;
		font-size: 0.65rem;
		font-weight: 500;
	}

	.entry-row-date-badge {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		width: 100px;
		height: 70px;
		background: var(--biz-bg-secondary, #1a2332);
		border-radius: 8px;
		flex-shrink: 0;
	}

	.entry-row-date-badge .date-day {
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--biz-accent, #f59e0b);
		line-height: 1;
	}

	.entry-row-date-badge .date-weekday {
		font-size: 0.7rem;
		text-transform: uppercase;
		color: var(--biz-text-muted, #64748b);
		margin-top: 0.25rem;
	}

	.entry-row-content {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.entry-row-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.entry-row-date {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--biz-text-primary, #f1f5f9);
	}

	.private-badge-small {
		font-size: 0.75rem;
	}

	.entry-row-excerpt {
		margin: 0;
		font-size: 0.85rem;
		color: var(--biz-text-secondary, #94a3b8);
		line-height: 1.4;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.entry-row-tags {
		display: flex;
		gap: 0.25rem;
		margin-top: 0.25rem;
	}

	.tag-mini {
		font-size: 0.7rem;
		padding: 0.15rem 0.4rem;
		background: var(--biz-info-soft, rgba(59, 130, 246, 0.15));
		color: var(--biz-info, #3b82f6);
		border-radius: 3px;
	}

	.entry-row-arrow {
		color: var(--biz-text-muted, #64748b);
		flex-shrink: 0;
		transition: all 0.2s;
	}

	.entry-row:hover .entry-row-arrow {
		color: var(--biz-accent, #f59e0b);
		transform: translateX(4px);
	}

	/* Large Gallery for Entry View */
	.images-gallery.large {
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 1rem;
	}

	.gallery-image-large {
		aspect-ratio: auto;
		min-height: 200px;
		max-height: 400px;
		border-radius: 12px;
		overflow: hidden;
		cursor: pointer;
		border: 2px solid transparent;
		background: var(--biz-bg-tertiary, #243044);
		padding: 0;
		transition: all 0.2s;
	}

	.gallery-image-large:hover {
		border-color: var(--biz-accent, #f59e0b);
		transform: scale(1.02);
	}

	.gallery-image-large img {
		width: 100%;
		height: 100%;
		object-fit: contain;
		background: var(--biz-bg-primary, #0f1419);
	}

	/* Full-screen Image Viewer */
	.image-viewer-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.95);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 2000;
		padding: 2rem;
	}

	.viewer-close {
		position: absolute;
		top: 1rem;
		right: 1rem;
		width: 44px;
		height: 44px;
		background: rgba(255, 255, 255, 0.1);
		border: 2px solid rgba(255, 255, 255, 0.3);
		border-radius: 50%;
		color: white;
		font-size: 2rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s;
		padding: 0;
		line-height: 1;
	}

	.viewer-close:hover {
		background: rgba(255, 255, 255, 0.2);
		transform: scale(1.1);
	}

	.viewer-image {
		max-width: 95vw;
		max-height: 90vh;
		object-fit: contain;
		border-radius: 8px;
	}

	@media (max-width: 900px) {
		.diary-container {
			flex-direction: column;
		}

		.entries-sidebar {
			width: 100%;
			max-height: 200px;
		}

		.entries-list {
			display: flex;
			gap: 0.5rem;
			padding: 0.5rem;
			overflow-x: auto;
		}

		.entry-item {
			flex-direction: column;
			min-width: 100px;
			text-align: center;
		}

		.entries-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
