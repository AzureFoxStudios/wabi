<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { brandName } from '$lib/branding';
	import { openPlannerSurface } from '$lib/plannerWorkspace';

	onMount(() => {
		if (!browser) return;
		// Legacy /business URLs land in the main Planner workspace, honoring ?view=.
		const view = new URL(window.location.href).searchParams.get('view');
		if (view === 'calendar' || view === 'board' || view === 'journal' || view === 'projects') {
			sessionStorage.setItem('plannerDeepLinkView', view);
		}
		openPlannerSurface();
		window.location.replace('/');
	});
</script>

<svelte:head>
	<title>Planner · {brandName}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<p>Taking you to Planner…</p>

<style>
	p {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 100vh;
		margin: 0;
		color: var(--text-muted, #9999ff);
		font-family: var(--font-sans, sans-serif);
		font-size: 14px;
	}
</style>
