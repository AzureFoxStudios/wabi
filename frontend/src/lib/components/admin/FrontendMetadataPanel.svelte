<script lang="ts">
	import type { FrontendAppMetadataPolicy } from '$lib/api';
	import type { DeskPosterBlock } from '../../../../../shared/adminPolicyContracts';
	import { onMount } from 'svelte';
	import { getAuthToken } from '$lib/authSession';
	import { getServerUrl } from '$lib/serverUrl';
	import { channels } from '$lib/socket';
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
		frontendMetadataUploadTarget: 'icon' | 'banner' | 'deskBackground' | 'deskStill' | null;
		onMetadataChange: (metadata: FrontendAppMetadataPolicy) => void;
		onSave: () => void;
		onDiscard: () => void;
		onRefresh: () => void;
		onUploadAsset: (target: 'icon' | 'banner' | 'deskBackground' | 'deskStill', source: Event | File) => void;
		resolveFrontendMetadataAssetUrl: (url: string | null | undefined) => string | null;
	} = $props();

	let iconInput = $state<HTMLInputElement | null>(null);
	let bannerInput = $state<HTMLInputElement | null>(null);
	let deskBackgroundInput = $state<HTMLInputElement | null>(null);
	let deskStillInput = $state<HTMLInputElement | null>(null);
	let dragTarget = $state<'icon' | 'banner' | null>(null);
	let accentInput = $state('');
	let roleOptions = $state<Array<{ id: string; name: string }>>([]);
	let posterPreview = $state<HTMLDivElement | null>(null);
	let previewNarrow = $state(false);
	let draggingPoster = $state<{ id: string; x: number; y: number; clientX: number; clientY: number; width: number } | null>(null);
	function startPosterDrag(event: PointerEvent, block: DeskPosterBlock): void {
		if (!editable || !posterPreview) return;
		draggingPoster = { id: block.id, x: block.x, y: block.y, clientX: event.clientX, clientY: event.clientY, width: block.width };
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}
	function movePosterDrag(event: PointerEvent): void {
		if (!draggingPoster || !posterPreview) return;
		const rect = posterPreview.getBoundingClientRect();
		const x = Math.round(Math.max(0, Math.min(100 - draggingPoster.width, draggingPoster.x + (event.clientX - draggingPoster.clientX) * 100 / rect.width)));
		const y = Math.round(Math.max(0, Math.min(100, draggingPoster.y + (event.clientY - draggingPoster.clientY) * 100 / rect.height)));
		updatePosterBlock(draggingPoster.id, { x, y });
	}

	onMount(() => {
		const server = getServerUrl(), token = getAuthToken(server);
		if (!token) return;
		void fetch(`${server}/api/server-center/reception`, { headers: { Authorization: `Bearer ${token}` } })
			.then(async response => { if (response.ok) roleOptions = (await response.json()).roles || []; })
			.catch(() => { /* Roles can be entered manually while offline. */ });
	});
	function addPosterBlock(kind: DeskPosterBlock['kind']): void {
		const blocks = frontendAppMetadata.deskPosterBlocks || [];
		if (blocks.length >= 24) return;
		const block: DeskPosterBlock = { id: (typeof crypto !== 'undefined' ? crypto.randomUUID?.() : undefined) || `block-${Date.now()}`, kind, text: kind === 'text' ? 'Your message' : kind === 'role' ? 'Choose a role' : 'Open resource', x: 5, y: Math.min(80, 8 + blocks.length * 12), width: 35, roleId: kind === 'role' ? roleOptions[0]?.id || null : null, url: kind === 'link' ? 'https://' : null };
		onMetadataChange({ ...frontendAppMetadata, deskPosterBlocks: [...blocks, block] });
	}
	function updatePosterBlock(id: string, patch: Partial<DeskPosterBlock>): void {
		onMetadataChange({ ...frontendAppMetadata, deskPosterBlocks: (frontendAppMetadata.deskPosterBlocks || []).map(block => {
			if (block.id !== id) return block;
			const next = { ...block, ...patch };
			next.width = Math.max(10, Math.min(100, next.width));
			next.x = Math.max(0, Math.min(100 - next.width, next.x));
			next.y = Math.max(0, Math.min(100, next.y));
			return next;
		}) });
	}
	function removePosterBlock(id: string): void {
		onMetadataChange({ ...frontendAppMetadata, deskPosterBlocks: (frontendAppMetadata.deskPosterBlocks || []).filter(block => block.id !== id) });
	}

	const authoritativeAccent = $derived(frontendAppMetadata.accentColor ?? '');
	$effect(() => { accentInput = authoritativeAccent; });
	const accentInvalid = $derived(accentInput.trim() !== '' && !sanitizeAccentColor(accentInput));
	const deskBackgroundInvalid = $derived(Boolean(frontendAppMetadata.deskBackgroundUrl) && !frontendAppMetadata.deskStillUrl);
	const keys: Array<keyof FrontendAppMetadataPolicy> = ['displayName', 'iconUrl', 'bannerUrl', 'deskBackgroundUrl', 'deskStillUrl', 'deskWelcomeText', 'deskHelpText', 'deskHelpUrl', 'deskHelpLabel', 'deskStartingRoomId', 'deskFocusedWelcome', 'accentColor', 'description', 'tagline', 'launchPageFallbackEnabled', 'ownerBadgeMark', 'staffBadgeMark'];
	const dirty = $derived(keys.some(key => frontendAppMetadata[key] !== publishedFrontendAppMetadata[key]) || JSON.stringify(frontendAppMetadata.deskPosterBlocks || []) !== JSON.stringify(publishedFrontendAppMetadata.deskPosterBlocks || []));
	const busy = $derived(frontendMetadataLoading || frontendMetadataSaving || frontendMetadataUploadTarget !== null);
	const editable = $derived(frontendMetadataLoaded && !busy);
	const safeAccent = $derived(sanitizeAccentColor(frontendAppMetadata.accentColor) || 'var(--accent-primary)');
	function setText(key: 'displayName' | 'description' | 'tagline' | 'iconUrl' | 'bannerUrl' | 'deskBackgroundUrl' | 'deskStillUrl' | 'deskWelcomeText' | 'deskHelpText' | 'deskHelpUrl' | 'deskHelpLabel', value: string): void {
		onMetadataChange({ ...frontendAppMetadata, [key]: value || null });
	}
	function setBadgeMark(key: 'ownerBadgeMark' | 'staffBadgeMark', value: string): void {
		onMetadataChange({ ...frontendAppMetadata, [key]: value.trim() ? value.slice(0, 16) : null });
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
			<button class="branding-publish" onclick={onSave} disabled={!editable || !dirty || accentInvalid || deskBackgroundInvalid}>{frontendMetadataSaving ? 'Publishing…' : 'Publish changes'}</button>
		</div>
	</header>
	{#if frontendMetadataError}<p class="branding-error" role="alert">{frontendMetadataError}</p>{/if}
	{#if !frontendMetadataLoaded}
		<p role="status" class="branding-notice">{frontendMetadataLoading ? 'Loading the published server identity…' : 'The server identity could not be loaded. Refresh to try again; nothing has been changed.'}</p>
	{:else}
		<p role="status" class="branding-notice">{dirty || accentInvalid || deskBackgroundInvalid ? 'You have unpublished changes. The preview below is only visible to you.' : frontendMetadataSaveStatus || 'Showing the published server identity.'}</p>
		<fieldset disabled={!editable} class="branding-fields">
			<legend class="branding-sr-only">Identity and artwork</legend>
			<div class="branding-form-grid">
				<label>Server name<input value={frontendAppMetadata.displayName ?? ''} placeholder="Your community" oninput={event => setText('displayName', event.currentTarget.value)} /></label>
				<label>Accent color<input value={accentInput} placeholder="#6366f1" aria-invalid={accentInvalid ? 'true' : undefined} aria-describedby="branding-accent-help" oninput={event => editAccent(event.currentTarget.value)} /><small id="branding-accent-help">{accentInvalid ? 'Enter a valid hex, RGB or HSL color, or leave blank.' : 'Color used in the server preview.'}</small></label>
				<label>Owner mark<input value={frontendAppMetadata.ownerBadgeMark ?? ''} placeholder="👑" maxlength="8" aria-label="Owner badge mark" oninput={event => setBadgeMark('ownerBadgeMark', event.currentTarget.value)} /><small>Shown beside owner names. Leave blank to use 👑.</small></label>
				<label>Staff mark<input value={frontendAppMetadata.staffBadgeMark ?? ''} placeholder="💎" maxlength="8" aria-label="Staff badge mark" oninput={event => setBadgeMark('staffBadgeMark', event.currentTarget.value)} /><small>Shown beside staff names. Leave blank to use 💎.</small></label>
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
				<section class="desk-branding" aria-label="Reference Desk background">
					<h3>Reference Desk background</h3>
					<label>Welcome message<textarea rows="4" maxlength="2000" value={frontendAppMetadata.deskWelcomeText ?? ''} placeholder="Tell people what this community is here to do" oninput={event => setText('deskWelcomeText', event.currentTarget.value)}></textarea></label>
					<label class="branding-checkbox"><input type="checkbox" checked={frontendAppMetadata.deskFocusedWelcome === true} onchange={event => onMetadataChange({ ...frontendAppMetadata, deskFocusedWelcome: event.currentTarget.checked })} /><span>Focus the welcome view on first arrival <small>Fill the app window, with a visible exit. Returning visits use the normal desk.</small></span></label>
					<label>Suggested starting room<select value={frontendAppMetadata.deskStartingRoomId || ''} onchange={event => onMetadataChange({ ...frontendAppMetadata, deskStartingRoomId: event.currentTarget.value || null })}><option value="">First accessible text room</option>{#each $channels.filter(channel => channel.type === 'text') as channel (channel.id)}<option value={channel.id}>#{channel.name}</option>{/each}</select></label>
					<label>Help text<textarea rows="3" maxlength="1200" value={frontendAppMetadata.deskHelpText ?? ''} placeholder="Where to get help on this server" oninput={event => setText('deskHelpText', event.currentTarget.value)}></textarea></label>
					<div class="branding-form-grid"><label>Resource label<input maxlength="80" value={frontendAppMetadata.deskHelpLabel ?? ''} placeholder="Community guide" oninput={event => setText('deskHelpLabel', event.currentTarget.value)} /></label><label>Resource URL<input type="url" value={frontendAppMetadata.deskHelpUrl ?? ''} placeholder="https://example.org/guide" oninput={event => setText('deskHelpUrl', event.currentTarget.value)} /></label></div>
					<p>Upload an animated GIF or WebP and a still image for people who pause motion or prefer reduced motion.</p>
					<input bind:this={deskBackgroundInput} type="file" accept="image/gif,image/webp" class="branding-file-input" aria-label="Choose animated Reference Desk background" tabindex="-1" onchange={event => onUploadAsset('deskBackground', event)} />
					<input bind:this={deskStillInput} type="file" accept="image/png,image/jpeg" class="branding-file-input" aria-label="Choose Reference Desk still image" tabindex="-1" onchange={event => onUploadAsset('deskStill', event)} />
					<div class="desk-branding-actions"><button type="button" onclick={() => deskBackgroundInput?.click()} disabled={!editable}>{frontendMetadataUploadTarget === 'deskBackground' ? 'Uploading…' : 'Upload moving background'}</button><button type="button" onclick={() => deskStillInput?.click()} disabled={!editable}>{frontendMetadataUploadTarget === 'deskStill' ? 'Uploading…' : 'Upload still image'}</button></div>
				{#if deskBackgroundInvalid}<p class="branding-error" role="alert">Add a still image before publishing an animated background.</p>{/if}
				{#if resolveFrontendMetadataAssetUrl(frontendAppMetadata.deskStillUrl)}<img class="desk-branding-preview" src={resolveFrontendMetadataAssetUrl(frontendAppMetadata.deskStillUrl) ?? undefined} alt="Reference Desk still preview" />{/if}
				<div class="branding-form-grid"><label>Moving background URL<input value={frontendAppMetadata.deskBackgroundUrl ?? ''} placeholder="/uploads/desk-background.webp" oninput={event => setText('deskBackgroundUrl', event.currentTarget.value)} /></label><label>Still image URL<input value={frontendAppMetadata.deskStillUrl ?? ''} placeholder="/uploads/desk-still.webp" oninput={event => setText('deskStillUrl', event.currentTarget.value)} /></label></div>
				{#if frontendAppMetadata.deskBackgroundUrl || frontendAppMetadata.deskStillUrl}<button type="button" onclick={() => onMetadataChange({ ...frontendAppMetadata, deskBackgroundUrl: null, deskStillUrl: null })} disabled={!editable}>Remove desk background</button>{/if}

					<section class="poster-editor" aria-label="Interactive poster">
						<h3>Interactive poster</h3>
						<p>Place readable text, links, and community role choices over the artwork. On small screens they appear as a list.</p>
						<div class="desk-branding-actions"><button type="button" onclick={() => addPosterBlock('text')} disabled={!editable}>Add text</button><button type="button" onclick={() => addPosterBlock('link')} disabled={!editable}>Add link</button><button type="button" onclick={() => addPosterBlock('role')} disabled={!editable}>Add role choice</button></div>
						{#each frontendAppMetadata.deskPosterBlocks || [] as block (block.id)}
							<div class="poster-block-fields">
								<strong>{block.kind === 'text' ? 'Text' : block.kind === 'link' ? 'Link' : 'Role choice'}</strong>
								<label>Visible text<input maxlength="240" value={block.text} oninput={event => updatePosterBlock(block.id, { text: event.currentTarget.value })} /></label>
								{#if block.kind === 'link'}<label>Full web URL<input type="url" value={block.url || ''} oninput={event => updatePosterBlock(block.id, { url: event.currentTarget.value })} /></label>{/if}
								{#if block.kind === 'role'}<label>Community role<select value={block.roleId || ''} onchange={event => updatePosterBlock(block.id, { roleId: event.currentTarget.value })}><option value="">Choose a role</option>{#each roleOptions as role (role.id)}<option value={role.id}>{role.name}</option>{/each}</select></label>{/if}
								<div class="poster-position"><label>Left %<input type="number" min="0" max="90" value={block.x} oninput={event => updatePosterBlock(block.id, { x: Number(event.currentTarget.value) })} /></label><label>Top %<input type="number" min="0" max="100" value={block.y} oninput={event => updatePosterBlock(block.id, { y: Number(event.currentTarget.value) })} /></label><label>Width %<input type="number" min="10" max="100" value={block.width} oninput={event => updatePosterBlock(block.id, { width: Number(event.currentTarget.value) })} /></label></div>
								<button type="button" onclick={() => removePosterBlock(block.id)}>Remove block</button>
							</div>
						{/each}
						{#if (frontendAppMetadata.deskPosterBlocks || []).length}<button type="button" onclick={() => previewNarrow = !previewNarrow}>{previewNarrow ? 'Preview desktop' : 'Preview phone'}</button><div bind:this={posterPreview} class="poster-preview" class:narrow={previewNarrow} style:background-image={resolveFrontendMetadataAssetUrl(frontendAppMetadata.deskStillUrl) ? `url(${resolveFrontendMetadataAssetUrl(frontendAppMetadata.deskStillUrl)})` : undefined} aria-label="Poster placement preview">{#each frontendAppMetadata.deskPosterBlocks || [] as block (block.id)}<button type="button" class="poster-preview-block" style:left={`${block.x}%`} style:top={`${block.y}%`} style:width={`${block.width}%`} aria-label={`Move ${block.text || block.kind} block`} onpointerdown={event => startPosterDrag(event, block)} onpointermove={movePosterDrag} onpointerup={() => draggingPoster = null} onpointercancel={() => draggingPoster = null}>{block.text || 'Untitled'}</button>{/each}</div>{/if}
					</section>
				</section>
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
	textarea{min-width:0;width:100%;box-sizing:border-box;padding:10px 12px;font:inherit;color:var(--text-primary);background:var(--surface-sunken);border:1px solid var(--border-default);border-radius:var(--radius-md);resize:vertical}
	.poster-editor{display:grid;gap:12px;border-top:1px solid var(--border-default);padding-top:16px}.poster-editor p{color:var(--text-secondary)}.poster-block-fields{display:grid;gap:10px;padding:12px;border:1px solid var(--border-default);border-radius:var(--radius-md)}.poster-position{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.poster-preview{position:relative;min-height:250px;background-color:var(--surface-sunken);background-size:cover;background-position:center;border:1px solid var(--border-default);border-radius:var(--radius-md);overflow:hidden}.poster-preview.narrow{width:min(320px,100%);min-height:400px;display:grid;align-content:end;gap:6px;padding:10px;box-sizing:border-box}.poster-preview.narrow .poster-preview-block{position:static;width:auto!important}.poster-preview-block{position:absolute;display:block;cursor:move;touch-action:none;text-align:left;background:var(--surface-base);color:var(--text-primary);padding:4px;overflow:hidden;border:1px solid var(--accent-primary);border-radius:4px}.poster-block-fields select,.desk-branding select{min-height:44px;background:var(--surface-sunken);color:var(--text-primary);border:1px solid var(--border-default);border-radius:var(--radius-md)}
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
	.desk-branding{display:grid;gap:12px;padding-top:18px;border-top:1px solid var(--border-subtle)}
	.desk-branding h3,.desk-branding p{margin:0}.desk-branding p{color:var(--text-secondary);line-height:1.5}
	.desk-branding-actions{display:flex;flex-wrap:wrap;gap:8px}.desk-branding-preview{width:100%;height:160px;object-fit:cover;border-radius:var(--radius-md)}
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
