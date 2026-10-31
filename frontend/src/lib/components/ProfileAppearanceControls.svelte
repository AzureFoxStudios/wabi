<script lang="ts">
	/**
	 * How other people's profiles look on this device (§8.9): switch rows on the kit. These
	 * choices never change anyone's saved design.
	 */
	import { profileAppearance, setProfileAppearance } from '$lib/profileAppearance';

	const effects = [
		{ key: 'names', label: 'Styled names' },
		{ key: 'plates', label: 'Nameplates' },
		{ key: 'decorations', label: 'Banners and avatar decorations' },
		{ key: 'animate', label: 'Artwork and name animation' }
	] as const;
</script>

<section class="settings-block" aria-labelledby="profile-cosmetics-title">
	<h3 class="settings-block__title" id="profile-cosmetics-title">Profile decorations</h3>
	<p class="settings-block__hint">How profiles look on this device. Nobody's saved design changes.</p>
	<div class="w-srows">
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="profile-cosmetics-plain">Show profiles plainly</p>
				<p class="w-srow__hint">Turns every effect below off. Your choices come back when you turn this off.</p>
			</div>
			<div class="w-srow__control">
				<button
					type="button"
					class="w-switch"
					role="switch"
					aria-labelledby="profile-cosmetics-plain"
					aria-checked={!$profileAppearance.showCosmetics}
					onclick={() => setProfileAppearance({ showCosmetics: !$profileAppearance.showCosmetics })}
				></button>
			</div>
		</div>
		{#each effects as effect (effect.key)}
			<div class="w-srow">
				<div class="w-srow__text">
					<p class="w-srow__label" id={`profile-cosmetics-${effect.key}`}>{effect.label}</p>
				</div>
				<div class="w-srow__control">
					<button
						type="button"
						class="w-switch"
						role="switch"
						aria-labelledby={`profile-cosmetics-${effect.key}`}
						aria-checked={$profileAppearance[effect.key]}
						disabled={!$profileAppearance.showCosmetics}
						onclick={() => setProfileAppearance({ [effect.key]: !$profileAppearance[effect.key] })}
					></button>
				</div>
			</div>
		{/each}
	</div>
	<p class="profile-cosmetics__note">Reduce motion also keeps profile artwork still.</p>
</section>

<style>
	.profile-cosmetics__note {
		margin: 10px 0 0;
		color: var(--w-mute);
		font: var(--w-t-small);
	}
</style>
