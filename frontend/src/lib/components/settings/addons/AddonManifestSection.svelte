<script lang="ts">
	import { _ as t } from '$lib/i18n';
	import type { DetectedAddon } from '../addonDetection';

	/** Backend-enabled addons from GET /api/addons */
	export let backendAddons: DetectedAddon[] = [];
	/** Bundled frontend allowlist addons (youtube-sync, spotify-sync, …) */
	export let frontendAddons: DetectedAddon[] = [];
	export let addonsLastDetectedAt = '';
	export let addonsLoading = false;
	export let refreshAddonDetection: () => Promise<void>;
	/** Optional error string from last refresh */
	export let addonsError = '';
</script>

<div class="settings-section">
	<h3>{$t('settings.sections.addons')}</h3>

	<div class="setting-item-full">
		<div class="setting-info">
			<span class="setting-label">Server add-ons</span>
			<span class="setting-description">
				Add-ons are compiled into the server binary (feature flags). There is no runtime package
				install from this UI. Inventory comes from <code>GET /api/addons</code>.
			</span>
		</div>
		<div class="addons-actions">
			<button class="action-btn" on:click={refreshAddonDetection} disabled={addonsLoading}>
				{addonsLoading ? 'Refreshing…' : 'Refresh'}
			</button>
		</div>
		{#if addonsLastDetectedAt}
			<div class="runtime-note">Last refreshed: {addonsLastDetectedAt}</div>
		{/if}
		{#if addonsError}
			<div class="runtime-note addon-error">{addonsError}</div>
		{/if}
	</div>

	<div class="addons-runtime-grid">
		<div class="settings-section">
			<h3>Backend add-ons (this server)</h3>
			{#if addonsLoading && backendAddons.length === 0}
				<div class="runtime-note">Loading…</div>
			{:else if backendAddons.length === 0}
				<div class="runtime-note">
					No backend add-ons enabled in this server build. Enable Cargo features (e.g.
					<code>--features addons</code>) and restart the server.
				</div>
			{:else}
				<div class="addons-list">
					{#each backendAddons as addon (addon.id)}
						<div class="addon-row">
							<div class="addon-name">{addon.name}</div>
							<div class="addon-meta">id: {addon.id} · version: {addon.version}</div>
							<div class="addon-source">{addon.source}</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<div class="settings-section">
			<h3>Bundled frontend add-ons</h3>
			{#if frontendAddons.length === 0}
				<div class="runtime-note">
					No bundled frontend add-ons in this client build. Frontend modules load only via the
					static allowlist (never remote import).
				</div>
			{:else}
				<div class="addons-list">
					{#each frontendAddons as addon (addon.id + addon.source)}
						<div class="addon-row">
							<div class="addon-name">{addon.name}</div>
							<div class="addon-meta">id: {addon.id} · version: {addon.version}</div>
							<div class="addon-source">{addon.source}</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>
