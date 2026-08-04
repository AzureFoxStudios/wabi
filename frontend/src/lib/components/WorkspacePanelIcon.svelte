<script lang="ts">
	import type { WorkspacePanelIcon } from '$lib/workspacePanels';

	export let icon: WorkspacePanelIcon = 'box';
</script>

{#if icon === 'users'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
		<path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"></path>
		<circle cx="9" cy="7" r="4"></circle>
		<path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
		<path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
	</svg>
{:else if icon === 'messages'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
		<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-2.92-.39-4.15-1.08L3 20l1.15-4.77A8.5 8.5 0 1 1 21 11.5z"></path>
	</svg>
{:else if icon === 'notes'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
		<path d="M4 4h16v16H4z"></path>
		<path d="M8 8h8"></path>
		<path d="M8 12h8"></path>
		<path d="M8 16h5"></path>
	</svg>
{:else if icon === 'map'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
		<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"></path>
		<path d="M9 4v14"></path>
		<path d="M15 6v14"></path>
	</svg>
{:else if icon === 'media'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
		<rect x="3" y="3" width="18" height="18" rx="2"></rect>
		<circle cx="8.5" cy="8.5" r="1.5"></circle>
		<path d="M21 15l-5-5L5 21"></path>
	</svg>
{:else if icon === 'admin' || icon === 'settings'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
		<circle cx="12" cy="12" r="3"></circle>
		<path d="M12 1v6m0 10v6M4.93 4.93l4.24 4.24m-4.24 10.28l4.24-4.24M23 12h-6m0 0v6m0-6V6a6 6 0 0 0-12 0v12a6 6 0 0 0 12 0v-6"></path>
	</svg>
{:else if icon === 'activity'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
		<path d="M22 12h-4l-3 9L9 3l-3 9H2"></path>
	</svg>
{:else if icon === 'transfers'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
		<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
		<polyline points="7 10 12 15 17 10"></polyline>
		<line x1="12" y1="15" x2="12" y2="3"></line>
	</svg>
{:else}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
		<rect x="3" y="3" width="18" height="18" rx="2"></rect>
		<path d="M3 9h18"></path>
		<path d="M9 21V9"></path>
	</svg>
{/if}

<style>
	svg {
		width: 100%;
		height: 100%;
		display: block;
	}
</style>
