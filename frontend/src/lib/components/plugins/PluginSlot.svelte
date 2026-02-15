<script lang="ts">
	import { onMount } from 'svelte';
	import { channels, currentChannel } from '$lib/socket';
	import { pluginRegistry } from '$lib/plugins/registry';

	export let point: 'sidebar' | 'commands' | 'channelViews' = 'sidebar';

	let extensions: Array<{ pluginId: string; pluginName: string; extension: { component: any }; loadError?: string }> = [];

	$: activeChannelType = $channels.find((channel) => channel.id === $currentChannel)?.type;

	$: if (point === 'sidebar') {
		extensions = pluginRegistry.resolveSidebarExtensions();
	} else if (point === 'channelViews') {
		extensions = pluginRegistry.resolveChannelViews(activeChannelType);
	} else {
		extensions = [];
	}

	onMount(() => {
		void pluginRegistry.hydrateFromServer();
	});
</script>

{#if point === 'commands'}
	<!-- commands are resolved by consumers through pluginRegistry.resolveCommandExtensions() -->
{:else}
	<div class="plugin-slot plugin-slot-{point}">
		{#each extensions as extension (extension.pluginId)}
			{#if extension.loadError}
				<div class="plugin-fallback" role="status">
					<strong>{extension.pluginName}</strong>
					<span>Failed to load extension.</span>
				</div>
			{:else if extension.extension?.component}
				<svelte:component
					this={extension.extension.component}
					pluginId={extension.pluginId}
					pluginName={extension.pluginName}
					channelType={activeChannelType}
				/>
			{/if}
		{/each}
	</div>
{/if}

<style>
	.plugin-slot {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.plugin-fallback {
		display: flex;
		flex-direction: column;
		padding: 0.5rem;
		border: 1px solid rgba(var(--border-rgb), var(--opacity-light));
		border-radius: 0.5rem;
		background: rgba(var(--bg-secondary-rgb), 0.55);
		font-size: 0.8rem;
	}
</style>
