<script lang="ts">
	import type { FrontendAppMetadataPolicy } from '$lib/api';
	import { sanitizeAccentColor } from '$lib/cssSanitize';

	let {
		frontendAppMetadata, publishedFrontendAppMetadata, frontendMetadataLoaded,
		frontendMetadataLoading, frontendMetadataSaving, frontendMetadataError,
		frontendMetadataSaveStatus, frontendMetadataUploadTarget, onMetadataChange,
		onSave, onDiscard, onRefresh, onUploadAsset, resolveFrontendMetadataAssetUrl,
	}: {
		frontendAppMetadata: FrontendAppMetadataPolicy;
		publishedFrontendAppMetadata: FrontendAppMetadataPolicy;
		frontendMetadataLoaded: boolean;
		frontendMetadataLoading: boolean;
		frontendMetadataSaving: boolean;
		frontendMetadataError: string;
		frontendMetadataSaveStatus: string;
		frontendMetadataUploadTarget: 'icon' | 'banner' | null;
		onMetadataChange: (metadata: FrontendAppMetadataPolicy) => void;
		onSave: () => void;
		onDiscard: () => void;
		onRefresh: () => void;
		onUploadAsset: (target: 'icon' | 'banner', source: Event | File) => void;
		resolveFrontendMetadataAssetUrl: (url: string | null | undefined) => string | null;
	} = $props();

	let iconInput = $state<HTMLInputElement | null>(null);
	let bannerInput = $state<HTMLInputElement | null>(null);
	let dragTarget = $state<'icon' | 'banner' | null>(null);
	let accentInput = $state('');
	const authoritativeAccent = $derived(frontendAppMetadata.accentColor ?? '');
	$effect(() => { accentInput = authoritativeAccent; });
	const accentInvalid = $derived(accentInput.trim() !== '' && !sanitizeAccentColor(accentInput));
	const keys: Array<keyof FrontendAppMetadataPolicy> = ['displayName', 'iconUrl', 'bannerUrl', 'accentColor', 'description', 'tagline', 'launchPageFallbackEnabled'];
	const dirty = $derived(keys.some(key => frontendAppMetadata[key] !== publishedFrontendAppMetadata[key]));
	const busy = $derived(frontendMetadataLoading || frontendMetadataSaving || frontendMetadataUploadTarget !== null);
	const editable = $derived(frontendMetadataLoaded && !busy);
	const safeAccent = $derived(sanitizeAccentColor(frontendAppMetadata.accentColor) || 'var(--accent-primary)');
	function setText(key: 'displayName' | 'description' | 'tagline' | 'iconUrl' | 'bannerUrl', value: string): void {
		onMetadataChange({ ...frontendAppMetadata, [key]: value || null });
	}
	function dropAsset(target: 'icon' | 'banner', event: DragEvent): void {
		event.preventDefault();
		dragTarget = null;
		if (!editable) return;
		const file = event.dataTransfer?.files[0];
		if (file) onUploadAsset(target, file);
	}
	function dragAsset(target: 'icon' | 'banner', event: DragEvent): void {
		event.preventDefault();
		if (editable) dragTarget = target;
	}
	function editAccent(value: string): void {
		accentInput = value;
		const valid = sanitizeAccentColor(value);
		if (valid || !value.trim()) onMetadataChange({ ...frontendAppMetadata, accentColor: valid });
	}
	function discard(): void {
		accentInput = publishedFrontendAppMetadata.accentColor ?? '';
		onDiscard();
	}
</script>

<section class="branding-editor" aria-label="Server identity">
	<header class="branding-heading">
		<div><h2>Server identity</h2><p>Your community’s name, artwork and welcome text.</p></div>
		<div class="branding-actions">
			<button onclick={onRefresh} disabled={busy || dirty || accentInvalid}>Refresh</button>
			{#if dirty || accentInvalid}<button onclick={discard} disabled={busy}>Discard changes</button>{/if}
			<button class="branding-publish" onclick={onSave} disabled={!editable || !dirty || accentInvalid}>{frontendMetadataSaving ? 'Publishing…' : 'Publish changes'}</button>
		</div>
	</header>
	{#if frontendMetadataError}<p class="branding-error" role="alert">{frontendMetadataError}</p>{/if}
	{#if !frontendMetadataLoaded}
		<p role="status" class="branding-notice">{frontendMetadataLoading ? 'Loading the published server identity…' : 'The server identity could not be loaded. Refresh to try again; nothing has been changed.'}</p>
	{:else}
		<p role="status" class="branding-notice">{dirty || accentInvalid ? 'You have unpublished changes. The preview below is only visible to you.' : frontendMetadataSaveStatus || 'Showing the published server identity.'}</p>
		<fieldset disabled={!editable} class="branding-fields">
			<legend class="branding-sr-only">Identity and artwork</legend>
			<div class="branding-form-grid">
				<label>Server name<input value={frontendAppMetadata.displayName ?? ''} placeholder="Your community" oninput={event => setText('displayName', event.currentTarget.value)} /></label>
				<label>Accent color<input value={accentInput} placeholder="#6366f1" aria-invalid={accentInvalid ? 'true' : undefined} aria-describedby="branding-accent-help" oninput={event => editAccent(event.currentTarget.value)} /><small id="branding-accent-help">{accentInvalid ? 'Enter a valid hex, RGB or HSL color, or leave blank.' : 'Color used in the server preview.'}</small></label>
				<label class="branding-wide">Description<input value={frontendAppMetadata.description ?? ''} placeholder="A short introduction to your server" oninput={event => setText('description', event.currentTarget.value)} /></label>
				<label class="branding-wide">Tagline<input value={frontendAppMetadata.tagline ?? ''} placeholder="A few words that make this place yours" oninput={event => setText('tagline', event.currentTarget.value)} /></label>
			</div>
			<div class="branding-assets">
				<input bind:this={iconInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" class="branding-file-input" aria-label="Choose server icon file" tabindex="-1" onchange={event => onUploadAsset('icon', event)} />
				<input bind:this={bannerInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" class="branding-file-input" aria-label="Choose server banner file" tabindex="-1" onchange={event => onUploadAsset('banner', event)} />
				{#each ['icon', 'banner'] as asset}
					{@const target = asset as 'icon' | 'banner'}
					{@const source = resolveFrontendMetadataAssetUrl(target === 'icon' ? frontendAppMetadata.iconUrl : frontendAppMetadata.bannerUrl)}
					<div class="branding-asset">
						<button class="branding-upload" class:dragging={dragTarget === target} aria-label={'Upload server ' + target}
							onclick={() => (target === 'icon' ? iconInput : bannerInput)?.click()}
							ondragover={event => dragAsset(target, event)} ondragleave={() => dragTarget = null}
							ondrop={event => dropAsset(target, event)}>
							<span class="branding-asset-preview" class:banner={target === 'banner'}>{#if source}<img src={source} alt="" />{:else}<span>{target === 'icon' ? 'Icon' : 'Banner'}</span>{/if}</span>
							<strong>{frontendMetadataUploadTarget === target ? 'Uploading…' : target === 'icon' ? 'Server icon' : 'Server banner'}</strong>
							<span>{target === 'icon' ? 'Square artwork' : 'Wide artwork'} · choose or drop a file</span>
						</button>
						{#if source}<button class="branding-remove" onclick={() => setText(target === 'icon' ? 'iconUrl' : 'bannerUrl', '')}>Remove {target}</button>{/if}
					</div>
				{/each}
			</div>
			<p class="branding-help">PNG, JPG, GIF or WebP, up to 10 MB. Uploads join your draft; publish to make them visible.</p>
			<details class="branding-advanced">
				<summary>Advanced artwork and fallback</summary>
				<div class="branding-form-grid">
					<label>Icon URL<input value={frontendAppMetadata.iconUrl ?? ''} placeholder="/uploads/server-icon.webp" oninput={event => setText('iconUrl', event.currentTarget.value)} /></label>
					<label>Banner URL<input value={frontendAppMetadata.bannerUrl ?? ''} placeholder="/uploads/server-banner.webp" oninput={event => setText('bannerUrl', event.currentTarget.value)} /></label>
					<label class="branding-checkbox branding-wide"><input type="checkbox" checked={frontendAppMetadata.launchPageFallbackEnabled} onchange={event => onMetadataChange({ ...frontendAppMetadata, launchPageFallbackEnabled: event.currentTarget.checked })} /><span>Use the login page’s artwork and text when a field is empty.</span></label>
				</div>
			</details>
		</fieldset>
		<section class="branding-preview-section" aria-label="Server identity preview">
			<h3>Preview</h3>
			<div class="branding-preview" style:--branding-preview-accent={safeAccent}>
				{#if resolveFrontendMetadataAssetUrl(frontendAppMetadata.bannerUrl)}<img class="branding-preview-banner" src={resolveFrontendMetadataAssetUrl(frontendAppMetadata.bannerUrl) ?? undefined} alt="" />{/if}
				<div class="branding-preview-copy">
					<div class="branding-preview-avatar">{#if resolveFrontendMetadataAssetUrl(frontendAppMetadata.iconUrl)}<img src={resolveFrontendMetadataAssetUrl(frontendAppMetadata.iconUrl) ?? undefined} alt="" />{:else}<span>{(frontendAppMetadata.displayName || 'W').charAt(0).toUpperCase()}</span>{/if}</div>
					<div><strong>{frontendAppMetadata.displayName || 'Your server'}</strong>{#if frontendAppMetadata.description}<p>{frontendAppMetadata.description}</p>{/if}{#if frontendAppMetadata.tagline}<small>{frontendAppMetadata.tagline}</small>{/if}</div>
				</div>
			</div>
		</section>
	{/if}
</section>

<style>
	.branding-editor { display: grid; gap: 20px; padding: 22px; background: var(--surface-base); border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); min-width: 0; }
	.branding-heading { display: flex; justify-content: space-between; align-items: start; gap: 16px; flex-wrap: wrap; }
	h2 { margin: 0; font-size: 1rem; line-height: 1.4; }
	.branding-heading p { margin: 6px 0 0; color: var(--text-secondary); font-size: .85rem; line-height: 1.5; }
	.branding-actions { display: flex; gap: 8px; flex-wrap: wrap; }
	button { min-height: 44px; padding: 10px 14px; border: 1px solid var(--border-default); border-radius: var(--radius-md); color: var(--text-primary); -webkit-text-fill-color: currentColor; background: var(--surface-raised); font: inherit; font-size: .85rem; cursor: pointer; }
	button:hover:not(:disabled) { background: var(--surface-hover); }
	button:disabled { opacity: .6; cursor: default; }
	.branding-publish { color: var(--text-on-accent, white); background: var(--accent-primary); border-color: var(--accent-primary); }
	.branding-publish:hover:not(:disabled) { background: var(--accent-secondary); }
	.branding-notice, .branding-help { margin: 0; font-size: .85rem; line-height: 1.6; color: var(--text-secondary); }
	.branding-error { margin: 0; padding: 12px 14px; border: 1px solid var(--text-danger); border-radius: var(--radius-md); color: color-mix(in srgb, var(--text-primary) 70%, var(--text-danger)); background: var(--accent-danger-soft); line-height: 1.6; }
	.branding-fields { display: grid; gap: 20px; min-width: 0; border: 0; padding: 0; margin: 0; }
	.branding-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
	label { display: grid; gap: 8px; font-size: .85rem; color: var(--text-primary); min-width: 0; }
	label small { color: var(--text-secondary); font-size: .75rem; }
	input:not([type="checkbox"]) { min-width: 0; width: 100%; min-height: 44px; box-sizing: border-box; padding: 10px 12px; font: inherit; color: var(--text-primary); background: var(--surface-sunken); border: 1px solid var(--border-default); border-radius: var(--radius-md); }
	input::placeholder { color: var(--text-secondary); opacity: 1; }
	.branding-wide { grid-column: 1 / -1; }
	.branding-assets { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
	.branding-asset { display: grid; gap: 8px; min-width: 0; align-content: start; }
	.branding-upload { display: grid; justify-items: center; gap: 10px; padding: 18px; width: 100%; text-align: center; background: var(--surface-sunken); }
	.branding-upload.dragging { border-color: var(--accent-primary); background: var(--surface-hover); }
	.branding-upload > span:last-child { color: var(--text-secondary); font-size: .75rem; line-height: 1.5; }
	.branding-asset-preview { display: flex; align-items: center; justify-content: center; width: 64px; height: 64px; overflow: hidden; background: var(--surface-raised); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); color: var(--text-secondary); }
	.branding-asset-preview.banner { width: min(100%, 180px); }
	.branding-asset-preview img { width: 100%; height: 100%; object-fit: cover; }
	.branding-remove { justify-self: center; border: 0; background: transparent; }
	.branding-advanced { border-top: 1px solid var(--border-subtle); padding-top: 16px; }
	summary { cursor: pointer; font-size: .85rem; padding: 8px 0; }
	.branding-advanced .branding-form-grid { margin-top: 18px; }
	.branding-checkbox { display: flex; align-items: start; gap: 12px; line-height: 1.6; }
	.branding-checkbox input { margin-top: 4px; accent-color: var(--accent-primary); }
	.branding-preview-section h3 { margin: 0 0 12px; font-size: .9rem; }
	.branding-preview { border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); overflow: hidden; background: var(--surface-sunken); }
	.branding-preview-banner { display: block; width: 100%; height: 120px; object-fit: cover; }
	.branding-preview-copy { display: flex; align-items: center; gap: 16px; padding: 20px; min-width: 0; }
	.branding-preview-copy > div:last-child { min-width: 0; overflow-wrap: anywhere; }
	.branding-preview-copy strong { color: var(--branding-preview-accent); font-size: 1.1rem; }
	.branding-preview-copy p { margin: 6px 0 0; color: var(--text-secondary); font-size: .85rem; line-height: 1.6; }
	.branding-preview-copy small { display: block; margin-top: 6px; color: var(--text-secondary); line-height: 1.5; }
	.branding-preview-avatar { display: flex; align-items: center; justify-content: center; width: 52px; height: 52px; flex-shrink: 0; border-radius: var(--radius-md); overflow: hidden; background: var(--surface-raised); border: 1px solid var(--border-subtle); }
	.branding-preview-avatar img { width: 100%; height: 100%; object-fit: cover; }
	.branding-sr-only, .branding-file-input { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
	:is(button, input, summary):focus-visible { outline: 2px solid var(--accent-secondary); outline-offset: 3px; }
	@media (max-width: 640px) { .branding-editor { padding: 18px 16px; } .branding-form-grid, .branding-assets { grid-template-columns: 1fr; } .branding-heading, .branding-actions { width: 100%; } .branding-actions button { flex: 1 1 auto; } }
</style>
