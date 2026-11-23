<script lang="ts">
	import { _ } from '$lib/i18n';
	import FloatingPanel from './FloatingPanel.svelte';
	import FloatingPanelGhost from './FloatingPanelGhost.svelte';
	import { ghostRect, ghostVisible, panels } from '$lib/windowing/floatingPanelStore';
	import type { FloatingPanelState } from '$lib/windowing/types';

	function describePanel(panel: FloatingPanelState): string {
		if (panel.kind === 'server-map') return $_('floating_panel.server_map');
		return $_('floating_panel.workspace');
	}
</script>

<div class="floating-panel-layer" aria-live="polite">
	{#each $panels as panel (panel.id)}
		<FloatingPanel {panel}>
			{#if panel.kind === 'channel-chat' && panel.payload.channelId}
				<!-- The same Chat as center stage and the dock, told which channel it shows. -->
				<div class="floating-panel-chat">
					{#await import('../Chat.svelte') then module}
						<svelte:component this={module.default} channelId={panel.payload.channelId} surface="companion" />
					{/await}
				</div>
			{:else}
			<div class="floating-panel-shell-content">
				<div class="floating-panel-shell-eyebrow">{$_('floating_panel.eyebrow')}</div>
				<h2>{panel.title}</h2>
				<p>{describePanel(panel)}</p>
				{#if panel.payload.channelId}
					<dl class="floating-panel-meta">
						<div><dt>{$_('server_policy.channel_id')}</dt><dd>{panel.payload.channelId}</dd></div>
						<div><dt>{$_('floating_panel.channel_name')}</dt><dd>{panel.payload.channelName || $_('payment_intent.unknown')}</dd></div>
					</dl>
				{/if}
			</div>
			{/if}
		</FloatingPanel>
	{/each}
	<FloatingPanelGhost rect={$ghostRect} visible={$ghostVisible} />
</div>

<style>
	.floating-panel-chat { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; }
</style>
