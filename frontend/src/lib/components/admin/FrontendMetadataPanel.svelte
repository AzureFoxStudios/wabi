<script lang="ts">
	import { _ } from '$lib/i18n';
	import type { FrontendAppMetadataPolicy } from '$lib/api';
	import type { DeskPosterBlock } from '../../../../../shared/adminPolicyContracts';
	import { onMount } from 'svelte';
	import { getAuthToken } from '$lib/authSession';
	import { getServerUrl } from '$lib/serverUrl';
	import { channels } from '$lib/socket';
	import { DISPLAY_FONTS } from '$lib/theme/displayFonts';
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
	const keys: Array<keyof FrontendAppMetadataPolicy> = ['displayName', 'iconUrl', 'bannerUrl', 'deskBackgroundUrl', 'deskStillUrl', 'deskWelcomeText', 'deskHelpText', 'deskHelpUrl', 'deskHelpLabel', 'deskStartingRoomId', 'deskFocusedWelcome', 'accentColor', 'description', 'tagline', 'launchPageFallbackEnabled', 'ownerBadgeMark', 'staffBadgeMark', 'displayFont'];
	const dirty = $derived(keys.some(key => frontendAppMetadata[key] !== publishedFrontendAppMetadata[key]) || JSON.stringify(frontendAppMetadata.deskPosterBlocks || []) !== JSON.stringify(publishedFrontendAppMetadata.deskPosterBlocks || []));
	const busy = $derived(frontendMetadataLoading || frontendMetadataSaving || frontendMetadataUploadTarget !== null);
	const editable = $derived(frontendMetadataLoaded && !busy);
	const safeAccent = $derived(sanitizeAccentColor(frontendAppMetadata.accentColor) || 'var(--accent-primary)');
	function setText(key: 'displayName' | 'description' | 'tagline' | 'iconUrl' | 'bannerUrl' | 'deskBackgroundUrl' | 'deskStillUrl' | 'deskWelcomeText' | 'deskHelpText' | 'deskHelpUrl' | 'deskHelpLabel', value: string): void {
		onMetadataChange({ ...frontendAppMetadata, [key]: value || null });
	}
	function setDisplayFont(value: string): void {
		onMetadataChange({ ...frontendAppMetadata, displayFont: value && value !== 'default' ? value : null });
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

<section class="branding-editor" aria-label={$_('fmp.identity')}>
	<header class="branding-heading">
		<div><h2>{$_('fmp.identity')}</h2><p>{$_('fmp.heading_desc')}</p></div>
		<div class="branding-actions">
			<button onclick={onRefresh} disabled={busy || dirty || accentInvalid}>{$_('yt.refresh')}</button>
			{#if dirty || accentInvalid}<button onclick={discard} disabled={busy}>{$_('fmp.discard')}</button>{/if}
			<button class="branding-publish" onclick={onSave} disabled={!editable || !dirty || accentInvalid || deskBackgroundInvalid}>{frontendMetadataSaving ? $_('crp.publishing') : $_('fmp.publish')}</button>
		</div>
	</header>
	{#if frontendMetadataError}<p class="branding-error" role="alert">{frontendMetadataError}</p>{/if}
	{#if !frontendMetadataLoaded}
		<p role="status" class="branding-notice">{frontendMetadataLoading ? $_('fmp.loading_identity') : $_('fmp.load_failed')}</p>
	{:else}
		<p role="status" class="branding-notice">{dirty || accentInvalid || deskBackgroundInvalid ? $_('fmp.unpublished') : frontendMetadataSaveStatus || $_('fmp.showing_published')}</p>
		<fieldset disabled={!editable} class="branding-fields">
			<legend class="branding-sr-only">{$_('fmp.legend')}</legend>
			<div class="branding-form-grid">
				<label>{$_('login.wizard.branding_name')}<input value={frontendAppMetadata.displayName ?? ''} placeholder={$_('fmp.ph_community')} oninput={event => setText('displayName', event.currentTarget.value)} /></label>
				<label>{$_('fmp.signature')}<input value={accentInput} placeholder="#6366f1" aria-invalid={accentInvalid ? 'true' : undefined} aria-describedby="branding-accent-help" oninput={event => editAccent(event.currentTarget.value)} /><small id="branding-accent-help">{accentInvalid ? $_('fmp.accent_invalid') : $_('fmp.accent_help')}</small></label>
				<label>{$_('fmp.owner_mark')}<input value={frontendAppMetadata.ownerBadgeMark ?? ''} placeholder={$_('fmp.default_crown')} maxlength="8" aria-label={$_('fmp.owner_badge_label')} oninput={event => setBadgeMark('ownerBadgeMark', event.currentTarget.value)} /><small>{$_('fmp.owner_help')}</small></label>
				<label>{$_('fmp.staff_mark')}<input value={frontendAppMetadata.staffBadgeMark ?? ''} placeholder={$_('fmp.default_gem')} maxlength="8" aria-label={$_('fmp.staff_badge_label')} oninput={event => setBadgeMark('staffBadgeMark', event.currentTarget.value)} /><small>{$_('fmp.staff_help')}</small></label>
				<label>{$_('fmp.title_font')}<select value={frontendAppMetadata.displayFont ?? 'default'} aria-label={$_('fmp.title_font_label')} onchange={event => setDisplayFont(event.currentTarget.value)}>{#each DISPLAY_FONTS as font}<option value={font.id}>{font.label}</option>{/each}</select><small>{$_('fmp.title_font_help')}</small></label>
				<label class="branding-wide">{$_('donation_config.description')}<input value={frontendAppMetadata.description ?? ''} placeholder={$_('fmp.desc_ph')} oninput={event => setText('description', event.currentTarget.value)} /></label>
				<label class="branding-wide">{$_('branding.tagline')}<input value={frontendAppMetadata.tagline ?? ''} placeholder={$_('fmp.tagline_ph')} oninput={event => setText('tagline', event.currentTarget.value)} /></label>
			</div>
			<div class="branding-assets">
				<input bind:this={iconInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" class="branding-file-input" aria-label={$_('fmp.choose_icon')} tabindex="-1" onchange={event => onUploadAsset('icon', event)} />
				<input bind:this={bannerInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" class="branding-file-input" aria-label={$_('fmp.choose_banner')} tabindex="-1" onchange={event => onUploadAsset('banner', event)} />
				{#each ['icon', 'banner'] as asset}
					{@const target = asset as 'icon' | 'banner'}
					{@const source = resolveFrontendMetadataAssetUrl(target === 'icon' ? frontendAppMetadata.iconUrl : frontendAppMetadata.bannerUrl)}
					<div class="branding-asset">
						<button class="branding-upload" class:dragging={dragTarget === target} aria-label={$_('fmp.upload_asset', { values: { target: target === 'icon' ? $_('fmp.word_icon') : $_('fmp.word_banner') } })}
							onclick={() => (target === 'icon' ? iconInput : bannerInput)?.click()}
							ondragover={event => dragAsset(target, event)} ondragleave={() => dragTarget = null}
							ondrop={event => dropAsset(target, event)}>
							<span class="branding-asset-preview" class:banner={target === 'banner'}>{#if source}<img src={source} alt="" />{:else}<span>{target === 'icon' ? $_('map.icon') : $_('profile_settings.banner')}</span>{/if}</span>
							<strong>{frontendMetadataUploadTarget === target ? $_('wb.uploading') : target === 'icon' ? $_('fmp.server_icon') : $_('fmp.server_banner')}</strong>
							<span>{target === 'icon' ? $_('fmp.square') : $_('fmp.wide')} · {$_('fmp.choose_drop')}</span>
						</button>
						{#if source}<button class="branding-remove" onclick={() => setText(target === 'icon' ? 'iconUrl' : 'bannerUrl', '')}>{$_('fmp.remove_target', { values: { target: target === 'icon' ? $_('fmp.word_icon') : $_('fmp.word_banner') } })}</button>{/if}
					</div>
				{/each}
			</div>
				<p class="branding-help">{$_('fmp.upload_help')}</p>
				<section class="desk-branding" aria-label={$_('fmp.desk_title')}>
					<h3>{$_('fmp.desk_title')}</h3>
					<label>{$_('fmp.welcome_msg')}<textarea rows="4" maxlength="2000" value={frontendAppMetadata.deskWelcomeText ?? ''} placeholder={$_('fmp.welcome_ph')} oninput={event => setText('deskWelcomeText', event.currentTarget.value)}></textarea></label>
					<label class="branding-checkbox"><input type="checkbox" checked={frontendAppMetadata.deskFocusedWelcome === true} onchange={event => onMetadataChange({ ...frontendAppMetadata, deskFocusedWelcome: event.currentTarget.checked })} /><span>{$_('fmp.focus_welcome')} <small>{$_('fmp.focus_desc')}</small></span></label>
					<label>{$_('fmp.start_room')}<select value={frontendAppMetadata.deskStartingRoomId || ''} onchange={event => onMetadataChange({ ...frontendAppMetadata, deskStartingRoomId: event.currentTarget.value || null })}><option value="">{$_('fmp.first_room')}</option>{#each $channels.filter(channel => channel.type === 'text') as channel (channel.id)}<option value={channel.id}>#{channel.name}</option>{/each}</select></label>
					<label>{$_('fmp.help_text')}<textarea rows="3" maxlength="1200" value={frontendAppMetadata.deskHelpText ?? ''} placeholder={$_('fmp.help_ph')} oninput={event => setText('deskHelpText', event.currentTarget.value)}></textarea></label>
					<div class="branding-form-grid"><label>{$_('fmp.resource_label')}<input maxlength="80" value={frontendAppMetadata.deskHelpLabel ?? ''} placeholder={$_('fmp.resource_ph')} oninput={event => setText('deskHelpLabel', event.currentTarget.value)} /></label><label>{$_('fmp.resource_url')}<input type="url" value={frontendAppMetadata.deskHelpUrl ?? ''} placeholder="https://example.org/guide" oninput={event => setText('deskHelpUrl', event.currentTarget.value)} /></label></div>
					<p>{$_('fmp.anim_help')}</p>
					<input bind:this={deskBackgroundInput} type="file" accept="image/gif,image/webp" class="branding-file-input" aria-label={$_('fmp.choose_anim')} tabindex="-1" onchange={event => onUploadAsset('deskBackground', event)} />
					<input bind:this={deskStillInput} type="file" accept="image/png,image/jpeg" class="branding-file-input" aria-label={$_('fmp.choose_still')} tabindex="-1" onchange={event => onUploadAsset('deskStill', event)} />
					<div class="desk-branding-actions"><button type="button" onclick={() => deskBackgroundInput?.click()} disabled={!editable}>{frontendMetadataUploadTarget === 'deskBackground' ? $_('wb.uploading') : $_('fmp.upload_moving')}</button><button type="button" onclick={() => deskStillInput?.click()} disabled={!editable}>{frontendMetadataUploadTarget === 'deskStill' ? $_('wb.uploading') : $_('fmp.upload_still')}</button></div>
				{#if deskBackgroundInvalid}<p class="branding-error" role="alert">{$_('fmp.still_needed')}</p>{/if}
				{#if resolveFrontendMetadataAssetUrl(frontendAppMetadata.deskStillUrl)}<img class="desk-branding-preview" src={resolveFrontendMetadataAssetUrl(frontendAppMetadata.deskStillUrl) ?? undefined} alt={$_('fmp.still_preview')} />{/if}
				<div class="branding-form-grid"><label>{$_('fmp.moving_url')}<input value={frontendAppMetadata.deskBackgroundUrl ?? ''} placeholder="/uploads/desk-background.webp" oninput={event => setText('deskBackgroundUrl', event.currentTarget.value)} /></label><label>{$_('fmp.still_url')}<input value={frontendAppMetadata.deskStillUrl ?? ''} placeholder="/uploads/desk-still.webp" oninput={event => setText('deskStillUrl', event.currentTarget.value)} /></label></div>
				{#if frontendAppMetadata.deskBackgroundUrl || frontendAppMetadata.deskStillUrl}<button type="button" onclick={() => onMetadataChange({ ...frontendAppMetadata, deskBackgroundUrl: null, deskStillUrl: null })} disabled={!editable}>{$_('fmp.remove_desk')}</button>{/if}

					<section class="poster-editor" aria-label={$_('fmp.poster_title')}>
						<h3>{$_('fmp.poster_title')}</h3>
						<p>{$_('fmp.poster_help')}</p>
						<div class="desk-branding-actions"><button type="button" onclick={() => addPosterBlock('text')} disabled={!editable}>{$_('fmp.add_text')}</button><button type="button" onclick={() => addPosterBlock('link')} disabled={!editable}>{$_('fmp.add_link')}</button><button type="button" onclick={() => addPosterBlock('role')} disabled={!editable}>{$_('fmp.add_role')}</button></div>
						{#each frontendAppMetadata.deskPosterBlocks || [] as block (block.id)}
							<div class="poster-block-fields">
								<strong>{block.kind === 'text' ? $_('login.kind_text') : block.kind === 'link' ? $_('office.editor.link') : $_('fmp.kind_role')}</strong>
								<label>{$_('fmp.visible_text')}<input maxlength="240" value={block.text} oninput={event => updatePosterBlock(block.id, { text: event.currentTarget.value })} /></label>
								{#if block.kind === 'link'}<label>{$_('fmp.web_url')}<input type="url" value={block.url || ''} oninput={event => updatePosterBlock(block.id, { url: event.currentTarget.value })} /></label>{/if}
								{#if block.kind === 'role'}<label>{$_('fmp.community_role')}<select value={block.roleId || ''} onchange={event => updatePosterBlock(block.id, { roleId: event.currentTarget.value })}><option value="">{$_('fmp.choose_role')}</option>{#each roleOptions as role (role.id)}<option value={role.id}>{role.name}</option>{/each}</select></label>{/if}
								<div class="poster-position"><label>{$_('panels.left')} %<input type="number" min="0" max="90" value={block.x} oninput={event => updatePosterBlock(block.id, { x: Number(event.currentTarget.value) })} /></label><label>{$_('model_viewer.top')} %<input type="number" min="0" max="100" value={block.y} oninput={event => updatePosterBlock(block.id, { y: Number(event.currentTarget.value) })} /></label><label>{$_('rann.width')} %<input type="number" min="10" max="100" value={block.width} oninput={event => updatePosterBlock(block.id, { width: Number(event.currentTarget.value) })} /></label></div>
								<button type="button" onclick={() => removePosterBlock(block.id)}>{$_('fmp.remove_block')}</button>
							</div>
						{/each}
						{#if (frontendAppMetadata.deskPosterBlocks || []).length}<button type="button" onclick={() => previewNarrow = !previewNarrow}>{previewNarrow ? $_('fmp.preview_desktop') : $_('fmp.preview_phone')}</button><div bind:this={posterPreview} class="poster-preview" class:narrow={previewNarrow} style:background-image={resolveFrontendMetadataAssetUrl(frontendAppMetadata.deskStillUrl) ? `url(${resolveFrontendMetadataAssetUrl(frontendAppMetadata.deskStillUrl)})` : undefined} aria-label={$_('fmp.poster_preview')}>{#each frontendAppMetadata.deskPosterBlocks || [] as block (block.id)}<button type="button" class="poster-preview-block" style:left={`${block.x}%`} style:top={`${block.y}%`} style:width={`${block.width}%`} aria-label={$_('fmp.move_block', { values: { name: block.text || block.kind } })} onpointerdown={event => startPosterDrag(event, block)} onpointermove={movePosterDrag} onpointerup={() => draggingPoster = null} onpointercancel={() => draggingPoster = null}>{block.text || $_('fmp.untitled')}</button>{/each}</div>{/if}
					</section>
				</section>
			<details class="branding-advanced">
				<summary>{$_('fmp.advanced')}</summary>
				<div class="branding-form-grid">
					<label>{$_('fmp.icon_url')}<input value={frontendAppMetadata.iconUrl ?? ''} placeholder="/uploads/server-icon.webp" oninput={event => setText('iconUrl', event.currentTarget.value)} /></label>
					<label>{$_('fmp.banner_url')}<input value={frontendAppMetadata.bannerUrl ?? ''} placeholder="/uploads/server-banner.webp" oninput={event => setText('bannerUrl', event.currentTarget.value)} /></label>
					<label class="branding-checkbox branding-wide"><input type="checkbox" checked={frontendAppMetadata.launchPageFallbackEnabled} onchange={event => onMetadataChange({ ...frontendAppMetadata, launchPageFallbackEnabled: event.currentTarget.checked })} /><span>{$_('fmp.login_fallback')}</span></label>
				</div>
			</details>
		</fieldset>
		<section class="branding-preview-section" aria-label={$_('fmp.preview_aria')}>
			<h3>{$_('messages.zip_preview.preview.show')}</h3>
			<div class="branding-preview" style:--branding-preview-accent={safeAccent}>
				{#if resolveFrontendMetadataAssetUrl(frontendAppMetadata.bannerUrl)}<img class="branding-preview-banner" src={resolveFrontendMetadataAssetUrl(frontendAppMetadata.bannerUrl) ?? undefined} alt="" />{/if}
				<div class="branding-preview-copy">
					<div class="branding-preview-avatar">{#if resolveFrontendMetadataAssetUrl(frontendAppMetadata.iconUrl)}<img src={resolveFrontendMetadataAssetUrl(frontendAppMetadata.iconUrl) ?? undefined} alt="" />{:else}<span>{(frontendAppMetadata.displayName || 'W').charAt(0).toUpperCase()}</span>{/if}</div>
					<div><strong>{frontendAppMetadata.displayName || $_('fmp.your_server')}</strong>{#if frontendAppMetadata.description}<p>{frontendAppMetadata.description}</p>{/if}{#if frontendAppMetadata.tagline}<small>{frontendAppMetadata.tagline}</small>{/if}</div>
				</div>
			</div>
		</section>
	{/if}
</section>

<style>
	.branding-editor { display: grid; gap: 20px; padding: 22px; background: var(--w-bg2); border: 1px solid var(--w-line); border-radius: calc(14px * var(--w-rs, 1)); min-width: 0; }
	.branding-heading { display: flex; justify-content: space-between; align-items: start; gap: 16px; flex-wrap: wrap; }
	h2 { margin: 0; font-size: 1rem; line-height: 1.4; }
	.branding-heading p { margin: 6px 0 0; color: var(--w-mute); font-size: .85rem; line-height: 1.5; }
	.branding-actions { display: flex; gap: 8px; flex-wrap: wrap; }
	button { min-height: 44px; padding: 10px 14px; border: 1px solid var(--w-line-strong); border-radius: calc(10px * var(--w-rs, 1)); color: var(--w-text); -webkit-text-fill-color: currentColor; background: var(--w-raise); font: inherit; font-size: .85rem; cursor: pointer; }
	button:hover:not(:disabled) { background: var(--w-raise); }
	button:disabled { opacity: .6; cursor: default; }
	.branding-publish { color: var(--w-on-accent); background: var(--w-accent); border-color: var(--w-accent); }
	.branding-publish:hover:not(:disabled) { background: var(--w-accent); }
	.branding-notice, .branding-help { margin: 0; font-size: .85rem; line-height: 1.6; color: var(--w-mute); }
	.branding-error { margin: 0; padding: 12px 14px; border: 1px solid var(--w-danger); border-radius: calc(10px * var(--w-rs, 1)); color: color-mix(in srgb, var(--w-text) 70%, var(--w-danger)); background: var(--accent-danger-soft); line-height: 1.6; }
	.branding-fields { display: grid; gap: 20px; min-width: 0; border: 0; padding: 0; margin: 0; }
	.branding-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
	label { display: grid; gap: 8px; font-size: .85rem; color: var(--w-text); min-width: 0; }
	label small { color: var(--w-mute); font-size: .75rem; }
	input:not([type="checkbox"]) { min-width: 0; width: 100%; min-height: 44px; box-sizing: border-box; padding: 10px 12px; font: inherit; color: var(--w-text); background: var(--w-sink); border: 1px solid var(--w-line-strong); border-radius: calc(10px * var(--w-rs, 1)); }
	textarea{min-width:0;width:100%;box-sizing:border-box;padding:10px 12px;font:inherit;color:var(--w-text);background:var(--w-sink);border:1px solid var(--w-line-strong);border-radius:calc(10px * var(--w-rs, 1));resize:vertical}
	.poster-editor{display:grid;gap:12px;border-top:1px solid var(--w-line-strong);padding-top:16px}.poster-editor p{color:var(--w-mute)}.poster-block-fields{display:grid;gap:10px;padding:12px;border:1px solid var(--w-line-strong);border-radius:calc(10px * var(--w-rs, 1))}.poster-position{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.poster-preview{position:relative;min-height:250px;background-color:var(--w-sink);background-size:cover;background-position:center;border:1px solid var(--w-line-strong);border-radius:calc(10px * var(--w-rs, 1));overflow:hidden}.poster-preview.narrow{width:min(320px,100%);min-height:400px;display:grid;align-content:end;gap:6px;padding:10px;box-sizing:border-box}.poster-preview.narrow .poster-preview-block{position:static;width:auto!important}.poster-preview-block{position:absolute;display:block;cursor:move;touch-action:none;text-align:left;background:var(--w-bg2);color:var(--w-text);padding:4px;overflow:hidden;border:1px solid var(--w-accent);border-radius:4px}.poster-block-fields select,.desk-branding select{min-height:44px;background:var(--w-sink);color:var(--w-text);border:1px solid var(--w-line-strong);border-radius:calc(10px * var(--w-rs, 1))}
	input::placeholder { color: var(--w-mute); opacity: 1; }
	.branding-wide { grid-column: 1 / -1; }
	.branding-assets { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
	.branding-asset { display: grid; gap: 8px; min-width: 0; align-content: start; }
	.branding-upload { display: grid; justify-items: center; gap: 10px; padding: 18px; width: 100%; text-align: center; background: var(--w-sink); }
	.branding-upload.dragging { border-color: var(--w-accent); background: var(--w-raise); }
	.branding-upload > span:last-child { color: var(--w-mute); font-size: .75rem; line-height: 1.5; }
	.branding-asset-preview { display: flex; align-items: center; justify-content: center; width: 64px; height: 64px; overflow: hidden; background: var(--w-raise); border: 1px solid var(--w-line); border-radius: calc(10px * var(--w-rs, 1)); color: var(--w-mute); }
	.branding-asset-preview.banner { width: min(100%, 180px); }
	.branding-asset-preview img { width: 100%; height: 100%; object-fit: cover; }
	.branding-remove { justify-self: center; border: 0; background: transparent; }
	.branding-advanced { border-top: 1px solid var(--w-line); padding-top: 16px; }
	summary { cursor: pointer; font-size: .85rem; padding: 8px 0; }
	.branding-advanced .branding-form-grid { margin-top: 18px; }
	.branding-checkbox { display: flex; align-items: start; gap: 12px; line-height: 1.6; }
	.branding-checkbox input { margin-top: 4px; accent-color: var(--w-accent); }
	.branding-preview-section h3 { margin: 0 0 12px; font-size: .9rem; }
	.branding-preview { border: 1px solid var(--w-line); border-radius: calc(14px * var(--w-rs, 1)); overflow: hidden; background: var(--w-sink); }
	.branding-preview-banner { display: block; width: 100%; height: 120px; object-fit: cover; }
	.desk-branding{display:grid;gap:12px;padding-top:18px;border-top:1px solid var(--w-line)}
	.desk-branding h3,.desk-branding p{margin:0}.desk-branding p{color:var(--w-mute);line-height:1.5}
	.desk-branding-actions{display:flex;flex-wrap:wrap;gap:8px}.desk-branding-preview{width:100%;height:160px;object-fit:cover;border-radius:calc(10px * var(--w-rs, 1))}
	.branding-preview-copy { display: flex; align-items: center; gap: 16px; padding: 20px; min-width: 0; }
	.branding-preview-copy > div:last-child { min-width: 0; overflow-wrap: anywhere; }
	.branding-preview-copy strong { color: var(--branding-preview-accent); font-size: 1.1rem; }
	.branding-preview-copy p { margin: 6px 0 0; color: var(--w-mute); font-size: .85rem; line-height: 1.6; }
	.branding-preview-copy small { display: block; margin-top: 6px; color: var(--w-mute); line-height: 1.5; }
	.branding-preview-avatar { display: flex; align-items: center; justify-content: center; width: 52px; height: 52px; flex-shrink: 0; border-radius: calc(10px * var(--w-rs, 1)); overflow: hidden; background: var(--w-raise); border: 1px solid var(--w-line); }
	.branding-preview-avatar img { width: 100%; height: 100%; object-fit: cover; }
	.branding-sr-only, .branding-file-input { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
	:is(button, input, summary):focus-visible { outline: 2px solid var(--w-accent); outline-offset: 3px; }
	@media (max-width: 640px) { .branding-editor { padding: 18px 16px; } .branding-form-grid, .branding-assets { grid-template-columns: 1fr; } .branding-heading, .branding-actions { width: 100%; } .branding-actions button { flex: 1 1 auto; } }

	/* ---- layout: the live preview leads, the controls follow it ---- */
	.branding-editor { background: var(--w-bg2); font-family: var(--w-sans); color: var(--w-text); }
	.branding-heading { order: -3; }
	.branding-error, .branding-notice { order: -2; }
	.branding-preview-section { order: -1; }
	h2 { font: 600 calc(24px * var(--w-fs, 1))/1.2 var(--w-serif); letter-spacing: 0.01em; }
	h3 { font: 600 calc(17px * var(--w-fs, 1))/1.3 var(--w-serif); text-transform: none; letter-spacing: 0.01em; color: var(--w-text); }
	.branding-preview-section h3 { font: 600 calc(11px * var(--w-fs, 1))/1 var(--w-mono); text-transform: uppercase; letter-spacing: 0.12em; color: var(--w-faint); }
	.branding-preview { position: relative; border-radius: calc(16px * var(--w-rs, 1)); background: var(--w-bg); }
	.branding-preview-banner { height: 170px; }
	.branding-preview { min-height: 150px; display: flex; flex-direction: column; justify-content: flex-end; background: radial-gradient(260px 160px at 90% 0%, color-mix(in srgb, var(--branding-preview-accent, var(--w-accent)) 34%, transparent), transparent 72%), var(--w-bg); }
	.branding-preview:has(.branding-preview-banner) .branding-preview-copy { margin-top: -34px; }
	.branding-preview-copy { position: relative; padding: 22px; align-items: flex-end; }
	.branding-preview-avatar { width: 64px; height: 64px; border: calc(3px * var(--w-bw-scale, 1)) solid var(--w-bg); border-radius: calc(14px * var(--w-rs, 1)); background: var(--w-raise); }
	.branding-preview-copy strong { font: 600 calc(24px * var(--w-fs, 1))/1.15 var(--w-serif); }
	label { font: 600 calc(12px * var(--w-fs, 1))/1.3 var(--w-sans); color: var(--w-mute); letter-spacing: 0.02em; }
	input:not([type="checkbox"]), textarea, select { background: var(--w-sink); border: var(--w-bw, 1px) solid var(--w-line-strong); border-radius: calc(10px * var(--w-rs, 1)); color: var(--w-text); }
	input:not([type="checkbox"]):focus, textarea:focus, select:focus { outline: none; border-color: var(--w-accent); box-shadow: var(--w-ring); }
	select { min-height: 44px; padding: 8px 10px; font: inherit; width: 100%; }
	button { min-height: 36px; padding: 6px 14px; border: var(--w-bw, 1px) solid var(--w-line-strong); border-radius: calc(10px * var(--w-rs, 1)); background: transparent; color: var(--w-text); font: 600 calc(13px * var(--w-fs, 1)) var(--w-sans); }
	button:hover:not(:disabled) { background: var(--w-raise); border-color: var(--w-accent); }
	.branding-publish, .branding-publish:hover:not(:disabled) { background: var(--w-text); color: var(--w-bg); border-color: transparent; }
	.branding-upload { border: var(--w-bw, 1px) dashed var(--w-line-strong); background: var(--w-sink); min-height: 160px; align-content: center; }
	.branding-upload:hover { border-color: var(--w-accent); }
	.branding-asset-preview { width: 76px; height: 76px; }
	.branding-asset-preview.banner { width: min(100%, 220px); height: 76px; }
	.desk-branding, .poster-editor { padding: 18px; border: var(--w-bw, 1px) solid var(--w-line); border-radius: calc(14px * var(--w-rs, 1)); background: var(--w-bg); }
</style>
