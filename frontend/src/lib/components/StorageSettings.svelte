<script lang="ts">
	import { chatStorage, type RotationPeriod } from '$lib/storage';
	import { onMount } from 'svelte';

	let saveHistory = false;
	let rotationPeriod = chatStorage.getRotationPeriod();
	let maxArchives = chatStorage.getMaxArchives();
	let stats = { archives: [], totalSize: 0, totalMessages: 0 };

	function formatBytes(bytes: number): string {
		if (bytes === 0) return '0 B';
		const mb = bytes / (1024 * 1024);
		return mb >= 0.01 ? `${mb.toFixed(2)} MB` : `${(bytes / 1024).toFixed(2)} KB`;
	}

	function formatPeriod(period: string): string {
		if (period.includes('-W')) {
			const [year, week] = period.split('-W');
			return `Week ${week}, ${year}`;
		} else if (period.includes('-H')) {
			const [year, half] = period.split('-');
			return `${half === 'H1' ? 'First' : 'Second'} Half ${year}`;
		} else if (period.match(/^\d{4}-\d{2}$/)) {
			const [year, month] = period.split('-');
			const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
			return `${monthNames[parseInt(month) - 1]} ${year}`;
		} else {
			return `Year ${period}`;
		}
	}

	async function toggleStorage() {
		saveHistory = !saveHistory;
		await chatStorage.setEnabled(saveHistory);

		if (!saveHistory) {
			if (confirm('Disable local storage? Your saved history will remain until you clear it manually.')) {
				// Just disable, don't auto-delete
			} else {
				saveHistory = true;
				await chatStorage.setEnabled(true);
			}
		}
		await refreshStats();
	}

	async function updateRotationPeriod() {
		await chatStorage.setRotationPeriod(rotationPeriod);
		await refreshStats();
	}

	async function updateMaxArchives() {
		await chatStorage.setMaxArchives(maxArchives);
		await refreshStats();
	}

	async function deleteArchive(period: string) {
		if (confirm(`Delete archive "${formatPeriod(period)}"?`)) {
			await chatStorage.deleteArchive(period);
			await refreshStats();
		}
	}

	async function exportArchive(period: string) {
		await chatStorage.exportArchive(period);
	}

	async function exportAll() {
		await chatStorage.exportArchives();
	}

	async function clearAll() {
		if (confirm('Delete ALL saved chat history? This cannot be undone!')) {
			await chatStorage.clearAllHistory();
			await refreshStats();
		}
	}

	async function refreshStats() {
		stats = await chatStorage.getStats();
	}

	onMount(async () => {
		saveHistory = await chatStorage.isEnabled();
		await refreshStats();
	});
</script>

<div class="storage-settings">
	<div class="header">
		<h3>💾 Local Storage</h3>
		<p class="subtitle">Your chat history is saved only on your device. The server stores nothing permanently.</p>
	</div>

	<div class="setting-group">
		<label class="toggle-setting">
			<input type="checkbox" bind:checked={saveHistory} on:change={toggleStorage} />
			<span class="toggle-label">Save chat history locally</span>
		</label>
		<p class="hint">When enabled, messages are stored in your browser. You control your data.</p>
	</div>

	{#if saveHistory}
		<div class="stats-panel">
			<div class="stat">
				<div class="stat-label">Total Messages</div>
				<div class="stat-value">{stats.totalMessages.toLocaleString()}</div>
			</div>
			<div class="stat">
				<div class="stat-label">Storage Used</div>
				<div class="stat-value">{formatBytes(stats.totalSize)}</div>
			</div>
			<div class="stat">
				<div class="stat-label">Archives</div>
				<div class="stat-value">{stats.archives.length}</div>
			</div>
		</div>

		<div class="setting-group">
			<label>
				<span class="label">Rotation Period</span>
				<select bind:value={rotationPeriod} on:change={updateRotationPeriod}>
					<option value="week">Weekly</option>
					<option value="month">Monthly</option>
					<option value="half-year">Every 6 Months</option>
					<option value="year">Yearly</option>
				</select>
			</label>
			<p class="hint">How often to create a new archive file (like changing batteries)</p>
		</div>

		<div class="setting-group">
			<label>
				<span class="label">Keep Last</span>
				<div class="number-input-group">
					<input type="number" bind:value={maxArchives} on:change={updateMaxArchives} min="1" max="52" />
					<span class="unit">archives</span>
				</div>
			</label>
			<p class="hint">Older archives are automatically deleted to save space</p>
		</div>

		{#if stats.archives.length > 0}
			<div class="archives-section">
				<div class="section-header">
					<h4>Archive History</h4>
					<button class="btn-small" on:click={exportAll}>📦 Export All</button>
				</div>
				<div class="archive-list">
					{#each stats.archives as archive}
						<div class="archive-item">
							<div class="archive-info">
								<span class="archive-period">{formatPeriod(archive.period)}</span>
								<span class="archive-meta">
									{formatBytes(archive.size)} • {archive.messageCount.toLocaleString()} messages
								</span>
							</div>
							<div class="archive-actions">
								<button class="btn-icon" on:click={() => exportArchive(archive.period)} title="Export">
									💾
								</button>
								<button class="btn-icon danger" on:click={() => deleteArchive(archive.period)} title="Delete">
									🗑️
								</button>
							</div>
						</div>
					{/each}
				</div>
			</div>
		{:else}
			<div class="empty-state">
				<p>No archives yet. Messages will be saved as you chat.</p>
			</div>
		{/if}

		<div class="actions">
			<button class="btn-danger" on:click={clearAll}>
				🗑️ Clear All History
			</button>
		</div>
	{/if}
</div>

<style>
	.storage-settings {
		padding: 1.5rem;
		max-width: 700px;
	}

	.header {
		margin-bottom: 2rem;
	}

	.header h3 {
		font-size: 1.5rem;
		margin: 0 0 0.5rem 0;
	}

	.subtitle {
		color: var(--text-secondary);
		font-size: 0.9rem;
		margin: 0;
	}

	.setting-group {
		margin-bottom: 1.5rem;
		padding-bottom: 1.5rem;
		border-bottom: 1px solid var(--border);
	}

	.toggle-setting {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		cursor: pointer;
		font-weight: 500;
		font-size: 1.05rem;
	}

	.toggle-setting input[type="checkbox"] {
		width: 20px;
		height: 20px;
		cursor: pointer;
	}

	.hint {
		font-size: 0.85rem;
		color: var(--text-secondary);
		font-style: italic;
		margin: 0.5rem 0 0 0;
	}

	.stats-panel {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 1rem;
		margin-bottom: 1.5rem;
		padding: 1rem;
		background: var(--bg-tertiary);
		border-radius: 8px;
	}

	.stat {
		text-align: center;
	}

	.stat-label {
		font-size: 0.8rem;
		color: var(--text-secondary);
		margin-bottom: 0.25rem;
	}

	.stat-value {
		font-size: 1.5rem;
		font-weight: 600;
		color: var(--accent);
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.label {
		font-weight: 500;
		font-size: 0.95rem;
	}

	select {
		padding: 0.5rem;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--bg-primary);
		color: var(--text-primary);
		font-size: 0.95rem;
	}

	.number-input-group {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.number-input-group input {
		width: 80px;
		padding: 0.5rem;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--bg-primary);
		color: var(--text-primary);
	}

	.unit {
		color: var(--text-secondary);
		font-size: 0.9rem;
	}

	.archives-section {
		margin-top: 1.5rem;
	}

	.section-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1rem;
	}

	.section-header h4 {
		font-size: 1.1rem;
		margin: 0;
	}

	.archive-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.archive-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.75rem 1rem;
		background: var(--bg-tertiary);
		border-radius: 6px;
		border: 1px solid var(--border);
	}

	.archive-info {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.archive-period {
		font-weight: 600;
		font-size: 0.95rem;
	}

	.archive-meta {
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.archive-actions {
		display: flex;
		gap: 0.5rem;
	}

	.btn-icon {
		background: none;
		border: none;
		font-size: 1.2rem;
		cursor: pointer;
		padding: 0.25rem 0.5rem;
		border-radius: 4px;
		transition: background-color 0.2s;
	}

	.btn-icon:hover {
		background: rgba(0, 0, 0, 0.05);
	}

	.btn-icon.danger:hover {
		background: rgba(220, 38, 38, 0.1);
	}

	.btn-small {
		padding: 0.4rem 0.8rem;
		font-size: 0.85rem;
		background: var(--accent);
		color: white;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		transition: opacity 0.2s;
	}

	.btn-small:hover {
		opacity: 0.9;
	}

	.empty-state {
		text-align: center;
		padding: 2rem;
		color: var(--text-secondary);
		font-style: italic;
	}

	.actions {
		margin-top: 2rem;
		padding-top: 1.5rem;
		border-top: 1px solid var(--border);
	}

	.btn-danger {
		padding: 0.6rem 1.2rem;
		background: #dc2626;
		color: white;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		font-weight: 500;
		transition: background-color 0.2s;
	}

	.btn-danger:hover {
		background: #b91c1c;
	}
</style>
