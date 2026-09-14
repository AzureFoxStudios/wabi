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
						<span class="channel-type" data-kind={channel.type}>{channel.typeLabel}</span>
					</div>
					<button class="ui-btn ui-btn-secondary" type="button" aria-label={`Open channel ${channel.name}`} onclick={() => onOpenChannel(channel.id)}>Open channel</button>
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
		.channel-directory .channel-type {
			justify-self: start;
			display: inline-flex;
			align-items: center;
			gap: 0.4rem;
			padding: 0.2rem 0.6rem;
			border: 1px solid color-mix(in srgb, var(--chip-color, var(--text-muted)) 35%, transparent);
			border-radius: var(--radius-full);
			background: color-mix(in srgb, var(--chip-color, var(--text-muted)) 12%, transparent);
			color: color-mix(in srgb, var(--chip-color, var(--text-muted)) 80%, var(--text-heading));
			font-size: 0.7rem;
			font-weight: 600;
			letter-spacing: 0.05em;
			line-height: 1.4;
		}
		.channel-directory .channel-type::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--chip-color, var(--text-muted)); }
		.channel-directory .channel-type[data-kind='text'] { --chip-color: var(--accent-primary-color); }
		.channel-directory .channel-type[data-kind='voice'] { --chip-color: var(--color-info); }
		.channel-directory .channel-type[data-kind='project'],
		.channel-directory .channel-type[data-kind='planning'] { --chip-color: var(--color-success); }
		.channel-directory .channel-type[data-kind='forum'] { --chip-color: var(--color-warning); }
		.channel-directory .channel-type[data-kind='wiki'],
		.channel-directory .channel-type[data-kind='reader'] { --chip-color: var(--accent-secondary-color); }
		.channel-directory .channel-type[data-kind='gallery'],
		.channel-directory .channel-type[data-kind='media'] { --chip-color: var(--accent-purple, #9b59b6); }
	.channel-access-boundary { border-top: 1px solid var(--border-subtle); padding-top: 0.5rem; }
	.channel-access-boundary summary { min-height: 44px; padding: 0.65rem 0; box-sizing: border-box; color: var(--text-secondary); font-size: 0.875rem; cursor: pointer; }
	.channel-directory :is(button, summary):focus-visible { outline: 2px solid var(--accent-secondary); outline-offset: 3px; }
</style>
