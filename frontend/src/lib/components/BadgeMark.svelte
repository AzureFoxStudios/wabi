<script lang="ts">
	import { DEFAULT_OWNER_BADGE_MARK, DEFAULT_STAFF_BADGE_MARK } from '$lib/badgeMarks';

	// Renders the owner/staff mark. The built-in default marks are drawn as SVG
	// (consistent stroke, follows currentColor); an operator-chosen custom mark
	// is still rendered as the text they typed.
	let { kind, mark }: { kind: 'owner' | 'staff'; mark: string } = $props();

	const isDefault = $derived(mark === (kind === 'owner' ? DEFAULT_OWNER_BADGE_MARK : DEFAULT_STAFF_BADGE_MARK));
</script>

{#if isDefault}
	<svg class="badge-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
		{#if kind === 'owner'}
			<path d="M4 17l-1-9 5 4 4-7 4 7 5-4-1 9zM5 20h14" />
		{:else}
			<path d="M6 4h12l3 5-9 11L3 9zM3 9h18M9 4l-1 5 4 11M15 4l1 5-4 11" />
		{/if}
	</svg>
{:else}
	<span aria-hidden="true">{mark}</span>
{/if}

<style>
	.badge-glyph {
		width: 1.1em;
		height: 1.1em;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
		vertical-align: -0.15em;
	}
</style>
