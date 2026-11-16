<script lang="ts">
	import { _ } from '$lib/i18n';
	import FloatingPanel from './FloatingPanel.svelte';
	import FloatingPanelGhost from './FloatingPanelGhost.svelte';
	import { brandName } from '$lib/branding';
	import { ghostRect, ghostVisible, panels } from '$lib/windowing/floatingPanelStore';
	import type { FloatingPanelState } from '$lib/windowing/types';

	function describePanel(panel: FloatingPanelState): string {
		if (panel.kind === 'channel-chat') {
			const name = panel.payload.channelName || panel.payload.channelId || $_('chan_sidebar.word_channel_one');
			return $_('floating_panel.channel_shell', { values: { brand: brandName, name } });
		}
		if (panel.kind === 'server-map') return $_('floating_panel.server_map');
		return $_('floating_panel.workspace');
	}
</script>

<div class="floating-panel-layer" aria-live="polite">
	{#each $panels as panel (panel.id)}
		<FloatingPanel {panel}>
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
		</FloatingPanel>
	{/each}
	<FloatingPanelGhost rect={$ghostRect} visible={$ghostVisible} />
</div>
