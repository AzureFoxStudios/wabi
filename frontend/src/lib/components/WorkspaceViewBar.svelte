<script lang="ts">
	import { tick } from 'svelte';
	import type { WorkspaceViewKey } from './chat/types';

	let { activeView, onSelectView, canOpenWhiteboard = true }: {
		activeView: WorkspaceViewKey;
		onSelectView: (view: WorkspaceViewKey) => void;
		canOpenWhiteboard?: boolean;
	} = $props();
	const views: { id: WorkspaceViewKey; label: string; detail: string }[] = [
		{ id: 'messages', label: 'Messages', detail: 'Your current channel' },
		{ id: 'voice', label: 'Calls', detail: 'Voice, video & sharing' },
		{ id: 'whiteboard', label: 'Whiteboard', detail: 'A canvas for your channel' },
		{ id: 'planner', label: 'Planner', detail: 'Tasks, projects & calendar' },
		{ id: 'notes', label: 'Notes', detail: 'Your personal notes' },
		{ id: 'lore', label: 'Project', detail: 'Repositories · Lore addon' },
		{ id: 'files', label: 'Files', detail: 'Browse files & transfers' },
		{ id: 'media', label: 'Media', detail: 'Photos & albums' },
		{ id: 'reader', label: 'Reader', detail: 'Documents & reading' },
		{ id: 'model', label: '3D viewer', detail: 'Explore models' },
		{ id: 'map', label: 'Map', detail: 'Places & directions' }
	];
	const pickerId = $props.id();
	let open = $state(false);
	let root: HTMLElement | undefined = $state();
	let trigger: HTMLButtonElement | undefined = $state();
	let panel: HTMLDivElement | undefined = $state();
	const selected = $derived(views.find(view => view.id === activeView)!);

	function close(restoreFocus = false): void {
		open = false;
		if (restoreFocus) trigger?.focus({ preventScroll: true });
	}
	async function toggle(): Promise<void> {
		if (open) { close(true); return; }
		open = true;
		await tick();
		(panel?.querySelector<HTMLButtonElement>('[aria-current="page"]') ??
			panel?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
	}
	function select(view: WorkspaceViewKey): void {
		onSelectView(view);
		close(true);
	}
	function onKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape' && open) {
			event.preventDefault();
			event.stopPropagation();
			close(true);
		} else if (event.target === trigger && event.key === 'ArrowDown') {
			event.preventDefault();
			if (!open) void toggle();
		}
	}
	$effect(() => {
		if (!open) return;
		const onOutsidePress = (event: PointerEvent) => {
			if (!root?.contains(event.target as Node)) close();
		};
		document.addEventListener('pointerdown', onOutsidePress);
		return () => document.removeEventListener('pointerdown', onOutsidePress);
	});
</script>

{#snippet workspaceIcon(view: WorkspaceViewKey)}
	{#if view === 'voice'}
		<svg aria-hidden="true" width="20" height="20" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<path d="M3 18v-6a9 9 0 0 1 18 0v6"></path>
			<path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"></path>
		</svg>
	{:else if view === 'messages'}
		<svg aria-hidden="true" width="20" height="20" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
		</svg>
	{:else if view === 'whiteboard'}
		<svg aria-hidden="true" width="20" height="20" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<rect x="3" y="4" width="18" height="14" rx="2"></rect>
			<path d="M7 8h10"></path>
			<path d="M7 12h6"></path>
			<path d="M8 20h8"></path>
		</svg>
	{:else if view === 'planner'}
		<svg aria-hidden="true" width="20" height="20" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<rect x="3" y="3" width="18" height="18" rx="2"></rect>
			<path d="M3 9h18"></path>
			<path d="M9 21V9"></path>
		</svg>
	{:else if view === 'notes'}
		<svg aria-hidden="true" width="20" height="20" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
			<polyline points="14 2 14 8 20 8"></polyline>
			<line x1="16" y1="13" x2="8" y2="13"></line>
			<line x1="16" y1="17" x2="8" y2="17"></line>
		</svg>
	{:else if view === 'lore'}
		<svg aria-hidden="true" width="20" height="20" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<polyline points="16 18 22 12 16 6"></polyline>
			<polyline points="8 6 2 12 8 18"></polyline>
		</svg>
	{:else if view === 'files'}
		<svg aria-hidden="true" width="20" height="20" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
		</svg>
	{:else if view === 'media'}
		<svg aria-hidden="true" width="20" height="20" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<rect x="3" y="3" width="18" height="18" rx="2"></rect>
			<circle cx="8.5" cy="8.5" r="1.5"></circle>
			<polyline points="21 15 16 10 5 21"></polyline>
		</svg>
	{:else if view === 'reader'}
		<svg aria-hidden="true" width="20" height="20" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
			<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
		</svg>
	{:else if view === 'model'}
		<svg aria-hidden="true" width="20" height="20" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
			<path d="M3.27 6.96 12 12.01l8.73-5.05"></path>
			<path d="M12 22.08V12"></path>
		</svg>
	{:else if view === 'map'}
		<svg aria-hidden="true" width="20" height="20" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"></path>
			<path d="M9 4v14"></path>
			<path d="M15 6v14"></path>
		</svg>
	{/if}
{/snippet}

<svelte:window onblur={() => close()} onkeydown={onKeydown} />

<nav class="workspace-view-bar" aria-label="Workspace" bind:this={root}
	onfocusout={(event) => { if (!root?.contains(event.relatedTarget as Node)) close(); }}>
	<button class="workspace-trigger" type="button" bind:this={trigger}
		aria-expanded={open} aria-controls={pickerId} aria-haspopup="dialog"
		aria-label={`Switch workspace: ${selected.label}`} onclick={toggle}>
		{@render workspaceIcon(activeView)}
		<span class="workspace-trigger-copy"><span class="workspace-eyebrow">Workspace</span><span class="workspace-current">{selected.label}</span></span>
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
	</button>
	<button class="workspace-return" class:unavailable={activeView === 'messages'} disabled={activeView === 'messages'} type="button" aria-label="Return to messages" onclick={() => select('messages')}>
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m12 5-7 7 7 7M5 12h14" /></svg>
		<span>Messages</span>
	</button>
	{#if open}
		<div class="workspace-picker" id={pickerId} role="dialog" aria-label="Choose workspace" bind:this={panel}>
			<p class="workspace-picker-heading">Choose a workspace</p>
			<div class="workspace-options">
				{#each views as view (view.id)}
					<button type="button" class="workspace-option" aria-label={view.label} aria-describedby={`${pickerId}-${view.id}-detail`} aria-current={activeView === view.id ? 'page' : undefined}
						disabled={view.id === 'whiteboard' && !canOpenWhiteboard} onclick={() => select(view.id)}>
						{@render workspaceIcon(view.id)}
						<span><span class="workspace-option-label">{view.label}</span><span class="workspace-option-detail" id={`${pickerId}-${view.id}-detail`}>{view.detail}</span></span>
					</button>
				{/each}
			</div>
		</div>
	{/if}
</nav>

<style>
	.workspace-view-bar {
		position: relative;
		z-index: var(--z-dropdown);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		flex: 0 0 auto;
		min-width: 0;
		padding: var(--space-1) var(--space-3);
		border-bottom: 1px solid var(--border-subtle);
		background: var(--surface-app);
	}
	button {
		font: inherit;
		color: var(--text-secondary);
		border: 1px solid transparent;
		background: transparent;
		border-radius: var(--radius-md);
		cursor: pointer;
		text-align: start;
		transition: background-color var(--duration-fast) ease, border-color var(--duration-fast) ease;
	}
	button:focus-visible { outline: 2px solid var(--accent-primary-color); outline-offset: 2px; }
	@media (hover: hover) { button:hover:not(:disabled) { background: var(--surface-raised); color: var(--text-heading); } }
	button:active:not(:disabled) { background: var(--surface-raised); }
	button:disabled { opacity: 0.5; cursor: not-allowed; }
	.workspace-trigger, .workspace-return {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 44px;
		padding: var(--space-1) var(--space-2);
		min-width: 0;
	}
	.workspace-trigger { flex: 0 1 13rem; color: var(--text-heading); }
	.workspace-trigger[aria-expanded="true"] { background: var(--surface-raised); border-color: var(--border-subtle); }
	.workspace-trigger-copy { display: flex; flex-direction: column; min-width: 0; flex: 1; }
	.workspace-eyebrow { font-size: var(--text-xs); line-height: 1.3; color: var(--text-secondary); }
	.workspace-current { font-size: var(--text-base); font-weight: var(--font-weight-semibold); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.workspace-return { font-size: var(--text-sm); flex-shrink: 0; }
	/* Reserve the return slot so the picker/chevron never resize on selection. */
	.workspace-return.unavailable { visibility: hidden; }
	.workspace-view-bar :global(svg) { flex-shrink: 0; }
	.workspace-picker {
		position: absolute;
		top: calc(100% + var(--space-1));
		inset-inline-start: var(--space-2);
		width: min(28rem, calc(100% - var(--space-4)));
		box-sizing: border-box;
		max-height: calc(100dvh - 140px);
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: var(--space-2);
		border-radius: var(--radius-lg);
		border: 1px solid var(--border-subtle);
		background: var(--surface-popover);
		box-shadow: var(--shadow-lg);
	}
	.workspace-picker-heading { margin: var(--space-2); color: var(--text-secondary); font-size: var(--text-sm); }
	.workspace-options { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr)); gap: var(--space-1); }
	.workspace-option { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-2); min-height: 56px; }
	.workspace-option > span { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }
	.workspace-option-label { font-size: var(--text-base); font-weight: var(--font-weight-medium); color: var(--text-heading); }
	.workspace-option-detail { font-size: var(--text-xs); line-height: 1.4; color: var(--text-secondary); }
	.workspace-option[aria-current="page"] { border-color: var(--accent-primary-color); background: var(--surface-raised); }
	@media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style>
