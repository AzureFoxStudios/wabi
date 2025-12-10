<script lang="ts">
	import '../app.css';
	import '$lib/prism-theme.css';
	import type { PageData } from './$types';
	import { onMount } from 'svelte';
	import { initSocket } from '$lib/socket';

	// Accept data prop to suppress warning (we don't use it in root layout)
	export let data: PageData;

	onMount(() => {
		// Initialize socket connection in background (non-blocking)
		const username = localStorage.getItem('username') || `User${Math.floor(Math.random() * 1000)}`;
		localStorage.setItem('username', username);
		initSocket(username);
	});
</script>

<!-- Calling components disabled - re-enable after testing basic functionality -->
<!-- <IncomingCallModal /> -->
<!-- <CallView /> -->

<slot />
