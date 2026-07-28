<script lang="ts">
	import { onMount } from 'svelte';
	import { openPlannerSurface } from '$lib/plannerWorkspace';
</script>

<svelte:head>
	<title>Planner · Wabi</title>
	<meta name="robots" content="noindex" />
</svelte:head>

{#if typeof window !== 'undefined'}
	<!-- Redirect legacy /business URLs to the main Planner workspace. -->
{/if}
