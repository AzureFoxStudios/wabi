<script lang="ts">
	import { _ } from '$lib/i18n';
	import type { GameScreenshotDirectoryCandidate } from '$lib/gameScreenshotPipe';

	export let scopeId = '';
	export let scopeKey = '';
	export let selectedAlbumId: number | null = null;
	export let enabled = false;
	export let folderPath = '';
	export let candidates: GameScreenshotDirectoryCandidate[] = [];
	export let isLoadingCandidates = false;
	export let isScanning = false;
	export let targetAlbumId: number | null = null;
	export let targetAlbumName = '';
	export let statusMessage = '';
	export let errorMessage = '';
	export let onPersistSettings: () => void = () => {};
	export let onScanNow: () => void = () => {};
	export let onUseDetectedFolder: () => void = () => {};
	export let onSetTargetFromSelectedAlbum: () => void = () => {};
	export let onClearTarget: () => void = () => {};

	$: existingCandidates = candidates.filter((candidate) => candidate.exists).slice(0, 5);
</script>

<div class="screenshot-pipe-panel">
	<div class="screenshot-pipe-panel__header">
		<div class="screenshot-pipe-panel__copy">
			<strong>{$_('ssp.title')}</strong>
			<span>{$_('ssp.hint')}</span>
		</div>
		<div class="screenshot-pipe-panel__actions">
			<button
				type="button"
				class:active={enabled}
				on:click={() => {
					enabled = !enabled;
					onPersistSettings();
				}}
				disabled={!scopeId}
			>
				{enabled ? $_('server_policy.enabled') : $_('ssp.disabled')}
			</button>
			<button
				type="button"
				on:click={onScanNow}
				disabled={!scopeId || !enabled || !targetAlbumId || isScanning}
			>
				{isScanning ? $_('ssp.scanning') : $_('ssp.scan_now')}
			</button>
		</div>
	</div>
	<div class="screenshot-pipe-panel__row">
		<input
			type="text"
			bind:value={folderPath}
			placeholder={$_('ssp.folder_ph')}
			on:change={onPersistSettings}
			disabled={!scopeId}
		/>
		<button
			type="button"
			on:click={onUseDetectedFolder}
			disabled={!scopeId || isLoadingCandidates}
		>
			{isLoadingCandidates ? $_('ssp.detecting') : $_('ssp.detect')}
		</button>
	</div>
	<div class="screenshot-pipe-panel__row">
		<button
			type="button"
			on:click={onSetTargetFromSelectedAlbum}
			disabled={!scopeKey || !selectedAlbumId}
		>
			{$_('ssp.pipe')}
		</button>
		<button
			type="button"
			on:click={onClearTarget}
			disabled={!scopeKey || targetAlbumId === null}
		>
			{$_('ssp.clear')}
		</button>
	</div>
	<div class="screenshot-pipe-panel__meta">
		<span>
			{#if targetAlbumId}
				{$_('ssp.target', { values: { name: targetAlbumName || `#${targetAlbumId}` } })}
			{:else}
				{$_('ssp.no_target')}
			{/if}
		</span>
		<span>{folderPath || $_('ssp.no_folder')}</span>
	</div>
	{#if existingCandidates.length > 0}
		<div class="screenshot-pipe-candidates">
			{#each existingCandidates as candidate}
				<button
					type="button"
					class="screenshot-pipe-candidate"
					on:click={() => {
						folderPath = candidate.path;
						onPersistSettings();
					}}
				>
					{candidate.label}
				</button>
			{/each}
		</div>
	{/if}
	{#if statusMessage}
		<div class="success-banner">{statusMessage}</div>
	{/if}
	{#if errorMessage}
		<div class="error-banner">{errorMessage}</div>
	{/if}
</div>
