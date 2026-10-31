<script lang="ts">
	/**
	 * Planner avatar: the person's profile picture when there is one, otherwise an identity stamp
	 * (design contract §7.12, §5.5). The stamp is the person's colour as a disc mixed into the
	 * surface (`--disc`) with the initial in their ink nudged to 4.5:1 on it (`--on`), computed per
	 * theme by `$inkFor` — never the raw pastel with a white letter. Below 28px the initial is
	 * sans 500; at 28px and up it is a serif 600 stamp. Joker's squares come from --w-avr.
	 * Sizes are the contract's (§7.12): `sm` 20 and `md` 28. `xs` is kept for older callers and
	 * draws the 20px stamp too: the smallest stamp the contract allows (its initial is 10px;
	 * 16px would put an 8px letter under the type floor).
	 * Used on kanban cards, the day dialog, Tasks rows, Gantt bars and signature chips.
	 *
	 * Svelte 4 (`export let`) — matches the business tree.
	 */
	import { inkFor } from '$lib/theme/identity';

	export let name = '';
	/** The person's chosen colour (user data, any hex); '' draws a neutral stamp. */
	export let color = '';
	export let src: string | undefined = undefined;
	export let size: 'xs' | 'sm' | 'md' = 'sm';
	/** Stacked-group rendering (overlapping avatars). */
	export let stacked = false;
	/** Accessible label; without one the avatar is decorative (the row says the name). */
	export let label = '';

	const sizePx: Record<'xs' | 'sm' | 'md', number> = { xs: 20, sm: 20, md: 28 };

	$: px = sizePx[size];
	$: initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
	$: title = label || name || '';
	$: stamp = $inkFor(color);
</script>

<span
	class="planner-avatar"
	class:stacked
	class:serif={px >= 28}
	style="--avatar-size: {px}px; {stamp}"
	{title}
	role={label ? 'img' : undefined}
	aria-label={label || undefined}
	aria-hidden={label ? undefined : 'true'}
>
	{#if src}
		<img class="planner-avatar-img" {src} alt="" loading="lazy" />
	{:else}
		<span class="planner-avatar-initial">{initial}</span>
	{/if}
</span>

<style>
	.planner-avatar {
		flex: none;
		display: inline-grid;
		place-items: center;
		box-sizing: border-box;
		width: var(--avatar-size);
		height: var(--avatar-size);
		overflow: hidden;
		border-radius: var(--w-avr);
		/* Without a colour the stamp is a quiet raise disc with a muted initial. */
		background: var(--disc, var(--w-raise));
		color: var(--on, var(--w-mute));
		user-select: none;
	}
	/* Overlapping stamps keep a ring in the surface colour so each edge reads. */
	.planner-avatar.stacked {
		box-shadow: 0 0 0 2px var(--pres-ring, var(--w-bg));
	}
	:global(.planner-avatar + .planner-avatar) {
		margin-left: -4px;
	}
	.planner-avatar-img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.planner-avatar-initial {
		font: 500 min(calc(var(--avatar-size) * 0.5 * var(--w-fs, 1)), calc(var(--avatar-size) * 0.62)) / 1 var(--w-sans);
	}
	.planner-avatar.serif .planner-avatar-initial {
		font: 600 min(calc(var(--avatar-size) * 0.44 * var(--w-fs, 1)), calc(var(--avatar-size) * 0.56)) / 1 var(--w-serif);
	}
</style>
