<script lang="ts">
	import { onMount } from 'svelte';
	import ChatBackdrop from './ChatBackdrop.svelte';
	import {
		loadChatBackdropSettings,
		type ChatBackdropSettings
	} from '$lib/theme/chatBackdrop';

	let settings: ChatBackdropSettings = loadChatBackdropSettings();

	onMount(() => {
		const sync = (event?: Event) => {
			const custom = event as CustomEvent<ChatBackdropSettings>;
			settings = custom?.detail ? { ...custom.detail } : loadChatBackdropSettings();
		};
		window.addEventListener('wabi:chat-backdrop-change', sync as EventListener);
		window.addEventListener('storage', sync);
		return () => {
			window.removeEventListener('wabi:chat-backdrop-change', sync as EventListener);
			window.removeEventListener('storage', sync);
		};
	});
</script>

<ChatBackdrop
	scene={settings.scene}
	motion={settings.motion}
	dim={settings.dim}
	frost={settings.frost}
/>
