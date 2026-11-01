<!--
	The one icon component (design contract §6): <Icon name="search" size={16} />.

	- Geometry comes from the registry in ./icons.ts; this component owns the presentation
	  (24 grid, no fill, currentColor stroke 1.75, round caps and joins).
	- Decorative by default (aria-hidden, not focusable): the control around it carries the
	  words or the aria-label. Pass `label` only when the glyph stands alone and means
	  something on its own; it then becomes role="img" with that name.
	- `size` sets the width/height attributes (px for a number, any CSS length for a string).
	  Kit rules such as `.w-btn > svg` size glyphs by context and win over the attributes.
	- Colour is inherited: --w-mute idle, --w-text on hover, --w-sig for location,
	  --w-accent for on, all set by the host control.
-->
<script lang="ts">
	import type { SVGAttributes } from 'svelte/elements';
	import { ICONS, ICON_STROKE, isIconName, type IconName } from './icons';

	interface Props extends Omit<SVGAttributes<SVGSVGElement>, 'name' | 'children' | 'stroke'> {
		name: IconName;
		size?: number | string;
		/** Stroke width; the contract uses 1.75 everywhere except the 12px checkbox check. */
		stroke?: number;
		/** Accessible name for a glyph that stands alone. Omit for decorative icons. */
		label?: string;
		class?: string;
	}

	let { name, size = 18, stroke = ICON_STROKE, label, class: className = '', ...rest }: Props = $props();

	const known = $derived(isIconName(name));
	const body = $derived(known ? ICONS[name] : '');
	const dimension = $derived(typeof size === 'number' ? String(size) : size);

	$effect(() => {
		if (!known && import.meta.env?.DEV) console.warn(`[Icon] unknown icon name "${String(name)}"`);
	});
</script>

<svg
	{...rest}
	class={className ? `w-icon ${className}` : 'w-icon'}
	width={dimension}
	height={dimension}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width={stroke}
	stroke-linecap="round"
	stroke-linejoin="round"
	focusable="false"
	data-icon={name}
	role={label ? 'img' : undefined}
	aria-label={label || undefined}
	aria-hidden={label ? undefined : 'true'}
>{@html body}</svg>

<style>
	.w-icon {
		flex: none;
	}
	/* Decorative glyphs never catch the pointer: the control around them owns hover and clicks. */
	.w-icon[aria-hidden='true'] {
		pointer-events: none;
	}
</style>
