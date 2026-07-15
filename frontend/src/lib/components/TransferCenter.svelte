<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import {
		activeTransfers,
		incomingFileOffers,
		transferHistory,
		transferSettings,
		acceptFileTransfer,
		rejectFileTransfer,
		cancelTransfer,
		pauseTransfer,
		resumeTransfer,
		restartTransfer,
		type IncomingFileOffer,
		type TransferSettings
	} from '$lib/p2pFileTransfer';
	import TransferCard from './TransferCard.svelte';
	import { getSocket } from '$lib/socket';

	const dispatch = createEventDispatcher();

	let activeTab: 'incoming' | 'active' | 'outgoing' | 'history' | 'settings' = 'incoming';

	$: incoming = $incomingFileOffers;
	$: active = $activeTransfers;
	$: history = $transferHistory;
	$: settings = $transferSettings;

	$: incomingCount = incoming.length;
	$: activeCount = active.filter(
		(t) => t.status !== 'complete' && t.status !== 'cancelled' && t.status !== 'failed'
	).length;
	$: outgoing = active.filter((t) => t.direction === 'send');
	$: activeQueue = active.filter(
		(t) =>
			t.direction === 'receive' &&
			t.status !== 'complete' &&
			t.status !== 'cancelled' &&
			t.status !== 'failed'
	);
	$: badgeCount = incomingCount + activeCount;

	// If there are incoming offers, default to the incoming tab
	$: if (incomingCount > 0 && activeTab === 'active') {
		activeTab = 'incoming';
	}

	function formatBytes(bytes: number): string {
		if (bytes === 0) return '0 B';
		const units = ['B', 'KB', 'MB', 'GB', 'TB'];
		const i = Math.floor(Math.log(bytes) / Math.log(1024));
		const val = bytes / Math.pow(1024, i);
		return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
	}

	async function handleAccept(offer: IncomingFileOffer) {
		const socket = getSocket();
		if (!socket) return;
		await acceptFileTransfer(socket, offer.transferId);
	}

	function handleReject(offer: IncomingFileOffer) {
		rejectFileTransfer(offer.transferId);
	}

	function handleCancel(transferId: string) {
		cancelTransfer(transferId);
	}

	function handlePause(transferId: string) {
		pauseTransfer(transferId);
	}

	function handleResume(transferId: string) {
		resumeTransfer(transferId);
	}

	function handleRestart(transferId: string) {
		restartTransfer(transferId, getSocket());
	}

	function handleSettingsChange(field: keyof TransferSettings, value: boolean | number) {
		transferSettings.update((s) => ({ ...s, [field]: value }));
	}
</script>

<div class="transfer-center">
	<div class="tc-header">
		<span class="tc-title">Transfers</span>
		{#if badgeCount > 0}
			<span class="tc-badge">{badgeCount > 99 ? '99+' : badgeCount}</span>
		{/if}
	</div>

	<div class="tc-tabs" role="tablist">
		<button
			type="button"
			role="tab"
			aria-selected={activeTab === 'incoming'}
			class:active={activeTab === 'incoming'}
			on:click={() => (activeTab = 'incoming')}
		>
			Incoming
			{#if incomingCount > 0}<span class="tab-badge">{incomingCount}</span>{/if}
		</button>
		<button
			type="button"
			role="tab"
			aria-selected={activeTab === 'active'}
			class:active={activeTab === 'active'}
			on:click={() => (activeTab = 'active')}
		>
			Active
			{#if activeCount > 0}<span class="tab-badge">{activeCount}</span>{/if}
		</button>
		<button
			type="button"
			role="tab"
			aria-selected={activeTab === 'outgoing'}
			class:active={activeTab === 'outgoing'}
			on:click={() => (activeTab = 'outgoing')}
		>
			Outgoing
		</button>
		<button
			type="button"
			role="tab"
			aria-selected={activeTab === 'history'}
			class:active={activeTab === 'history'}
			on:click={() => (activeTab = 'history')}
		>
			History
		</button>
		<button
			type="button"
			role="tab"
			aria-selected={activeTab === 'settings'}
			class:active={activeTab === 'settings'}
			on:click={() => (activeTab = 'settings')}
			title="Transfer settings"
		>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<circle cx="12" cy="12" r="3"></circle>
				<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 0 1 7.12 4.3l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.31.21.65.21 1h.39a2 2 0 0 1 0 4h-.39c0 .35-.07.69-.21 1z"></path>
			</svg>
		</button>
	</div>

	<div class="tc-content">
		{#if activeTab === 'incoming'}
			{#if incoming.length === 0}
				<div class="tc-empty">No incoming file offers.</div>
			{:else}
				{#each incoming as offer (offer.transferId)}
					<div class="tc-offer-card">
						<div class="offer-info">
							<span class="offer-icon">
								<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
									<polyline points="14 2 14 8 20 8"></polyline>
								</svg>
							</span>
							<div class="offer-details">
								<strong class="offer-filename">{offer.fileName}</strong>
								<span class="offer-meta">{formatBytes(offer.fileSize)} &middot; from {offer.senderUsername}</span>
							</div>
						</div>
						<div class="offer-actions">
							<button type="button" class="btn-accept" on:click={() => handleAccept(offer)} title="Accept and download">Download</button>
							<button type="button" class="btn-reject" on:click={() => handleReject(offer)} title="Decline offer">Reject</button>
						</div>
					</div>
				{/each}
			{/if}

		{:else if activeTab === 'active'}
			{#if activeQueue.length === 0}
				<div class="tc-empty">No active incoming transfers.</div>
			{:else}
				{#each activeQueue as transfer (transfer.id)}
					<TransferCard {transfer} on:cancel={() => handleCancel(transfer.id)} on:pause={() => handlePause(transfer.id)} on:resume={() => handleResume(transfer.id)} on:restart={() => handleRestart(transfer.id)} />
				{/each}
			{/if}

		{:else if activeTab === 'outgoing'}
			{#if outgoing.length === 0}
				<div class="tc-empty">No outgoing transfers.</div>
			{:else}
				{#each outgoing as transfer (transfer.id)}
					<TransferCard {transfer} on:cancel={() => handleCancel(transfer.id)} on:pause={() => handlePause(transfer.id)} on:resume={() => handleResume(transfer.id)} on:restart={() => handleRestart(transfer.id)} />
				{/each}
			{/if}

		{:else if activeTab === 'history'}
			{#if history.length === 0}
				<div class="tc-empty">No transfer history.</div>
			{:else}
				{#each history as entry (entry.transfer.id + entry.completedAt)}
					<TransferCard transfer={entry.transfer} on:restart={() => handleRestart(entry.transfer.id)} />
				{/each}
			{/if}

		{:else if activeTab === 'settings'}
			<div class="tc-settings">
				<h3 class="settings-heading">Transfer Settings</h3>
				<p class="settings-note">Local preferences only — server policy not yet implemented.</p>

				<label class="setting-row">
					<span>Ask before accepting files</span>
					<input type="checkbox" checked={settings.askEveryTime} on:change={(e) => handleSettingsChange('askEveryTime', e.currentTarget.checked)} />
				</label>

				<label class="setting-row">
					<span>Auto-accept from trusted users</span>
					<input type="checkbox" checked={settings.autoAcceptTrusted} on:change={(e) => handleSettingsChange('autoAcceptTrusted', e.currentTarget.checked)} />
				</label>

				<label class="setting-row">
					<span>Max simultaneous downloads</span>
					<input type="number" min="1" max="10" value={settings.maxSimultaneousDownloads} on:change={(e) => handleSettingsChange('maxSimultaneousDownloads', Math.max(1, Math.min(10, parseInt(e.currentTarget.value) || 1)))} />
				</label>

				<label class="setting-row">
					<span>Max simultaneous uploads</span>
					<input type="number" min="1" max="10" value={settings.maxSimultaneousUploads} on:change={(e) => handleSettingsChange('maxSimultaneousUploads', Math.max(1, Math.min(10, parseInt(e.currentTarget.value) || 1)))} />
				</label>

				<details class="settings-details">
					<summary>Trusted users (auto-accept list)</summary>
					<div class="trusted-list">
						{#if settings.autoAcceptUsers.length === 0}
							<span class="trusted-empty">No trusted users configured.</span>
						{:else}
							{#each settings.autoAcceptUsers as userId}
								<span class="trusted-user">{userId}</span>
							{/each}
						{/if}
					</div>
				</details>
			</div>
		{/if}
	</div>
</div>

<style>
	.transfer-center {
		display: flex;
		flex-direction: column;
		height: 100%;
		padding: 0.6rem;
		gap: 0.55rem;
		font-size: 0.8rem;
		overflow: hidden;
	}

	.tc-header {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.25rem 0.35rem;
	}

	.tc-title {
		font-weight: 700;
		font-size: 0.85rem;
		color: var(--text-heading);
	}

	.tc-badge {
		min-width: 18px;
		height: 18px;
		padding: 0 5px;
		border-radius: 999px;
		background: var(--accent-primary-color);
		color: var(--text-inverse, #fff);
		font-size: 0.65rem;
		font-weight: 700;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		line-height: 1;
	}

	.tc-tabs {
		display: flex;
		gap: 0.2rem;
		padding: 0.15rem 0;
		border-bottom: 1px solid var(--border-subtle);
		overflow-x: auto;
		flex-shrink: 0;
	}

	.tc-tabs button {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.3rem 0.55rem;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: var(--text-secondary);
		font-size: 0.72rem;
		font-weight: 600;
		cursor: pointer;
		white-space: nowrap;
		transition: background 0.15s, color 0.15s;
	}

	.tc-tabs button:hover {
		background: rgba(var(--accent-rgb), 0.08);
		color: var(--text-heading);
	}

	.tc-tabs button.active {
		background: rgba(var(--accent-rgb), 0.15);
		color: var(--accent-primary-color);
	}

	.tab-badge {
		min-width: 16px;
		height: 16px;
		padding: 0 4px;
		border-radius: 999px;
		background: var(--color-danger, #ef4444);
		color: var(--text-inverse, #fff);
		font-size: 0.6rem;
		font-weight: 700;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.tc-content {
		flex: 1;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		min-height:0;
	}

	.tc-empty {
		padding: 1.5rem 0.5rem;
		text-align: center;
		color: var(--text-tertiary, var(--text-secondary));
		font-size: 0.75rem;
	}

	.tc-offer-card {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 0.5rem;
		border-radius: 8px;
		background: rgba(var(--accent-rgb), 0.06);
		border: 1px solid rgba(var(--accent-rgb), 0.15);
	}

	.offer-info {
		display: flex;
		align-items: flex-start;
		gap: 0.45rem;
	}

	.offer-icon {
		flex-shrink: 0;
		width: 20px;
		height: 20px;
		color: var(--accent-primary-color);
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.offer-details {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-width: 0;
	}

	.offer-filename {
		font-size: 0.8rem;
		color: var(--text-heading);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.offer-meta {
		font-size: 0.68rem;
		color: var(--text-secondary);
	}

	.offer-actions {
		display: flex;
		gap: 0.35rem;
	}

	.btn-accept, .btn-reject {
		flex: 1;
		padding: 0.35rem 0.5rem;
		border-radius: 6px;
		border: none;
		font-size: 0.72rem;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.15s;
	}

	.btn-accept {
		background: var(--accent-primary-color);
		color: var(--text-inverse, #fff);
	}

	.btn-accept:hover {
		filter: brightness(1.1);
	}

	.btn-reject {
		background: transparent;
		color: var(--text-secondary);
		border: 1px solid var(--border-subtle);
	}

	.btn-reject:hover {
		background: rgba(var(--color-danger-rgb, 239, 68, 68), 0.1);
		color: var(--color-danger, #ef4444);
		border-color: rgba(var(--color-danger-rgb, 239, 68, 68), 0.3);
	}

	.tc-settings {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.25rem;
	}

	.settings-heading {
		font-size: 0.85rem;
		font-weight: 700;
		color: var(--text-heading);
		margin: 0;
	}

	.settings-note {
		font-size: 0.68rem;
		color: var(--text-tertiary, var(--text-secondary));
		margin: 0;
	}

	.setting-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.35rem 0;
		border-bottom: 1px solid var(--border-subtle);
		font-size: 0.75rem;
		color: var(--text-heading);
		cursor: pointer;
	}

	.setting-row input[type="checkbox"] {
		accent-color: var(--accent-primary-color);
	}

	.setting-row input[type="number"] {
		width: 56px;
		padding: 0.2rem 0.3rem;
		border-radius: 5px;
		border: 1px solid var(--border-subtle);
		background: var(--surface-base);
		color: var(--text-heading);
		font-size: 0.75rem;
		text-align: center;
	}

	.settings-details {
		font-size: 0.75rem;
	}

	.settings-details summary {
		cursor: pointer;
		color: var(--text-secondary);
		padding: 0.3rem 0;
	}

	.settings-details summary:hover {
		color: var(--text-heading);
	}

	.trusted-list {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
		padding: 0.4rem 0;
	}

	.trusted-user {
		padding: 0.15rem 0.4rem;
		border-radius: 4px;
		background: rgba(var(--accent-rgb), 0.1);
		color: var(--accent-primary-color);
		font-size: 0.68rem;
	}

	.trusted-empty {
		color: var(--text-tertiary, var(--text-secondary));
		font-size: 0.7rem;
	}
</style>
