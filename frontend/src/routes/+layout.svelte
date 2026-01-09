<script lang="ts">
	import '../app.css';
	import '$lib/prism-theme.css';
	import type { PageData } from './$types';
	import { onMount } from 'svelte';
	import { initSocket } from '$lib/socket';
  import PureRefViewer from '$lib/components/PureRefViewer.svelte';

	// Accept data prop to suppress warning (we don't use it in root layout)
	export let data: PageData;

	onMount(() => {
		// Register service worker for PWA support
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.register('/sw.js').then((registration) => {
				console.log('✅ Service Worker registered:', registration);
			}).catch((error) => {
				console.error('❌ Service Worker registration failed:', error);
			});
		}

		// Only initialize socket if user has a saved session (from explicit login)
		// Don't auto-login on page load - user must submit login form first
		const username = localStorage.getItem('username');
		const sessionId = localStorage.getItem('sessionId');

		if (username && sessionId) {
			// User has a saved session, reconnect them
			initSocket(username);
		}
	});
</script>

<!-- Calling components disabled - re-enable after testing basic functionality -->
<!-- <IncomingCallModal /> -->
<!-- <CallView /> -->

<PureRefViewer />

<slot />
