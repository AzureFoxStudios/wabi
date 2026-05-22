<script lang="ts">
	import { _ as t } from '$lib/i18n';
	import type { DetectedAddon } from '../addonDetection';

	export let frontendAddons: DetectedAddon[] = [];
	export let backendAddons: DetectedAddon[] = [];
	export let addonsLastDetectedAt = '';
	export let addonsLoading = false;
	export let addonInstallLoading = false;
	export let addonInstallStatus = '';
	export let addonsImportPreview: { importedAt?: string; frontend?: unknown[]; backend?: unknown[] } | null = null;
	export let addonsImportInput: HTMLInputElement;
	export let addonsPackageInput: HTMLInputElement;
	export let refreshAddonDetection: () => Promise<void>;
	export let exportAddonManifest: () => void;
	export let triggerAddonImport: () => void;
	export let triggerAddonPackageInstall: () => void;
	export let importAddonManifest: (event: Event) => Promise<void>;
	export let installAddonPackage: (event: Event) => Promise<void>;
</script>

<div class="settings-section">
	<h3>{$t('settings.sections.addons')}</h3>
	<div class="setting-item-full">
		<div class="setting-info">
			<span class="setting-label">Import / Export Add-ons Manifest</span>
			<span class="setting-description">Export a snapshot of detected frontend/backend add-ons, or import a saved manifest for comparison.</span>
		</div>
		<div class="addons-actions">
			<button class="action-btn export" on:click={exportAddonManifest}>Export Add-ons JSON</button>
			<button class="action-btn import" on:click={triggerAddonImport}>Import Add-ons JSON</button>
			<button class="action-btn install" on:click={triggerAddonPackageInstall} disabled={addonInstallLoading}>
				{addonInstallLoading ? 'Installing Plugin...' : 'Install Plugin Package'}
			</button>
			<button class="action-btn" on:click={refreshAddonDetection} disabled={addonsLoading}>
				{addonsLoading ? 'Detecting...' : 'Refresh Detection'}
			</button>
		</div>
		<input
			type="file"
			accept=".json,application/json"
			bind:this={addonsImportInput}
			on:change={importAddonManifest}
			class="hidden"
		/>
		<input
			type="file"
			accept=".zip,.wabi-plugin,.wabip,application/zip,application/x-zip-compressed"
			bind:this={addonsPackageInput}
			on:change={installAddonPackage}
			class="hidden"
		/>
		{#if addonsLastDetectedAt}
			<div class="runtime-note">Last detected: {addonsLastDetectedAt}</div>
		{/if}
		{#if addonInstallStatus}
			<div class="runtime-note">{addonInstallStatus}</div>
		{/if}
		{#if addonsImportPreview}
			<div class="runtime-note">
				Imported manifest
				{#if addonsImportPreview.importedAt}
					from {new Date(addonsImportPreview.importedAt).toLocaleString()}
				{/if}
				(frontend: {addonsImportPreview.frontend?.length || 0}, backend: {addonsImportPreview.backend?.length || 0})
			</div>
		{/if}
	</div>

	<div class="addons-runtime-grid">
		<div class="settings-section">
			<h3>Frontend Add-ons (Detected)</h3>
			{#if frontendAddons.length === 0}
				<div class="runtime-note">No frontend add-ons detected.</div>
			{:else}
				<div class="addons-list">
					{#each frontendAddons as addon (addon.id + addon.source)}
						<div class="addon-row">
							<div class="addon-name">{addon.name}</div>
							<div class="addon-meta">id: {addon.id} - version: {addon.version}</div>
							<div class="addon-source">{addon.source}</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<div class="settings-section">
			<h3>Backend Add-ons (Detected)</h3>
			{#if backendAddons.length === 0}
				<div class="runtime-note">No backend add-ons detected (or plugin API access is unavailable for this account/session).</div>
			{:else}
				<div class="addons-list">
					{#each backendAddons as addon (addon.id + addon.version)}
						<div class="addon-row">
							<div class="addon-name">{addon.name}</div>
							<div class="addon-meta">id: {addon.id} - version: {addon.version}</div>
							<div class="addon-source">{addon.source}</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>
