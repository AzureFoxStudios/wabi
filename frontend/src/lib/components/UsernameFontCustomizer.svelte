<script lang="ts">
	import { tick } from 'svelte';
	import { currentUser } from '$lib/socket';
	import { getServerUrl } from '$lib/serverUrl';
	import {
		DEFAULT_NAME_DESIGN, CREATOR_PRESETS, parseProfileDesignFile, serializeProfileDesignFile,
		type NameStyleDesign, type EditableUsernameFont
	} from '$lib/profileDesign';
	import { saveProfilePatch } from '$lib/profileSave';
	import ProfileName from '$lib/components/ProfileName.svelte';
	import ProfileAppearanceControls from '$lib/components/ProfileAppearanceControls.svelte';

	const families = ['Arial', 'Georgia', 'Times New Roman', 'Comic Sans MS', 'Courier New', 'Trebuchet MS', 'Verdana', 'Impact', 'Palatino', 'Helvetica'];
	const sizes = [{ value: '0.9em', label: 'Small' }, { value: '1em', label: 'Medium' }, { value: '1.2em', label: 'Large' }, { value: '1.4em', label: 'Extra large' }];
	let title = $state('My profile design');
	let family = $state('inherit');
	let size = $state('1em');
	let weight = $state('600');
	let fontStyle = $state('normal');
	let legacyPreset = $state('none');
	let design = $state<NameStyleDesign>({ ...DEFAULT_NAME_DESIGN });
	let designEnabled = $state(false);
	let saving = $state(false);
	let feedback = $state('');
	let error = $state('');
	let loadedIdentity = $state('');
	let importInput: HTMLInputElement;
	let studioHeading: HTMLHeadingElement;
	const font = $derived<EditableUsernameFont>({ family, size, weight, style: fontStyle, preset: legacyPreset, ...(designEnabled ? { design: { ...design } } : {}) });
	const previewName = $derived($currentUser?.username || 'Your name');

	function loadFont(value?: EditableUsernameFont | null) {
		family = value?.family || 'inherit'; size = value?.size || '1em';
		weight = value?.weight || '600'; fontStyle = value?.style || 'normal';
		legacyPreset = value?.preset || 'none';
		design = { ...DEFAULT_NAME_DESIGN, ...value?.design };
		designEnabled = Boolean(value?.design);
	}
	export function loadExampleDraft(example: { title: string; usernameFont: EditableUsernameFont }): void {
		loadFont(example.usernameFont); title = example.title;
		feedback = 'Example loaded into your draft. Edit it, then publish when ready.'; error = '';
		void tick().then(() => {
			studioHeading?.focus({ preventScroll: true });
			studioHeading?.scrollIntoView({ block: 'start' });
		});
	}
	$effect(() => {
		const identity = `${getServerUrl()}:${$currentUser?.dbUserId ?? $currentUser?.id ?? ''}`;
		if (identity !== loadedIdentity) {
			loadedIdentity = identity;
			loadFont($currentUser?.usernameFont as EditableUsernameFont | undefined);
		}
	});

	function applyPreset(preset: typeof CREATOR_PRESETS[number]) {
		design = { ...DEFAULT_NAME_DESIGN, ...preset.design };
		legacyPreset = 'none'; designEnabled = true;
		title = preset.label;
		feedback = 'Preset loaded into your draft. Save when you are ready.';
		error = '';
	}
	function isPresetSelected(preset: typeof CREATOR_PRESETS[number]) { return designEnabled && JSON.stringify(design) === JSON.stringify(preset.design); }
	function changed() { feedback = 'Unsaved design'; error = ''; legacyPreset = 'none'; designEnabled = true; }
	function typographyChanged() { feedback = 'Unsaved design'; error = ''; }
	async function saveDesign() {
		if (saving) return;
		saving = true; error = ''; feedback = 'Saving design…';
		try {
			const submitted = JSON.stringify(font);
			await saveProfilePatch({ usernameFont: JSON.parse(submitted) });
			feedback = submitted === JSON.stringify(font) ? 'Design saved. Your profile now uses this look.' : 'Earlier design saved. Your newer changes are still a draft.';
		} catch (reason) {
			feedback = ''; error = reason instanceof Error ? reason.message : 'Could not save your design. Your draft is still here.';
		} finally { saving = false; }
	}
	function resetDraft() {
		loadFont(); title = 'My profile design'; feedback = 'Plain design loaded. Save to apply it.'; error = '';
	}
	function downloadDesign() {
		try {
			const data = serializeProfileDesignFile(title.trim() || 'My profile design', font);
			const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
			const link = document.createElement('a'); link.href = url;
			link.download = `${(title.trim() || 'wabi-profile').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 64)}.wabi-profile.json`;
			link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
			feedback = 'Design exported. Share the file so others can import and edit it.'; error = '';
		} catch (reason) { error = reason instanceof Error ? reason.message : 'Could not export this design.'; }
	}
	async function importDesign(event: Event) {
		const input = event.currentTarget as HTMLInputElement; const file = input.files?.[0];
		if (!file) return;
		try {
			if (file.size > 16 * 1024) throw new Error('Choose a profile design file of 16 KiB or smaller.');
			const imported = parseProfileDesignFile(await file.text());
			loadFont(imported.usernameFont); title = imported.title;
			feedback = 'Design imported into your draft. Edit it or save to apply.'; error = '';
		} catch (reason) { error = reason instanceof Error ? reason.message : 'This file is not a valid Wabi profile design.'; feedback = ''; }
		finally { input.value = ''; }
	}
</script>

<section class="profile-design-studio" aria-labelledby="profile-design-heading">
	<div class="studio-heading">
		<div><p class="studio-kicker">Make it yours</p><h3 id="profile-design-heading" bind:this={studioHeading} tabindex="-1">Profile design studio</h3><p class="studio-hint">Create a name and nameplate, then share a design anyone can edit. Everyone controls how much they see.</p></div>
		<span class="studio-free-label">Free to create & share</span>
	</div>
	<div class="studio-presets" aria-label="Starting designs">
		{#each CREATOR_PRESETS as preset (preset.id)}
			<button type="button" class="studio-preset" class:selected={isPresetSelected(preset)} aria-pressed={isPresetSelected(preset)} onclick={() => applyPreset(preset)} aria-label={`Use ${preset.label} design`} title={preset.description}>
				<ProfileName username={preset.label} font={{ family: 'inherit', size: '1em', weight: '600', style: 'normal', preset: 'none', design: preset.design }} color={$currentUser?.color} preview={true} />
				<span>Use {preset.label}</span>
			</button>
		{/each}
	</div>
	<div class="studio-workbench">
		<div class="studio-controls">
			<label class="studio-wide">Design title<input maxlength="80" bind:value={title} aria-label="Design title" /></label>
			<label>Font<select bind:value={family} onchange={typographyChanged}><option value="inherit">App default</option>{#each families as item}<option value={item}>{item}</option>{/each}</select></label>
			<label>Size<select bind:value={size} onchange={typographyChanged}>{#each sizes as item}<option value={item.value}>{item.label}</option>{/each}</select></label>
			<label>Weight<select bind:value={weight} onchange={typographyChanged}><option value="400">Regular</option><option value="500">Medium</option><option value="600">Semibold</option><option value="700">Bold</option></select></label>
			<label>Style<select bind:value={fontStyle} onchange={typographyChanged}><option value="normal">Normal</option><option value="italic">Italic</option></select></label>
			<label class="studio-wide studio-check"><input type="checkbox" checked={designEnabled} onchange={(event) => { designEnabled = event.currentTarget.checked; typographyChanged(); }} /> Use an editable name design</label>
			{#if !designEnabled}<p class="studio-hint studio-wide">Your existing font and name style are kept. Choose a preset or edit an effect to start a custom design.</p>{/if}
			<label class="studio-wide">Name effect<select bind:value={design.effect} onchange={changed}><option value="solid">Solid color</option><option value="gradient">Gradient</option><option value="glow">Glow</option><option value="shimmer">Slow shimmer</option></select></label>
			<label>Name color<input type="color" bind:value={design.color} oninput={changed} /></label>
			<label>Second color<input type="color" bind:value={design.color2} oninput={changed} /></label>
			<label class="studio-wide">Gradient angle <span>{Math.round(design.angle)}°</span><input type="range" min="0" max="360" step="1" bind:value={design.angle} oninput={changed} /></label>
			<label class="studio-wide">Glow strength <span>{design.glow} px</span><input type="range" min="0" max="12" step="1" bind:value={design.glow} oninput={changed} /></label>
			{#if design.effect === 'shimmer'}<label class="studio-wide">Animation cycle <span>{design.animationSeconds} seconds</span><input type="range" min="4" max="20" step="1" bind:value={design.animationSeconds} oninput={changed} /></label>{/if}
			<label class="studio-wide">Nameplate<select bind:value={design.plate} onchange={changed}><option value="none">None</option><option value="solid">Solid</option><option value="gradient">Gradient</option><option value="outline">Outline</option></select></label>
			{#if design.plate !== 'none'}
				<label>Plate color<input type="color" bind:value={design.plateColor} oninput={changed} /></label>
				<label>Second plate color<input type="color" bind:value={design.plateColor2} oninput={changed} /></label>
				<label class="studio-wide">Plate opacity <span>{Math.round(design.plateOpacity * 100)}%</span><input type="range" min="0" max="1" step="0.05" bind:value={design.plateOpacity} oninput={changed} /></label>
			{/if}
		</div>
		<div class="studio-preview-stack" aria-label="Live design previews">
			<p class="studio-kicker">Your draft in context</p>
			<div class="studio-preview studio-chat"><span class="studio-avatar" aria-hidden="true">{previewName.charAt(0).toUpperCase()}</span><div><div class="studio-preview-name"><ProfileName username={previewName} {font} color={$currentUser?.color} preview={true} /><span class="studio-timestamp">12:34</span></div><p>A little personality, wherever you show up.</p><span class="studio-context">Messages</span></div></div>
			<div class="studio-preview studio-person"><span class="studio-avatar" aria-hidden="true">{previewName.charAt(0).toUpperCase()}</span><div><ProfileName username={previewName} {font} color={$currentUser?.color} preview={true} /><span class="studio-context">People · Online</span></div></div>
			<div class="studio-preview studio-profile"><span class="studio-avatar" aria-hidden="true">{previewName.charAt(0).toUpperCase()}</span><ProfileName username={previewName} {font} color={$currentUser?.color} preview={true} /><span class="studio-context">Profile card</span></div>
			<p class="studio-hint">These previews show your design. Each viewer can show plain names, hide plates or pause motion. Your system’s reduced motion preference also pauses shimmer.</p>
		</div>
	</div>
	<div class="studio-actions"><button type="button" class="action-btn" disabled={saving} onclick={saveDesign}>{saving ? 'Publishing…' : 'Publish design'}</button><button type="button" class="action-btn secondary" disabled={saving} onclick={resetDraft}>Start plain</button><button type="button" class="action-btn secondary" onclick={downloadDesign}>Export design</button><button type="button" class="action-btn secondary" onclick={() => importInput?.click()}>Import design</button><input bind:this={importInput} type="file" accept=".json,application/json" class="hidden-file-input" onchange={importDesign} /></div>
	{#if feedback}<p class="studio-feedback" role="status">{feedback}</p>{/if}
	{#if error}<p class="studio-error" role="alert">{error}</p>{/if}
	<details class="studio-viewer-controls"><summary>How you see profiles</summary><ProfileAppearanceControls /></details>
</section>

<style>
	.profile-design-studio { container: profile-design / inline-size; display: grid; gap: 1rem; min-width: 0; }
	.studio-heading { display: flex; align-items: start; justify-content: space-between; gap: 1rem; }
	.studio-heading h3 { margin: 0 0 0.4rem; }
	.studio-kicker { margin: 0 0 0.45rem; color: var(--text-secondary); font-size: 0.7rem; font-weight: 750; text-transform: uppercase; letter-spacing: 0.07em; }
	.studio-hint { margin: 0; color: var(--text-secondary); font-size: 0.8rem; line-height: 1.5; }
	.studio-free-label { flex-shrink: 0; padding: 0.35rem 0.55rem; background: var(--surface-raised); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); color: var(--text-secondary); font-size: 0.7rem; }
	.studio-presets { display: grid; grid-template-columns: repeat(auto-fit, minmax(105px, 1fr)); gap: 0.5rem; }
	.studio-preset { display: grid; gap: 0.7rem; justify-items: start; min-width: 0; min-height: 80px; padding: 0.8rem; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--surface-raised); color: var(--text-heading); cursor: pointer; overflow: hidden; }
	.studio-preset:hover, .studio-preset.selected { border-color: var(--accent-primary-color); }
	.studio-preset.selected { box-shadow: inset 0 0 0 1px var(--accent-primary-color); }
	.studio-preset > span { color: var(--text-secondary); font-size: 0.68rem; }
	.studio-workbench { display: grid; grid-template-columns: minmax(220px, 1fr) minmax(230px, 0.9fr); gap: 1rem; align-items: start; }
	.studio-controls { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.7rem; }
	.studio-controls label { display: grid; gap: 0.3rem; color: var(--text-secondary); font-size: 0.78rem; font-weight: 650; min-width: 0; }
	.studio-controls label > span { color: var(--text-muted); font-size: 0.72rem; font-weight: 500; }
	.studio-wide { grid-column: 1 / -1; }
	.studio-controls .studio-check { display: flex; align-items: center; }
	.studio-controls .studio-check input { width: auto; min-height: 0; }
	.studio-controls :is(select, input:not([type='range'])) { min-width: 0; width: 100%; max-width: none; min-height: 40px; padding: 0.45rem 0.55rem; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); color: var(--text-heading); background: var(--surface-base); box-sizing: border-box; }
	.studio-controls input[type='color'] { padding: 3px; cursor: pointer; }
	.studio-controls input[type='range'] { width: 100%; accent-color: var(--accent-primary-color); }
	.studio-preview-stack { display: grid; gap: 0.7rem; position: sticky; top: 0.5rem; }
	.studio-preview { min-width: 0; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--surface-raised); padding: 1rem; display: flex; gap: 0.7rem; align-items: start; }
	.studio-preview > div { min-width: 0; }
	.studio-preview p { font-size: 0.8rem; margin: 0.35rem 0; color: var(--text-primary); }
	.studio-avatar { width: 32px; height: 32px; flex-shrink: 0; display: grid; place-items: center; background: var(--surface-sunken); color: var(--text-heading); border-radius: 50%; font-weight: 700; }
	.studio-preview-name { display: flex; align-items: baseline; gap: 0.45rem; flex-wrap: wrap; }
	.studio-timestamp, .studio-context { color: var(--text-muted); font-size: 0.67rem; }
	.studio-context { display: block; margin-top: 0.45rem; }
	.studio-profile { flex-direction: column; background: linear-gradient(180deg, var(--surface-sunken), var(--surface-raised)); }
	.studio-profile .studio-avatar { width: 44px; height: 44px; }
	.studio-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
	.studio-actions .action-btn { min-height: 40px; }
	.studio-feedback, .studio-error { margin: 0; font-size: 0.8rem; }
	.studio-feedback { color: var(--text-secondary); }
	.studio-error { color: var(--color-danger); }
	.studio-viewer-controls { padding-top: 0.9rem; border-top: 1px solid var(--border-subtle); }
	.studio-viewer-controls summary { cursor: pointer; font-size: 0.85rem; font-weight: 650; margin-bottom: 0.65rem; }
	.studio-viewer-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.65rem; margin-top: 0.8rem; }
	.studio-viewer-grid label { display: flex; align-items: center; gap: 0.45rem; font-size: 0.78rem; color: var(--text-secondary); }
	@container profile-design (max-width: 540px) { .studio-workbench { grid-template-columns: minmax(0, 1fr); } .studio-preview-stack { position: static; } .studio-heading { flex-direction: column; gap: 0.5rem; } }
	@media (max-width: 760px) { .studio-workbench { grid-template-columns: minmax(0, 1fr); } .studio-preview-stack { position: static; } .studio-heading { flex-direction: column; gap: 0.5rem; } }
	@media (max-width: 420px) { .studio-viewer-grid { grid-template-columns: 1fr; } .studio-presets { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
