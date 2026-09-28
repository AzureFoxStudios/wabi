<script lang="ts">
	import { PROFILE_ART_EXAMPLES, type ProfileArtExample } from '$lib/profileArtExamples';
	import { profileMotionAllowed } from '$lib/profileAppearance';
	import ProfileName from './ProfileName.svelte';
	import ProfileMedia from './ProfileMedia.svelte';

	let { onUseDesign }: { onUseDesign: (example: ProfileArtExample) => void } = $props();
	let playing = $state(false);
</script>

<section class="art-examples" aria-labelledby="art-examples-heading">
	<div class="examples-heading">
		<div><h4 id="art-examples-heading">Try a complete look</h4><p>Example artwork and editable name designs. Downloads are separate; choose what to use.</p></div>
		<button type="button" class="examples-motion" disabled={!$profileMotionAllowed} aria-pressed={playing && $profileMotionAllowed} onclick={() => playing = !playing}>{playing && $profileMotionAllowed ? 'Pause example' : 'Play animated example'}</button>
	</div>
	{#if !$profileMotionAllowed}<p class="examples-motion-note">Animation is paused by your appearance or reduced motion settings.</p>{/if}
	<div class="examples-grid">
		{#each PROFILE_ART_EXAMPLES as example (example.id)}
			<article class="example-card">
				<div class="example-banner"><ProfileMedia src={example.animation && playing && $profileMotionAllowed ? example.banner : example.still} alt={`${example.title} banner example`} class="example-banner-image" /></div>
				<div class="example-person"><span class="example-avatar" aria-hidden="true">A</span><strong><ProfileName username="Your name" font={example.usernameFont} preview={true} /></strong><span class="example-handle">@your-handle · example</span></div>
				<div class="example-info"><h5>{example.title}</h5><p>{example.description}</p><span class="example-spec">{example.canvas}{example.animation ? ` · ${example.animation}` : ''}</span></div>
				<div class="example-downloads"><a href={example.banner} download>Download banner · {example.animation ? 'WebP' : 'PNG'}</a>{#if example.gif}<a href={example.gif} download>GIF version</a><a href={example.still} download>Still image · PNG</a>{/if}<a href={example.nameFile} download>Name design · JSON</a>{#if example.source}<a href={example.source} download>Editable animation source</a>{/if}</div>
				<button type="button" class="example-edit" onclick={() => onUseDesign(example)}>Edit {example.title} name design</button>
			</article>
		{/each}
	</div>
	<p class="examples-footnote">Editing loads the name and plate into your draft. Publish design applies it to your profile. Download a banner and use Upload banner to add the artwork.</p>
	<a class="examples-pack" href="/profile-art/examples/profile-examples.zip" download>Download both examples, designs & source · ZIP</a>
</section>

<style>
	.art-examples { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border-subtle); min-width: 0; }
	.examples-heading { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: start; gap: 0.65rem; }
	.examples-heading > div { flex: 1 1 200px; }
	h4, h5 { color: var(--text-heading); margin: 0; }
	h4 { font-size: 0.9rem; }
	h5 { font-size: 0.85rem; }
	.art-examples p { color: var(--text-secondary); line-height: 1.5; font-size: 0.78rem; margin: 0.45rem 0; }
	.examples-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.8rem; margin-top: 0.8rem; }
	.example-card { display: flex; flex-direction: column; min-width: 0; overflow: hidden; border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); background: var(--surface-raised); }
	.example-banner { aspect-ratio: 3 / 1; background: var(--surface-sunken); overflow: hidden; }
	.example-banner :global(.example-banner-image) { display: block; width: 100%; height: 100%; object-fit: cover; }
	.example-person { display: grid; justify-items: start; padding: 0 0.8rem; gap: 0.35rem; }
	.example-avatar { display: grid; place-items: center; width: 42px; height: 42px; margin-top: -21px; border: 3px solid var(--surface-raised); border-radius: var(--radius-lg); background: var(--surface-base); color: var(--text-heading); font-weight: 700; }
	.example-person strong { min-width: 0; max-width: 100%; }
	.example-handle { font-size: 0.7rem; color: var(--text-muted); }
	.example-info { padding: 0.8rem 0.8rem 0; }
	.example-spec { font-size: 0.68rem; color: var(--text-muted); line-height: 1.6; }
	.example-downloads { display: flex; flex-wrap: wrap; align-content: start; gap: 0.4rem 0.7rem; padding: 0.7rem 0.8rem; flex: 1; }
	.example-downloads a { color: var(--accent-primary-color); font-size: 0.74rem; line-height: 1.4; text-underline-offset: 3px; }
	.examples-motion, .example-edit { color: var(--text-heading); background: var(--surface-base); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 0.5rem 0.65rem; font: inherit; font-size: 0.75rem; line-height: 1.5; cursor: pointer; }
	.example-edit { margin: 0 0.8rem 0.8rem; text-align: start; }
	.examples-motion:hover, .example-edit:hover { border-color: var(--accent-primary-color); }
	.examples-motion:disabled { opacity: 0.65; cursor: default; }
	.examples-motion:focus-visible, .example-edit:focus-visible, a:focus-visible { outline: 2px solid var(--accent-primary-color); outline-offset: 3px; }
	.examples-footnote { margin-top: 0.8rem !important; }
	.examples-pack { display: inline-block; color: var(--accent-primary-color); font-size: 0.78rem; text-underline-offset: 3px; }
	@media (max-width: 600px) { .examples-grid { grid-template-columns: minmax(0, 1fr); } }
	@media (pointer: coarse) { .examples-motion, .example-edit { min-height: 44px; } .example-downloads a { padding-block: 0.35rem; } }
</style>
