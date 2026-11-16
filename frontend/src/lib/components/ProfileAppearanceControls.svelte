<script lang="ts">
	import { _ } from '$lib/i18n';
	/**
	 * How other people's profiles look on this device (§8.9): switch rows on the kit. These
	 * choices never change anyone's saved design.
	 */
	import { profileAppearance, setProfileAppearance } from '$lib/profileAppearance';

	const effects = [
		{ key: 'names', label: $_('profile_cosmetics.names') },
		{ key: 'plates', label: $_('profile_cosmetics.plates') },
		{ key: 'decorations', label: $_('profile_cosmetics.decorations') },
		{ key: 'animate', label: $_('profile_cosmetics.animate') }
	] as const;
</script>

<section class="settings-block" aria-labelledby="profile-cosmetics-title">
	<h3 class="settings-block__title" id="profile-cosmetics-title">{$_('profile_cosmetics.title')}</h3>
	<p class="settings-block__hint">{$_('profile_cosmetics.hint')}</p>
	<div class="w-srows">
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="profile-cosmetics-plain">{$_('profile_cosmetics.plain')}</p>
				<p class="w-srow__hint">{$_('profile_cosmetics.plain_hint')}</p>
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
	<p class="profile-cosmetics__note">{$_('profile_cosmetics.reduce_motion')}</p>
</section>

<style>
	.profile-cosmetics__note {
		margin: 10px 0 0;
		color: var(--w-mute);
		font: var(--w-t-small);
	}
</style>
