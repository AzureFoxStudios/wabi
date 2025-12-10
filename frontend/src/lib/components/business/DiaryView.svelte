<script lang="ts">
	import {
		diaryEntries,
		addDiaryEntry,
		updateDiaryEntry,
		deleteDiaryEntry,
		getDiaryEntryForDate
	} from '$lib/business/store';
	import type { DiaryEntry } from '$lib/business/types';

	let selectedDate = new Date();
	let isEditing = false;
	let currentEntry: DiaryEntry | null = null;

	// Form state
	let formContent = '';
	let formMood: DiaryEntry['mood'] | '' = '';
	let formTags = '';
	let formIsPrivate = false;

	const moodOptions: { value: DiaryEntry['mood']; emoji: string; label: string }[] = [
		{ value: 'great', emoji: '😄', label: 'Great' },
		{ value: 'good', emoji: '🙂', label: 'Good' },
		{ value: 'neutral', emoji: '😐', label: 'Neutral' },
		{ value: 'bad', emoji: '😕', label: 'Bad' },
		{ value: 'terrible', emoji: '😢', label: 'Terrible' }
	];

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
		selectedDate = new Date(selectedDate.getTime() - 24 * 60 * 60 * 1000);
		loadEntry();
	}

	function nextDay() {
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

	function loadEntry() {
		const entry = getDiaryEntryForDate(selectedDate.getTime());
		currentEntry = entry || null;
		if (entry) {
			formContent = entry.content;
			formMood = entry.mood || '';
			formTags = entry.tags?.join(', ') || '';
			formIsPrivate = entry.isPrivate;
		} else {
			resetForm();
		}
		isEditing = false;
	}

	function resetForm() {
		formContent = '';
		formMood = '';
		formTags = '';
		formIsPrivate = false;
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
			mood: formMood || undefined,
			tags: formTags ? formTags.split(',').map(t => t.trim()).filter(Boolean) : undefined,
			isPrivate: formIsPrivate,
			createdBy: 'current-user'
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

	function getMoodEmoji(mood: DiaryEntry['mood']): string {
		return moodOptions.find(m => m.value === mood)?.emoji || '';
	}

	// Initialize
	loadEntry();

	// Sort entries by date (newest first)
	$: sortedEntries = [...$diaryEntries].sort((a, b) => b.date - a.date);

	// Check if we can go to next day
	$: canGoNext = new Date(selectedDate.getTime() + 24 * 60 * 60 * 1000) <= new Date();
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
							{#if entry.mood}
								<span class="entry-mood">{getMoodEmoji(entry.mood)}</span>
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
		<header class="diary-header">
			<div class="date-navigation">
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

		<div class="diary-content">
			{#if isEditing || !currentEntry}
				<!-- Edit Mode -->
				<div class="editor">
					<div class="mood-selector">
						<span class="mood-label">How are you feeling?</span>
						<div class="mood-options">
							{#each moodOptions as option}
								<button
									class="mood-btn"
									class:selected={formMood === option.value}
									on:click={() => formMood = formMood === option.value ? '' : option.value}
									title={option.label}
								>
									{option.emoji}
								</button>
							{/each}
						</div>
					</div>

					<textarea
						class="content-editor"
						bind:value={formContent}
						placeholder="What's on your mind today?"
						rows="15"
					></textarea>

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
					{#if currentEntry.mood}
						<div class="entry-mood-display">
							<span class="mood-emoji">{getMoodEmoji(currentEntry.mood)}</span>
							<span class="mood-text">Feeling {currentEntry.mood}</span>
						</div>
					{/if}

					<div class="entry-content">
						{#each currentEntry.content.split('\n') as paragraph}
							{#if paragraph.trim()}
								<p>{paragraph}</p>
							{:else}
								<br />
							{/if}
						{/each}
					</div>

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

			{#if !currentEntry && !isEditing}
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

<style>
	.diary-container {
		display: flex;
		height: 100%;
		gap: 1rem;
	}

	/* Sidebar */
	.entries-sidebar {
		width: 280px;
		background: var(--bg-secondary, #16213e);
		border-radius: 12px;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		flex-shrink: 0;
	}

	.sidebar-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1rem;
		border-bottom: 1px solid var(--border-color, #2a2a4a);
	}

	.sidebar-header h2 {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
	}

	.entry-count {
		background: var(--bg-tertiary, #1f2937);
		padding: 0.2rem 0.5rem;
		border-radius: 10px;
		font-size: 0.75rem;
	}

	.entries-list {
		flex: 1;
		overflow-y: auto;
		padding: 0.5rem;
	}

	.empty-message {
		text-align: center;
		color: var(--text-secondary, #888);
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
		color: var(--text-primary, #eee);
		transition: background 0.2s;
		margin-bottom: 0.25rem;
	}

	.entry-item:hover {
		background: var(--bg-tertiary, #1f2937);
	}

	.entry-item.active {
		background: var(--accent, #5865f2);
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

	.entry-mood {
		font-size: 0.9rem;
	}

	.entry-excerpt {
		margin: 0;
		font-size: 0.8rem;
		color: var(--text-secondary, #aaa);
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
		background: var(--bg-secondary, #16213e);
		border-radius: 12px;
		overflow: hidden;
	}

	.diary-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1rem 1.5rem;
		border-bottom: 1px solid var(--border-color, #2a2a4a);
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
	}

	.nav-btn {
		background: var(--bg-tertiary, #1f2937);
		border: 1px solid var(--border-color, #2a2a4a);
		color: var(--text-primary, #eee);
		padding: 0.5rem 0.75rem;
		border-radius: 6px;
		cursor: pointer;
		transition: all 0.2s;
	}

	.nav-btn:hover:not(:disabled) {
		background: var(--bg-hover, #2a3441);
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
		background: var(--bg-tertiary, #1f2937);
		border: 1px solid var(--border-color, #2a2a4a);
		color: var(--text-primary, #eee);
		border-radius: 6px;
		cursor: pointer;
		transition: all 0.2s;
	}

	.today-btn:hover,
	.edit-btn:hover {
		background: var(--bg-hover, #2a3441);
	}

	.delete-btn {
		padding: 0.5rem 1rem;
		background: transparent;
		border: 1px solid #ef4444;
		color: #ef4444;
		border-radius: 6px;
		cursor: pointer;
		transition: all 0.2s;
	}

	.delete-btn:hover {
		background: #ef4444;
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

	.mood-selector {
		display: flex;
		align-items: center;
		gap: 1rem;
		margin-bottom: 1rem;
	}

	.mood-label {
		font-size: 0.9rem;
		color: var(--text-secondary, #888);
	}

	.mood-options {
		display: flex;
		gap: 0.5rem;
	}

	.mood-btn {
		font-size: 1.5rem;
		background: var(--bg-tertiary, #1f2937);
		border: 2px solid transparent;
		border-radius: 8px;
		padding: 0.5rem;
		cursor: pointer;
		transition: all 0.2s;
	}

	.mood-btn:hover {
		transform: scale(1.1);
	}

	.mood-btn.selected {
		border-color: var(--accent, #5865f2);
		background: rgba(88, 101, 242, 0.2);
	}

	.content-editor {
		flex: 1;
		width: 100%;
		padding: 1rem;
		background: var(--bg-tertiary, #1f2937);
		border: 1px solid var(--border-color, #2a2a4a);
		border-radius: 8px;
		color: var(--text-primary, #eee);
		font-size: 1rem;
		line-height: 1.6;
		resize: none;
		font-family: inherit;
	}

	.content-editor:focus {
		outline: none;
		border-color: var(--accent, #5865f2);
	}

	.content-editor::placeholder {
		color: var(--text-secondary, #666);
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
		background: var(--bg-tertiary, #1f2937);
		border: 1px solid var(--border-color, #2a2a4a);
		border-radius: 6px;
		color: var(--text-primary, #eee);
		font-size: 0.9rem;
	}

	.private-toggle {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
		font-size: 0.9rem;
		color: var(--text-secondary, #888);
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
		border: 1px solid var(--border-color, #2a2a4a);
		border-radius: 6px;
		color: var(--text-secondary, #aaa);
		cursor: pointer;
	}

	.save-btn {
		padding: 0.6rem 1.25rem;
		background: var(--accent, #5865f2);
		border: none;
		border-radius: 6px;
		color: white;
		cursor: pointer;
		font-weight: 500;
	}

	.save-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* View Mode */
	.entry-view {
		max-width: 700px;
	}

	.entry-mood-display {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 1.5rem;
		padding: 0.75rem 1rem;
		background: var(--bg-tertiary, #1f2937);
		border-radius: 8px;
		width: fit-content;
	}

	.mood-emoji {
		font-size: 1.5rem;
	}

	.mood-text {
		font-size: 0.9rem;
		color: var(--text-secondary, #aaa);
		text-transform: capitalize;
	}

	.entry-content {
		font-size: 1.05rem;
		line-height: 1.8;
		color: var(--text-primary, #eee);
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
		background: var(--bg-tertiary, #1f2937);
		border-radius: 4px;
		color: var(--text-secondary, #aaa);
	}

	.entry-meta {
		margin-top: 2rem;
		padding-top: 1rem;
		border-top: 1px solid var(--border-color, #2a2a4a);
		font-size: 0.8rem;
		color: var(--text-secondary, #666);
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
		color: var(--text-secondary, #888);
		margin-bottom: 1rem;
	}

	.start-writing-btn {
		padding: 0.75rem 1.5rem;
		background: var(--accent, #5865f2);
		color: white;
		border: none;
		border-radius: 8px;
		cursor: pointer;
		font-weight: 500;
		font-size: 1rem;
	}

	.start-writing-btn:hover {
		background: #4752c4;
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
	}
</style>
