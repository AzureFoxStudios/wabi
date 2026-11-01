<!--
	Load line (design contract §7.16), kit `.w-loadline`: a 2px indeterminate --w-accent line
	under the masthead while a surface loads, paired with skeleton rows shaped like the real
	layout. Under reduced motion the kit leaves a static 34% segment.

	The line waits `delay` ms before it appears, so a fast load never flashes it. The host
	positions it (usually at the bottom edge of the masthead, over the rule).

	  <LoadLine active={loading} label="Loading documents" />
-->
<script lang="ts">
	interface Props {
		active?: boolean;
		/** Accessible name of the progress bar. */
		label?: string;
		/** Milliseconds before the line shows. */
		delay?: number;
		class?: string;
		style?: string;
	}

	let { active = true, label = 'Loading', delay = 150, class: className = '', style }: Props = $props();

	let shown = $state(false);

	$effect(() => {
		if (!active) {
			shown = false;
			return;
		}
		if (delay <= 0) {
			shown = true;
			return;
		}
		const timer = setTimeout(() => (shown = true), delay);
		return () => clearTimeout(timer);
	});
</script>

{#if active && shown}
	<div class={['w-loadline', className]} {style} role="progressbar" aria-label={label} aria-busy="true"></div>
{/if}
