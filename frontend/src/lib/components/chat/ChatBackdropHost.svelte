<script lang="ts">
	import { themeStore, backgroundImageSetting, resolveEffectiveBackgroundImage } from '$lib/theme/themeStore';
	import { onMount } from 'svelte';
	import ChatBackdrop from './ChatBackdrop.svelte';
	import {
		loadChatBackdropSettings,
		type ChatBackdropSettings
	} from '$lib/theme/chatBackdrop';

	let settings: ChatBackdropSettings = loadChatBackdropSettings();
	let revision = 0;
	$: bg = resolveEffectiveBackgroundImage($backgroundImageSetting, $themeStore.customTheme);
	$: settings = (revision, loadChatBackdropSettings(!!bg?.url));
	$: video = !!bg?.url && /\.(mp4|webm|mov)(\?|$)/i.test(bg.url);

	onMount(() => {
		const sync = (event?: Event) => {

			revision += 1;
		};
		window.addEventListener('wabi:chat-backdrop-change', sync as EventListener);
		window.addEventListener('storage', sync);
		return () => {
			window.removeEventListener('wabi:chat-backdrop-change', sync as EventListener);
			window.removeEventListener('storage', sync);
		};
	});
</script>

<div class="chat-backdrop-host" aria-hidden="true">
{#if settings.scene === 'image' && bg?.url}
	{#if video}<video src={bg.url} autoplay muted loop playsinline style:opacity={bg.opacity ?? 0.3} style:filter={`blur(${bg.blur ?? 0}px)`} style:mix-blend-mode={bg.blend ?? 'normal'}></video>
	{:else}<div class="image" style:background-size={bg.size ?? 'cover'} style:background-position={(bg.position ?? 'center').replaceAll('-', ' ')} style:background-repeat={bg.repeat ?? 'no-repeat'} style:background-image={`url(${JSON.stringify(bg.url)})`} style:opacity={bg.opacity ?? 0.3} style:filter={`blur(${bg.blur ?? 0}px)`} style:mix-blend-mode={bg.blend ?? 'normal'}></div>{/if}
{/if}
<ChatBackdrop
	scene={settings.scene}
	motion={settings.motion}
	dim={settings.dim}
	frost={settings.frost}
/>

</div>
<style>
.chat-backdrop-host{position:absolute;inset:0;pointer-events:none;overflow:hidden}video,.image{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background-size:cover;background-position:center}
:global(.chat-container:has(.chat-backdrop-host)::before){display:none}
</style>
