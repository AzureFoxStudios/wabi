<script lang="ts">
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import PlannerWorkspace from '$lib/components/business/PlannerWorkspace.svelte';
	import { flushBusinessStorage, plannerStorage } from '$lib/business/deviceStorage';
	import { initializeTheme } from '$lib/theme/initTheme';
	import { isDesktopTauri } from '$lib/tauri-platform';
	let desktop = $state(false);
	onMount(() => { desktop = isDesktopTauri(); void initializeTheme(false); });
	async function leave() {
		if (!get(plannerStorage).dirty || await flushBusinessStorage()) window.location.assign('/');
	}
</script>

<svelte:head><title>Personal workspace · Wabi</title><meta name="robots" content="noindex" /></svelte:head>
<main class="personal-shell">
	<header class="personal-header">
		<div><p class="eyebrow">Your own space</p><h1>Personal Planner</h1><p>Calendar, tasks, journal and projects. No community account needed.</p></div>
		<button onclick={leave}>Communities</button>
	</header>
	<p class="personal-policy">{desktop ? 'Stored in your Wabi app folder. Works offline.' : 'Stored in this browser. Export a backup to keep a separate copy.'} Sharing and AI are off.</p>
	<section class="personal-content"><PlannerWorkspace /></section>
</main>
<style>
	.personal-shell { height: calc(100dvh - var(--desktop-titlebar-height, 0px)); min-height: 0; display: flex; flex-direction: column; background: var(--surface-base); color: var(--text-primary); }
	.personal-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1.25rem 1.5rem 0.75rem; border-bottom: 1px solid var(--border-default); }
	.eyebrow { color: var(--accent-primary); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; }
	h1 { font-size: 1.35rem; margin: 0.2rem 0; } p { margin: 0.2rem 0; } .personal-header div > p:last-child { color: var(--text-secondary); font-size: 0.85rem; }
	button { min-height: 40px; padding: 0.5rem 0.9rem; border: 1px solid var(--border-default); border-radius: var(--radius-md); background: var(--surface-raised); color: var(--text-primary); }
	.personal-policy { color: var(--text-secondary); padding: 0.5rem 1.5rem; font-size: 0.75rem; }
	.personal-content { flex: 1; min-height: 0; }
	@media (max-width: 600px) { .personal-header { align-items: flex-start; padding: 1rem; } .personal-policy { padding: 0.5rem 1rem; } }
</style>
