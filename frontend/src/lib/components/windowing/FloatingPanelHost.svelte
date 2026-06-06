<script lang="ts">
	import FloatingPanel from './FloatingPanel.svelte';
	import FloatingPanelGhost from './FloatingPanelGhost.svelte';
	import { ghostRect, ghostVisible, panels } from '$lib/windowing/floatingPanelStore';
	import type { FloatingPanelState } from '$lib/windowing/types';

	function describePanel(panel: FloatingPanelState): string {
		if (panel.kind === 'channel-chat') {
			const name = panel.payload.channelName || panel.payload.channelId || 'channel';
			return `This is Wabi's in-webview sub-window shell for #${name}. Full channel chat embedding is the next windowing task; this shell proves open, drag, resize, snap, restore, and close behavior without faking message state.`;
		}
		if (panel.kind === 'server-map') return 'Server map floating panel shell.';
		return 'Workspace floating panel shell.';
	}
</script>

<div class="floating-panel-layer" aria-live="polite">
	{#each $panels as panel (panel.id)}
		<FloatingPanel {panel}>
			<div class="floating-panel-shell-content">
				<div class="floating-panel-shell-eyebrow">In-app sub-window</div>
				<h2>{panel.title}</h2>
				<p>{describePanel(panel)}</p>
				{#if panel.payload.channelId}
					<dl class="floating-panel-meta">
						<div><dt>Channel ID</dt><dd>{panel.payload.channelId}</dd></div>
						<div><dt>Channel name</dt><dd>{panel.payload.channelName || 'unknown'}</dd></div>
					</dl>
				{/if}
			</div>
		</FloatingPanel>
	{/each}
	<FloatingPanelGhost rect={$ghostRect} visible={$ghostVisible} />
</div>
