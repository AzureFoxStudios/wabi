<script lang="ts">
	import { profileAppearance, setProfileAppearance } from '$lib/profileAppearance';
</script>

<section class="profile-viewer-controls" aria-label="Profile cosmetics">
	<h3>Profile cosmetics</h3>
	<p>Choose how profiles look on this device. These choices do not change anyone’s saved design.</p>
	<label class="plain-control"><input type="checkbox" checked={!$profileAppearance.showCosmetics} onchange={(event) => setProfileAppearance({ showCosmetics: !event.currentTarget.checked })} /> Show profiles plainly</label>
	<div class="viewer-options">
		<label><input type="checkbox" disabled={!$profileAppearance.showCosmetics} checked={$profileAppearance.names} onchange={(event) => setProfileAppearance({ names: event.currentTarget.checked })} /> Styled names</label>
		<label><input type="checkbox" disabled={!$profileAppearance.showCosmetics} checked={$profileAppearance.plates} onchange={(event) => setProfileAppearance({ plates: event.currentTarget.checked })} /> Nameplates</label>
		<label><input type="checkbox" disabled={!$profileAppearance.showCosmetics} checked={$profileAppearance.decorations} onchange={(event) => setProfileAppearance({ decorations: event.currentTarget.checked })} /> Banners & avatar decorations</label>
		<label><input type="checkbox" disabled={!$profileAppearance.showCosmetics} checked={$profileAppearance.animate} onchange={(event) => setProfileAppearance({ animate: event.currentTarget.checked })} /> Profile artwork & name animation</label>
	</div>
	<p class="motion-hint">Reduced motion also keeps profile artwork still. Your choices for individual effects are remembered when you leave plain mode.</p>
</section>

<style>
	.profile-viewer-controls { display: grid; gap: 0.75rem; }
	h3, p { margin: 0; }
	p { font-size: 0.8rem; line-height: 1.5; color: var(--text-secondary); }
	label { display: flex; align-items: center; gap: 0.5rem; font-size: 0.82rem; color: var(--text-heading); }
	.plain-control { font-weight: 650; padding: 0.8rem; background: var(--surface-raised); border-radius: var(--radius-md); }
	.viewer-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.7rem; }
	.motion-hint { color: var(--text-muted); font-size: 0.75rem; }
	@media (max-width: 600px) { .viewer-options { grid-template-columns: 1fr; } }
</style>
