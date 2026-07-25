<script lang="ts">
	import { chatStorage, type RotationPeriod, type StorageStats } from '$lib/storage';
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { _ } from '$lib/i18n';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import {
		isRunningInTauri,
		exportTauriDataAsZip,
		clearTauriData,
		getTauriDataPath
	} from '$lib/tauri-storage';
	import { currentUser } from '$lib/socket';
	import { getWabiDB } from '$lib/wabidb';
	import type { ScopeStatus, StorageReport } from '$lib/wabidb/types';

	let saveHistory = false;
	let rotationPeriod = chatStorage.getRotationPeriod();
	let maxArchives = chatStorage.getMaxArchives();
	let stats: StorageStats = { archives: [], totalSize: 0, totalMessages: 0 };

	let showDisableStorageConfirm = false;
	let showDeleteArchiveConfirm = false;
	let archiveToDelete = '';
	let showDeleteAllConfirm = false;

	// Tauri storage state
	let isTauri = false;
	let tauriStorageEnabled = false;
	let tauriDataPath = '';
	let tauriExporting = false;
	let showTauriClearConfirm = false;
	$: canClearSidecarData = $currentUser?.highestRole === 'owner' || $currentUser?.highestRole === 'admin';

	function t(key: string, values?: Record<string, unknown>): string {
		if (values) return get(_)(key, { values } as any);
		return get(_)(key);
	}

	function formatBytes(bytes: number): string {
		if (bytes === 0) return '0 B';
		const mb = bytes / (1024 * 1024);
		return mb >= 0.01 ? `${mb.toFixed(2)} MB` : `${(bytes / 1024).toFixed(2)} KB`;
	}

	let scopes: ScopeStatus[] = [];
	let queueCounts = { pending: 0, failed: 0, synced: 0 };
	let usage: StorageReport = { scopes: [], totalBytes: 0 };

	async function refreshQueue() {
		const db = getWabiDB();
		if (!db) return;
		const q = await db.listQueue();
		queueCounts = {
			pending: q.filter(x => x.status === 'pending').length,
			failed: q.filter(x => x.status === 'failed').length,
			synced: q.filter(x => x.status === 'synced').length,
		};
	}

	async function handleRetry() {
		const db = getWabiDB();
		if (!db) return;
		try {
			await db.retryFailed();
			await refreshQueue();
			alert(t('offline.alerts.retry_success'));
		} catch {
			alert(t('offline.alerts.retry_failed'));
		}
	}

	async function toggleScope(scopeId: string, enable: boolean) {
		const db = getWabiDB();
		if (!db) return;
		if (enable) {
			await db.enableScope(scopeId);
		} else {
			await db.disableScope(scopeId);
		}
		scopes = db.listScopes();
		await refreshQueue();
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
			showDisableStorageConfirm = true;
		} else {
			await refreshStats();
		}
	}

	async function confirmDisableStorage() {
		// Just disable, don't auto-delete
		showDisableStorageConfirm = false;
		await refreshStats();
	}

	function cancelDisableStorage() {
		saveHistory = true;
		chatStorage.setEnabled(true);
		showDisableStorageConfirm = false;
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
		archiveToDelete = period;
		showDeleteArchiveConfirm = true;
	}

	async function confirmDeleteArchive() {
		await chatStorage.deleteArchive(archiveToDelete);
		await refreshStats();
		showDeleteArchiveConfirm = false;
	}

	async function exportArchive(period: string) {
		await chatStorage.exportArchive(period);
	}

	async function exportAll() {
		await chatStorage.exportArchives();
	}

	async function clearAll() {
		showDeleteAllConfirm = true;
	}

	async function confirmClearAll() {
		await chatStorage.clearAllHistory();
		await refreshStats();
		showDeleteAllConfirm = false;
	}

	async function refreshStats() {
		stats = await chatStorage.getStats();
	}

	// Tauri data management functions
	async function exportTauriData() {
		if (!isTauri) return;
		tauriExporting = true;
		try {
			const zipPath = await exportTauriDataAsZip();
			alert(t('storage.alerts.export_success', { path: zipPath }));
		} catch (error) {
			alert(t('storage.alerts.export_failed', { error: String(error) }));
		} finally {
			tauriExporting = false;
		}
	}

	function confirmTauriClear() {
		if (!canClearSidecarData) {
			alert(t('storage.tauri.clear_admin_only'));
			return;
		}
		showTauriClearConfirm = true;
	}

	async function confirmClearTauriData() {
		try {
			await clearTauriData(canClearSidecarData);
			showTauriClearConfirm = false;
			alert(t('storage.alerts.tauri_clear_success'));
		} catch (error) {
			alert(t('storage.alerts.clear_failed', { error: String(error) }));
		}
	}

	async function toggleTauriStorage() {
		tauriStorageEnabled = !tauriStorageEnabled;
		try {
			localStorage.setItem('tauriStorageEnabled', String(tauriStorageEnabled));
			if (tauriStorageEnabled) {
				alert(t('storage.alerts.tauri_enabled'));
			} else {
				alert(t('storage.alerts.tauri_disabled'));
			}
		} catch (error) {
			console.error('Failed to save Tauri storage setting:', error);
			alert(t('storage.alerts.save_setting_failed'));
		}
	}

	onMount(async () => {
		isTauri = isRunningInTauri();
		if (isTauri) {
			try {
				tauriDataPath = await getTauriDataPath();
				// Load the stored setting
				const setting = localStorage.getItem('tauriStorageEnabled');
				tauriStorageEnabled = setting === 'true';
			} catch (error) {
				console.error('Failed to get Tauri data path:', error);
			}
		}

		saveHistory = await chatStorage.isEnabled();
		await refreshStats();

		const db = getWabiDB();
		if (db) {
			scopes = db.listScopes();
			await refreshQueue();
			usage = await db.getUsage();
		}
	});
</script>

<div class="storage-settings">
	{#if isTauri}
		<div class="tauri-section">
			<div class="header">
				<h3>🖥️ {$_('storage.tauri.title')}</h3>
				<p class="subtitle">
					{$_('storage.tauri.subtitle')}
					{#if tauriDataPath}
						<br />
						<code class="path">{tauriDataPath}</code>
					{/if}
				</p>
			</div>

			<div class="setting-group">
				<label class="toggle-setting">
					<input type="checkbox" bind:checked={tauriStorageEnabled} on:change={toggleTauriStorage} />
					<span class="toggle-label">{$_('storage.tauri.enable_toggle')}</span>
				</label>
				<p class="hint">
					{$_('storage.tauri.enable_hint')}
				</p>
			</div>

			{#if tauriStorageEnabled}
			<div class="setting-group">
				<div class="tauri-actions">
					<button
						class="btn-primary"
						on:click={exportTauriData}
						disabled={tauriExporting}
					>
						{tauriExporting ? $_('storage.tauri.exporting') : $_('storage.tauri.export_zip')}
					</button>
					<p class="hint">
						{$_('storage.tauri.export_hint')}
					</p>
				</div>
			</div>

			<div class="setting-group">
				<div class="tauri-actions">
					<button class="btn-danger" on:click={confirmTauriClear} disabled={!canClearSidecarData}>
						🗑️ {$_('storage.tauri.clear_all')}
					</button>
					<p class="hint">{$_('storage.tauri.clear_hint')}</p>
					{#if !canClearSidecarData}
						<p class="hint warning-hint">{$_('storage.tauri.clear_admin_only')}</p>
					{/if}
				</div>
			</div>
			{/if}
		</div>

		<div class="divider"></div>
	{/if}

	<div class="header">
		<h3>💾 {$_('storage.browser.title')}</h3>
		<p class="subtitle">{$_('storage.browser.subtitle')}</p>
	</div>

	<div class="setting-group">
		<label class="toggle-setting">
			<input type="checkbox" bind:checked={saveHistory} on:change={toggleStorage} />
			<span class="toggle-label">{$_('storage.browser.save_toggle')}</span>
		</label>
		<p class="hint">{$_('storage.browser.save_hint')}</p>
	</div>

	{#if saveHistory}
		<div class="stats-panel">
			<div class="stat">
				<div class="stat-label">{$_('storage.stats.total_messages')}</div>
				<div class="stat-value">{stats.totalMessages.toLocaleString()}</div>
			</div>
			<div class="stat">
				<div class="stat-label">{$_('storage.stats.storage_used')}</div>
				<div class="stat-value">{formatBytes(stats.totalSize)}</div>
			</div>
			<div class="stat">
				<div class="stat-label">{$_('storage.stats.archives')}</div>
				<div class="stat-value">{stats.archives.length}</div>
			</div>
		</div>

		<div class="setting-group">
			<label>
				<span class="label">{$_('storage.browser.rotation_period')}</span>
				<select bind:value={rotationPeriod} on:change={updateRotationPeriod}>
					<option value="week">{$_('storage.rotation.weekly')}</option>
					<option value="month">{$_('storage.rotation.monthly')}</option>
					<option value="half-year">{$_('storage.rotation.half_year')}</option>
					<option value="year">{$_('storage.rotation.yearly')}</option>
				</select>
			</label>
			<p class="hint">{$_('storage.browser.rotation_hint')}</p>
		</div>

		<div class="setting-group">
			<label>
				<span class="label">{$_('storage.browser.keep_last')}</span>
				<div class="number-input-group">
					<input type="number" bind:value={maxArchives} on:change={updateMaxArchives} min="1" max="52" />
					<span class="unit">{$_('storage.browser.archives_unit')}</span>
				</div>
			</label>
			<p class="hint">{$_('storage.browser.keep_last_hint')}</p>
		</div>

		{#if stats.archives.length > 0}
			<div class="archives-section">
				<div class="section-header">
					<h4>{$_('storage.browser.archive_history')}</h4>
					<button class="btn-small" on:click={exportAll}>📦 {$_('storage.actions.export_all')}</button>
				</div>
				<div class="archive-list">
					{#each stats.archives as archive}
						<div class="archive-item">
							<div class="archive-info">
								<span class="archive-period">{formatPeriod(archive.period)}</span>
								<span class="archive-meta">
									{$_('storage.browser.archive_meta', { values: { size: formatBytes(archive.size), count: archive.messageCount.toLocaleString() } })}
								</span>
							</div>
							<div class="archive-actions">
								<button class="btn-icon" on:click={() => exportArchive(archive.period)} title={$_('storage.actions.export')}>
									💾
								</button>
								<button class="btn-icon danger" on:click={() => deleteArchive(archive.period)} title={$_('storage.actions.delete')}>
									🗑️
								</button>
							</div>
						</div>
					{/each}
				</div>
			</div>
		{:else}
			<div class="empty-state">
				<p>{$_('storage.browser.no_archives')}</p>
			</div>
		{/if}

		<div class="actions">
			<button class="btn-danger" on:click={clearAll}>
				🗑️ {$_('storage.actions.clear_all_history')}
			</button>
		</div>
	{/if}

	<div class="divider"></div>

	<div class="offline-section">
		<div class="header">
			<h3>🌐 {$_('offline.title')}</h3>
			<p class="subtitle">{$_('offline.subtitle')}</p>
		</div>

		{#if scopes.length > 0}
			<div class="setting-group">
				<span class="label">{$_('offline.wabiDB.scope_label')}</span>
				{#each scopes as scope}
					<div class="scope-item">
						<span class="scope-name">{scope.name}</span>
						<span class="badge">
							{#if scope.userControl === 'always'}
								{$_('offline.scopes.always_on')}
							{:else if scope.userControl === 'opt-in'}
								{$_('offline.scopes.opt_in')}
							{:else}
								{$_('offline.scopes.off')}
							{/if}
						</span>
						{#if scope.userControl === 'always'}
							<button class="btn-small" disabled>{$_('offline.scopes.always_on')}</button>
						{:else if scope.enabled}
							<button class="btn-small" on:click={() => toggleScope(scope.scopeId, false)}>{$_('offline.scopes.disable')}</button>
						{:else}
							<button class="btn-small" on:click={() => toggleScope(scope.scopeId, true)}>{$_('offline.scopes.enable')}</button>
						{/if}
					</div>
				{/each}
			</div>
		{/if}

		<div class="setting-group">
			<span class="label">{$_('offline.wabiDB.queue_label')}</span>
			<p>
				{$_('offline.wabiDB.pending')}: {queueCounts.pending} |
				{$_('offline.wabiDB.failed')}: {queueCounts.failed} |
				{$_('offline.wabiDB.synced')}: {queueCounts.synced}
			</p>
		</div>

		<div class="setting-group">
			<button class="btn-primary" on:click={handleRetry}>
				{$_('offline.retry.button')}
			</button>
		</div>

		<div class="setting-group">
			<span class="label">{$_('offline.wabiDB.usage_label')}</span>
			<p>{formatBytes(usage.totalBytes)}</p>
		</div>
	</div>
</div>

<ConfirmDialog
	isOpen={showDisableStorageConfirm}
	title={$_('storage.confirm.disable_local_title')}
	message={$_('storage.confirm.disable_local_message')}
	confirmText={$_('storage.confirm.disable_local_confirm')}
	variant="warning"
	onConfirm={confirmDisableStorage}
	onCancel={cancelDisableStorage}
/>

<ConfirmDialog
	isOpen={showDeleteArchiveConfirm}
	title={$_('storage.confirm.delete_archive_title')}
	message={$_('storage.confirm.delete_archive_message', { values: { period: formatPeriod(archiveToDelete) } })}
	confirmText={$_('storage.confirm.delete_archive_confirm')}
	variant="danger"
	onConfirm={confirmDeleteArchive}
	onCancel={() => showDeleteArchiveConfirm = false}
/>

<ConfirmDialog
	isOpen={showDeleteAllConfirm}
	title={$_('storage.confirm.delete_all_title')}
	message={$_('storage.confirm.delete_all_message')}
	confirmText={$_('storage.confirm.delete_all_confirm')}
	variant="danger"
	onConfirm={confirmClearAll}
	onCancel={() => showDeleteAllConfirm = false}
/>

{#if isTauri}
	<ConfirmDialog
		isOpen={showTauriClearConfirm}
		title={$_('storage.confirm.clear_tauri_title')}
		message={$_('storage.confirm.clear_tauri_message')}
		confirmText={$_('storage.confirm.clear_tauri_confirm')}
		variant="danger"
		onConfirm={confirmClearTauriData}
		onCancel={() => (showTauriClearConfirm = false)}
	/>
{/if}

