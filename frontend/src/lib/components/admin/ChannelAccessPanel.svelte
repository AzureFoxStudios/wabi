<script lang="ts">
	import { _ } from '$lib/i18n';

	let { customChannels }: { customChannels: Array<{ id: string; name: string; type: string }> } = $props();
</script>

<div class="admin-section">
	<h4>{$_('admin.sections.channel_access')}</h4>
	<p class="channel-access-notice">Minimum-role restrictions are not supported for ordinary channels in this server version.</p>
	<p class="channel-access-help">A role label does not make a channel private. Use direct or group messages for membership-restricted conversations.</p>
	<div class="channel-role-list">
		{#each customChannels as channel (channel.id)}
			<div class="channel-role-item">
				<div class="channel-role-meta">
					<span class="channel-name">#{channel.name}</span>
					<span class="channel-type">{channel.type}</span>
				</div>
			</div>
		{:else}
			<p class="channel-access-help">No ordinary text or voice channels to list.</p>
		{/each}
	</div>
</div>

<style>
	.channel-access-notice, .channel-access-help { margin: 0; font-size: 0.875rem; line-height: 1.6; text-wrap: pretty; overflow-wrap: anywhere; }
	.channel-access-notice { color: var(--text-heading); font-weight: 500; }
	.channel-access-help { color: var(--text-secondary); }
	.channel-role-meta { min-width: 0; flex-wrap: wrap; }
	.channel-name { overflow-wrap: anywhere; }
</style>
