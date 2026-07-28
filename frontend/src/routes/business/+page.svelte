<script lang="ts">
	import { onMount } from 'svelte';
	import { openPlannerSurface } from '$lib/plannerWorkspace';
</script>

<svelte:head>
	<title>Planner · Wabi</title>
	<meta name="robots" content="noindex" />
</svelte:head>

{#if typeof window !== 'undefined'}
	<!-- Preserve legacy /business URLs by opening Planner in the main app shell. -->
{/if}
