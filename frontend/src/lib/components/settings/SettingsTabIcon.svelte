<script lang="ts">
	export let id: string;
</script>

{#if id === 'profile'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
		<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
		<circle cx="12" cy="7" r="4"></circle>
	</svg>
{:else if id === 'audio'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
		<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
		<path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
		<path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
	</svg>
{:else if id === 'notifications'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
		<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
		<path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
	</svg>
{:else if id === 'accessibility'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
		<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
		<circle cx="12" cy="12" r="3"></circle>
	</svg>
{:else if id === 'appearance'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
		<path d="M12 2a10 10 0 0 0 0 20c1.1 0 2-.9 2-2v-1c0-.55.45-1 1-1h2a5 5 0 0 0 5-5C22 6.5 17.52 2 12 2z"></path>
		<circle cx="7.5" cy="11.5" r="1"></circle>
		<circle cx="10.5" cy="7.5" r="1"></circle>
		<circle cx="15" cy="8" r="1"></circle>
	</svg>
{:else if id === 'server'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
		<rect x="2" y="2" width="20" height="8" rx="2"></rect>
		<rect x="2" y="14" width="20" height="8" rx="2"></rect>
		<line x1="6" y1="6" x2="6.01" y2="6"></line>
		<line x1="6" y1="18" x2="6.01" y2="18"></line>
	</svg>
{:else if id === 'addons'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
		<path d="m12 3 8 4-8 4-8-4 8-4Z"></path>
		<path d="m4 12 8 4 8-4"></path>
		<path d="m4 17 8 4 8-4"></path>
	</svg>
{:else if id === 'emojis'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
		<circle cx="12" cy="12" r="10"></circle>
		<path d="M8 14s1.5 2 4 2 4-2 4-2"></path>
		<line x1="9" y1="9" x2="9.01" y2="9"></line>
		<line x1="15" y1="9" x2="15.01" y2="9"></line>
	</svg>
{:else if id === 'storage'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
		<ellipse cx="12" cy="5" rx="9" ry="3"></ellipse>
		<path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path>
		<path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path>
	</svg>
{:else if id === 'admin'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
		<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
	</svg>
{:else if id === 'about'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
		<circle cx="12" cy="12" r="10"></circle>
		<line x1="12" y1="16" x2="12" y2="12"></line>
		<line x1="12" y1="8" x2="12.01" y2="8"></line>
	</svg>
{:else if id === 'logout'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
		<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
		<polyline points="16 17 21 12 16 7"></polyline>
		<line x1="21" y1="12" x2="9" y2="12"></line>
	</svg>
{/if}

<style>
	svg {
		width: 100%;
		height: 100%;
		display: block;
	}
</style>
