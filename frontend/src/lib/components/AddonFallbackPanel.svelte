<script lang="ts">
	import type { WorkspacePanelManifest } from '$lib/workspacePanels';

	export let panel: WorkspacePanelManifest;
</script>

<div class="addon-fallback-panel">
	<div class="fallback-icon" aria-hidden="true">
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
			<path d="M3.3 7 12 12l8.7-5"></path>
			<path d="M12 22V12"></path>
		</svg>
	</div>
	<h3>{panel.fallbackBehavior?.title || panel.label}</h3>
	<p>{panel.fallbackBehavior?.message || 'This add-on panel is registered, but its UI component is not available.'}</p>
	{#if panel.pluginId || panel.settingsRoute}
		<div class="fallback-meta">
			{#if panel.pluginId}<span>Plugin: {panel.pluginId}</span>{/if}
			{#if panel.settingsRoute}<span>Settings: {panel.settingsRoute}</span>{/if}
		</div>
	{/if}
</div>

<style>
	.addon-fallback-panel {
		width: 100%;
		height: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.65rem;
		padding: 1rem;
		text-align: center;
		color: var(--text-secondary);
		background: color-mix(in srgb, var(--surface-app) 88%, transparent);
	}

	.fallback-icon {
		width: 44px;
		height: 44px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 12px;
		border: 1px solid color-mix(in srgb, var(--border-subtle) 82%, transparent);
		color: var(--accent-primary);
		background: rgba(var(--accent-rgb), 0.1);
	}

	.fallback-icon svg {
		width: 24px;
		height: 24px;
	}

	h3 {
		margin: 0;
		color: var(--text-heading);
		font-size: 0.94rem;
	}

	p {
		max-width: 26rem;
		margin: 0;
		font-size: 0.82rem;
		line-height: 1.45;
	}

	.fallback-meta {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.4rem;
		font-size: 0.72rem;
		color: var(--text-muted);
	}

	.fallback-meta span {
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--border-subtle) 78%, transparent);
		padding: 0.2rem 0.5rem;
		background: color-mix(in srgb, var(--surface-base) 82%, transparent);
	}
</style>
