<script lang="ts">
	import type { AdminChannelEntry } from '$lib/adminChannelNavigation';
	let { customChannels, onOpenChannel }: { customChannels: AdminChannelEntry[]; onOpenChannel: (id: string) => void } = $props();
</script>

<section class="channel-directory" aria-label="Server channels">
	<p class="channel-access-introduction">Open a channel in its workspace. Your dock stays open, and viewing a voice channel does not join its call.</p>
	<div class="channel-role-list">
		{#each customChannels as channel (channel.id)}
			<div class="channel-role-item">
				<div class="channel-role-meta">
					<span class="channel-name">{channel.name}</span>
					<span class="channel-type">{channel.typeLabel}</span>
				</div>
				<button class="channel-open-action" type="button" aria-label={`Open channel ${channel.name}`} onclick={() => onOpenChannel(channel.id)}>Open channel</button>
			</div>
		{:else}
			<p class="channel-access-help">No server channels are available in this session.</p>
		{/each}
	</div>
	<details class="channel-access-boundary"><summary>About channel access</summary><p class="channel-access-help">These server channels do not support minimum-role restrictions. Use direct or group messages for membership-restricted conversations. Category folders and private conversations are not listed here.</p></details>
</section>

<style>
	.channel-directory { display: grid; gap: 1rem; min-width: 0; }
	.channel-access-introduction, .channel-access-help { margin: 0; color: var(--text-secondary); font-size: 0.875rem; line-height: 1.6; text-wrap: pretty; overflow-wrap: anywhere; }
	.channel-directory .channel-role-list { display: grid; gap: 0.75rem; min-width: 0; }
	.channel-directory .channel-role-item { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem; min-width: 0; padding: 1rem; background: var(--surface-raised); border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); }
	.channel-directory .channel-role-meta { display: grid; gap: 0.4rem; min-width: 0; flex: 1 1 12rem; }
	.channel-directory .channel-name { color: var(--text-primary); font-size: 0.95rem; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
	.channel-directory .channel-type { color: var(--text-secondary); font-size: 0.8rem; line-height: 1.5; }
	.channel-open-action { min-width: 44px; min-height: 44px; padding: 0.6rem 0.85rem; border: 1px solid var(--border-default); border-radius: var(--radius-md); background: var(--surface-base); color: var(--text-primary); font: inherit; font-size: 0.875rem; cursor: pointer; }
	.channel-open-action:hover { background: var(--surface-hover); }
	.channel-access-boundary { border-top: 1px solid var(--border-subtle); padding-top: 0.5rem; }
	.channel-access-boundary summary { min-height: 44px; padding: 0.65rem 0; box-sizing: border-box; color: var(--text-secondary); font-size: 0.875rem; cursor: pointer; }
	.channel-directory :is(button, summary):focus-visible { outline: 2px solid var(--accent-secondary); outline-offset: 3px; }
</style>
