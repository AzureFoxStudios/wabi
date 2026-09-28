<script lang="ts">
	import { onMount } from 'svelte';
	import { canUseDesktopHosting } from '$lib/desktopHosting';
	let available = $state(false);
	onMount(() => {
		let active = true;
		void canUseDesktopHosting().then(value => { if (active) available = value; });
		return () => { active = false; };
	});
</script>

{#if available}
	<a href="/host" class="hosting-link">My communities &amp; hosting settings <span aria-hidden="true">↗</span></a>
{/if}

<style>
	.hosting-link { display: inline-flex; align-items: center; gap: var(--space-2); min-height: 44px; padding: var(--space-2) 0; color: var(--accent-secondary); font-size: var(--font-size-sm); text-decoration: none; }
	.hosting-link:hover { text-decoration: underline; }
	.hosting-link:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 4px; border-radius: var(--radius-sm); }
</style>
