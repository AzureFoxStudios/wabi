<script lang="ts">
	import { onDestroy } from 'svelte';
	import { layoutStore } from '$lib/layoutStore';
	import type { WorkspacePanelIcon as WorkspacePanelIconName } from '$lib/workspacePanels';
	import WorkspacePanelIcon from './WorkspacePanelIcon.svelte';

	export let parentHeight = 600;

	const QUICK_MIN_HEIGHT = 132;
	const QUICK_DEFAULT_HEIGHT = 200;
	const QUICK_MAX_RATIO = 0.56;
	const QUICK_COLLAPSED_BAR_HEIGHT = 44;
	const QUICK_COLLAPSE_THRESHOLD = 118;

	let quickPanelHeight = QUICK_DEFAULT_HEIGHT;
	let quickPanelCollapsed = false;
	let isResizingQuick = false;
	let quickResizeStartY = 0;
	let quickResizeStartHeight = QUICK_DEFAULT_HEIGHT;

	type QuickLink = { id: string; label: string; icon: WorkspacePanelIconName; hint: string };

	// QuickResources is a lightweight launcher: it LINKS OUT to the dedicated
	// workspace panels (Notes, Messages, People, …) instead of embedding a
	// second editor for notes/DMs. One place for each surface keeps the mental
	// model clean.
	const quickLinks: QuickLink[] = [
		{ id: 'notes', label: 'Notes', icon: 'notes', hint: 'Open your notes workspace' },
		{ id: 'dms', label: 'Messages', icon: 'messages', hint: 'Jump to direct messages' },
		{ id: 'users', label: 'People', icon: 'users', hint: 'See who is online' },
		{ id: 'media', label: 'Media', icon: 'media', hint: 'Browse the media library' },
		{ id: 'map', label: 'Map', icon: 'map', hint: 'Open the world map' },
		{ id: 'transfers', label: 'Transfers', icon: 'transfers', hint: 'Active file transfers' }
	];

	function launch(id: string): void {
		if (id === 'notes') {
			layoutStore.openNotes();
		} else {
			layoutStore.openRightPanel(id);
		}
	}

	onDestroy(() => {
		stopQuickResize();
	});

	function startQuickResize(event: MouseEvent): void {
		event.preventDefault();
		isResizingQuick = true;
		quickResizeStartY = event.clientY;
		quickResizeStartHeight = quickPanelHeight;
		window.addEventListener('mousemove', handleQuickResizeMove);
		window.addEventListener('mouseup', stopQuickResize);
	}

	function handleQuickResizeMove(event: MouseEvent): void {
		if (!isResizingQuick) return;
		const delta = quickResizeStartY - event.clientY;
		const maxHeight = Math.floor(parentHeight * QUICK_MAX_RATIO);
		const nextHeight = quickResizeStartHeight + delta;
		if (nextHeight <= QUICK_COLLAPSE_THRESHOLD) {
			quickPanelCollapsed = true;
			return;
		}
		quickPanelCollapsed = false;
		quickPanelHeight = Math.max(QUICK_MIN_HEIGHT, Math.min(maxHeight, nextHeight));
	}

	function stopQuickResize(): void {
		isResizingQuick = false;
		window.removeEventListener('mousemove', handleQuickResizeMove);
		window.removeEventListener('mouseup', stopQuickResize);
	}

	function collapseQuickPanel(): void {
		quickPanelCollapsed = true;
	}

	function expandQuickPanel(): void {
		quickPanelCollapsed = false;
		if (quickPanelHeight < QUICK_MIN_HEIGHT) quickPanelHeight = QUICK_DEFAULT_HEIGHT;
	}
</script>

<div
	class="quick-resources"
	class:is-collapsed={quickPanelCollapsed}
	style={`height: ${quickPanelCollapsed ? QUICK_COLLAPSED_BAR_HEIGHT : quickPanelHeight}px;`}
>
	{#if quickPanelCollapsed}
		<div class="quick-collapsed-bar">
			<span class="quick-kicker">Quick</span>
			<div class="quick-launch quick-launch-collapsed">
				{#each quickLinks as link}
					<button
						class="quick-link-icon-btn"
						type="button"
						title={link.hint}
						aria-label={link.label}
						on:click={() => launch(link.id)}
					>
						<WorkspacePanelIcon icon={link.icon} />
					</button>
				{/each}
			</div>
			<button class="quick-collapse-btn" type="button" title="Expand quick launcher" on:click={expandQuickPanel}>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<polyline points="18 15 12 9 6 15"></polyline>
				</svg>
			</button>
		</div>
	{:else}
		<button
			class="quick-resize-handle"
			type="button"
			on:mousedown={startQuickResize}
			title="Resize bottom panel"
			aria-label="Resize bottom panel"
		></button>

		<div class="quick-header">
			<div class="quick-header-main">
				<span class="quick-kicker">Quick launch</span>
				<span class="quick-sub">Jump to a workspace surface</span>
			</div>

			<button class="quick-collapse-btn" type="button" title="Collapse quick launcher" on:click={collapseQuickPanel}>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<polyline points="6 9 12 15 18 9"></polyline>
				</svg>
			</button>
		</div>

		<div class="quick-body">
			<div class="quick-launch">
				{#each quickLinks as link}
					<button class="quick-link" type="button" title={link.hint} on:click={() => launch(link.id)}>
						<span class="quick-link-icon"><WorkspacePanelIcon icon={link.icon} /></span>
						<span class="quick-link-label">{link.label}</span>
					</button>
				{/each}
			</div>
		</div>
	{/if}
</div>

<style>
	.quick-resources {
		display: flex;
		flex-direction: column;
		min-height: 0;
		border-top: 1px solid color-mix(in srgb, var(--border-subtle) 86%, transparent);
		background:
			radial-gradient(circle at bottom right, rgba(var(--accent-rgb), 0.12), transparent 38%),
			linear-gradient(180deg, color-mix(in srgb, var(--surface-base) 94%, transparent), color-mix(in srgb, var(--surface-raised) 82%, transparent));
		overflow: hidden;
	}

	:global(.mobile-workspace) .quick-resources {
		display: none;
	}

	.quick-resize-handle {
		height: 8px;
		border: none;
		background: transparent;
		cursor: ns-resize;
		padding: 0;
		flex-shrink: 0;
	}

	.quick-header,
	.quick-collapsed-bar {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0.5rem 0.65rem;
	}

	.quick-header {
		justify-content: space-between;
	}

	.quick-collapsed-bar {
		justify-content: space-between;
		height: 100%;
	}

	.quick-header-main {
		display: flex;
		align-items: baseline;
		gap: 0.55rem;
		min-width: 0;
		flex: 1;
	}

	.quick-kicker {
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--accent-primary-color, var(--text-secondary));
		white-space: nowrap;
	}

	.quick-sub {
		font-size: 0.72rem;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.quick-collapse-btn {
		width: 30px;
		height: 30px;
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 999px;
		border: none;
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
		transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
	}

	.quick-collapse-btn:hover {
		border-color: rgba(var(--accent-rgb), 0.32);
		background: rgba(var(--accent-rgb), 0.12);
		color: var(--text-heading);
	}

	.quick-collapse-btn svg {
		width: 16px;
		height: 16px;
	}

	.quick-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		border-top: 1px solid color-mix(in srgb, var(--border-subtle) 76%, transparent);
	}

	.quick-launch {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
		padding: 0.6rem 0.65rem;
	}

	.quick-launch-collapsed {
		flex: 1;
		min-width: 0;
		justify-content: flex-start;
		padding: 0;
	}

	.quick-link {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.5rem 0.7rem;
		border-radius: 10px;
		border: 1px solid color-mix(in srgb, var(--border-subtle) 80%, transparent);
		background: color-mix(in srgb, var(--surface-raised) 88%, transparent);
		color: var(--text-heading);
		font-size: 0.78rem;
		font-weight: 650;
		cursor: pointer;
		transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
	}

	.quick-link:hover {
		transform: translateY(-1px);
		border-color: rgba(var(--accent-rgb), 0.45);
		background: rgba(var(--accent-rgb), 0.1);
	}

	.quick-link:active {
		transform: none;
	}

	.quick-link-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--accent-primary-color);
	}

	.quick-link-icon :global(svg) {
		width: 18px;
		height: 18px;
	}

	.quick-link-icon-btn {
		width: 34px;
		height: 34px;
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 9px;
		border: 1px solid color-mix(in srgb, var(--border-subtle) 78%, transparent);
		background: color-mix(in srgb, var(--surface-raised) 88%, transparent);
		color: var(--accent-primary-color);
		cursor: pointer;
		transition: border-color 120ms ease, background 120ms ease;
	}

	.quick-link-icon-btn:hover {
		border-color: rgba(var(--accent-rgb), 0.45);
		background: rgba(var(--accent-rgb), 0.12);
	}

	.quick-link-icon-btn :global(svg) {
		width: 18px;
		height: 18px;
	}

	@media (prefers-reduced-motion: reduce) {
		.quick-link,
		.quick-link-icon-btn,
		.quick-collapse-btn {
			transition: none;
		}

		.quick-link:hover,
		.quick-collapse-btn:hover {
			transform: none;
		}
	}
</style>
