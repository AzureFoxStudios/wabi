<script lang="ts">
	import BackgroundImageEditorLegacy from './BackgroundImageEditorLegacy.svelte';
	import ChatBackdropSettings from './settings/ChatBackdropSettings.svelte';
</script>

<div class="chat-background-stack">
	<ChatBackdropSettings />
	<div class="background-divider" aria-hidden="true"></div>
	<BackgroundImageEditorLegacy />
</div>

<style>
	.chat-background-stack {
		display: grid;
		gap: 1rem;
	}

	.background-divider {
		height: 1px;
		background: color-mix(in srgb, var(--border-subtle) 75%, transparent);
	}
</style>
