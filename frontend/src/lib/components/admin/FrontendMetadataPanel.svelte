<script lang="ts">
	import type { FrontendAppMetadataPolicy } from '$lib/api';

	export let frontendAppMetadata: FrontendAppMetadataPolicy;
	export let publishedFrontendAppMetadata: FrontendAppMetadataPolicy;
	export let frontendMetadataLoading: boolean;
	export let frontendMetadataSaving: boolean;
	export let frontendMetadataError: string;
	export let frontendMetadataSaveStatus: string;
	export let frontendMetadataUploadTarget: 'icon' | 'banner' | null;
	export let onMetadataChange: (metadata: FrontendAppMetadataPolicy) => void;
	export let onSave: () => void;
	export let onDiscard: () => void;
	export let onTriggerUpload: (target: 'icon' | 'banner') => void;
	export let resolveFrontendMetadataAssetUrl: (url: string | null | undefined) => string | null;

	let iconInput: HTMLInputElement | null = null;
	let bannerInput: HTMLInputElement | null = null;
</script>

<div class="admin-section">
	<div class="compression-header">
		<h4>Frontend App Metadata</h4>
		<div class="compression-actions">
			{#if frontendMetadataDirty}
				<button class="admin-btn" disabled={frontendMetadataSaving} on:click={onDiscard}>Discard</button>
			{/if}
			<button class="admin-btn" disabled={frontendMetadataSaving} on:click={onSave}>
				{frontendMetadataSaving ? 'Saving...' : 'Save'}
			</button>
		</div>
	</div>

	{#if frontendMetadataError}
		<div class="admin-empty">{frontendMetadataError}</div>
	{:else}
		<div class="runtime-hint frontend-metadata-status">
			{#if frontendMetadataDirty}
				Preview is showing your unsaved changes. Save to publish them, or discard them.
			{:else}
				Preview is showing the current live shell branding.
			{/if}
		</div>

		<div class="runtime-form-grid">
			<label>
				Display Name
				<input type="text" value={frontendAppMetadata.displayName || ''} placeholder="What users see in the app shell" on:input={(e) => onMetadataChange({ ...frontendAppMetadata, displayName: (e.currentTarget as HTMLInputElement).value || null })} />
			</label>
			<label>
				Accent Color
				<input type="text" value={frontendAppMetadata.accentColor || ''} placeholder="#2dd4bf" on:input={(e) => onMetadataChange({ ...frontendAppMetadata, accentColor: (e.currentTarget as HTMLInputElement).value || null })} />
			</label>
			<label class="frontend-metadata-wide">
				Description
				<input type="text" value={frontendAppMetadata.description || ''} placeholder="Short line for the server switcher banner" on:input={(e) => onMetadataChange({ ...frontendAppMetadata, description: (e.currentTarget as HTMLInputElement).value || null })} />
			</label>
			<details class="frontend-metadata-manual frontend-metadata-wide">
				<summary>Advanced asset URLs</summary>
				<div class="frontend-metadata-manual-grid">
					<label>
						Icon URL
						<input type="text" value={frontendAppMetadata.iconUrl || ''} placeholder="/uploads/server-icon.webp" on:input={(e) => onMetadataChange({ ...frontendAppMetadata, iconUrl: (e.currentTarget as HTMLInputElement).value || null })} />
					</label>
					<label>
						Banner URL
						<input type="text" value={frontendAppMetadata.bannerUrl || ''} placeholder="/uploads/server-banner.webp" on:input={(e) => onMetadataChange({ ...frontendAppMetadata, bannerUrl: (e.currentTarget as HTMLInputElement).value || null })} />
					</label>
				</div>
			</details>
			<label class="runtime-checkbox frontend-metadata-wide">
				<input type="checkbox" checked={frontendAppMetadata.launchPageFallbackEnabled} on:change={(e) => onMetadataChange({ ...frontendAppMetadata, launchPageFallbackEnabled: (e.currentTarget as HTMLInputElement).checked })} />
				Use login launch-page branding as fallback when metadata fields are empty
			</label>
		</div>

		<div class="frontend-metadata-upload-row">
			<input
				bind:this={iconInput}
				type="file"
				accept="image/png,image/jpeg,image/gif,image/webp"
				class="frontend-metadata-hidden-input"
				on:change={(event) => onTriggerUpload('icon')}
			/>
			<input
				bind:this={bannerInput}
				type="file"
				accept="image/png,image/jpeg,image/gif,image/webp"
				class="frontend-metadata-hidden-input"
				on:change={(event) => onTriggerUpload('banner')}
			/>
			<button
				type="button"
				class="admin-btn"
				disabled={frontendMetadataUploadTarget !== null}
				on:click={() => iconInput?.click()}
			>
				{frontendMetadataUploadTarget === 'icon' ? 'Uploading Icon...' : 'Upload Icon'}
			</button>
			<button
				type="button"
				class="admin-btn"
				disabled={frontendMetadataUploadTarget !== null}
				on:click={() => bannerInput?.click()}
			>
				{frontendMetadataUploadTarget === 'banner' ? 'Uploading Banner...' : 'Upload Banner'}
			</button>
		</div>

		{#if frontendMetadataSaveStatus}
			<div class="runtime-hint">{frontendMetadataSaveStatus}</div>
		{/if}

		<div class="frontend-metadata-preview-shell">
			<div class="frontend-metadata-preview-label">
				<strong>Preview</strong>
				<span>
					{frontendMetadataDirty
						? 'This is what will publish when you save.'
						: 'This is what the shell is showing right now.'}
				</span>
			</div>

			<div class="frontend-metadata-preview" style:--metadata-accent={frontendAppMetadata.accentColor || '#2dd4bf'}>
				{#if resolveFrontendMetadataAssetUrl(frontendAppMetadata.bannerUrl)}
					<img
						src={resolveFrontendMetadataAssetUrl(frontendAppMetadata.bannerUrl) || undefined}
						alt={frontendAppMetadata.displayName || 'Server banner'}
						class="frontend-metadata-preview-banner"
					/>
				{/if}
				<div class="frontend-metadata-preview-copy">
					<div class="frontend-metadata-preview-avatar">
						{#if resolveFrontendMetadataAssetUrl(frontendAppMetadata.iconUrl)}
							<img src={resolveFrontendMetadataAssetUrl(frontendAppMetadata.iconUrl) || undefined} alt={frontendAppMetadata.displayName || 'Server icon'} />
						{:else}
							<span>{(frontendAppMetadata.displayName || 'W').charAt(0).toUpperCase()}</span>
						{/if}
					</div>
					<div>
						<strong>{frontendAppMetadata.displayName || 'Client display name preview'}</strong>
						<span>{frontendAppMetadata.description || 'This controls what the Wabi frontend shows in the rail, header, and switcher.'}</span>
					</div>
				</div>
			</div>
		</div>
	{/if}
</div>

<script lang="ts">
	function frontendMetadataMatches(
		left: FrontendAppMetadataPolicy,
		right: FrontendAppMetadataPolicy
	): boolean {
		return (
			left.displayName === right.displayName &&
			left.iconUrl === right.iconUrl &&
			left.bannerUrl === right.bannerUrl &&
			left.accentColor === right.accentColor &&
			left.description === right.description &&
			left.launchPageFallbackEnabled === right.launchPageFallbackEnabled
		);
	}

	$: frontendMetadataDirty = !frontendMetadataMatches(
		frontendAppMetadata,
		publishedFrontendAppMetadata
	);
</script>
