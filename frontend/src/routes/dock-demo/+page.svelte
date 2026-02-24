<script lang="ts">
	import { layoutStore } from '$lib/layoutStore';
	import DockContainer from '$lib/components/docking/DockContainer.svelte';

	let dragging: 'nav' | 'right' | null = null;
	let workspaceDraft = 'custom';
	let layoutJsonBuffer = '';
	let lastWorkspaceSeen = '';

	function startDrag(type: 'nav' | 'right') {
		dragging = type;
		if (type === 'nav') {
			layoutStore.isResizingChannel.set(true);
		} else {
			layoutStore.isResizingRight.set(true);
		}
	}

	function onMouseMove(event: MouseEvent) {
		if (!dragging) return;
		if (dragging === 'nav') {
			const width = $layoutStore.navDock === 'right'
				? window.innerWidth - event.clientX
				: event.clientX;
			layoutStore.channelSidebarWidth.set(Math.max(0, Math.min(width, 400)));
		}

		if (dragging === 'right') {
			const navOffset = $layoutStore.navDock === 'right' ? $layoutStore.channelSidebarWidth : 0;
			const edge = window.innerWidth - navOffset;
			const width = Math.max(0, Math.min(edge - event.clientX, 520));
			layoutStore.rightPanelWidth.set(width);
		}
	}

	function stopDrag() {
		if (!dragging) return;
		layoutStore.isResizingChannel.set(false);
		layoutStore.isResizingRight.set(false);
		dragging = null;
	}

	function saveWorkspace() {
		const name = workspaceDraft.trim();
		if (!name) return;
		layoutStore.saveWorkspace(name);
	}

	function renameWorkspace() {
		const name = workspaceDraft.trim();
		if (!name) return;
		layoutStore.renameWorkspace($layoutStore.activeWorkspace, name);
	}

	function exportLayout() {
		layoutJsonBuffer = layoutStore.exportLayoutJson();
	}

	function importLayout() {
		const ok = layoutStore.importLayoutJson(layoutJsonBuffer);
		if (!ok) {
			alert('Invalid layout JSON');
		}
	}

	function toggleRightPanel() {
		if ($layoutStore.rightPanelView === 'none') {
			layoutStore.showUsersTab();
			return;
		}
		layoutStore.toggleRightPanel();
	}

	$: if ($layoutStore.activeWorkspace !== lastWorkspaceSeen) {
		lastWorkspaceSeen = $layoutStore.activeWorkspace;
		workspaceDraft = $layoutStore.activeWorkspace;
	}
</script>

<svelte:window on:mousemove={onMouseMove} on:mouseup={stopDrag} />

<div class="dock-demo">
	<header class="toolbar">
		<div class="group">
			<label>Workspace</label>
			<select value={$layoutStore.activeWorkspace} on:change={(e) => layoutStore.loadWorkspace(e.currentTarget.value)}>
				{#each $layoutStore.workspaces as name}
					<option value={name}>{name}</option>
				{/each}
			</select>
			<input bind:value={workspaceDraft} placeholder="workspace name" />
			<button on:click={saveWorkspace}>Save As</button>
			<button on:click={renameWorkspace}>Rename</button>
			<button on:click={() => layoutStore.resetWorkspace($layoutStore.activeWorkspace)}>Reset</button>
		</div>

		<div class="group">
			<label>Dock Side</label>
			<button class:active={$layoutStore.navDock === 'left'} on:click={() => layoutStore.setNavDock('left')}>Left</button>
			<button class:active={$layoutStore.navDock === 'right'} on:click={() => layoutStore.setNavDock('right')}>Right</button>
			<button on:click={layoutStore.toggleNavCollapsed}>
				{$layoutStore.isNavCollapsed ? 'Expand Nav' : 'Collapse Nav'}
			</button>
			<button on:click={toggleRightPanel}>
				{$layoutStore.rightPanelView === 'none' ? 'Open Side Panel' : 'Close Side Panel'}
			</button>
		</div>

		<div class="group">
			<button on:click={exportLayout}>Export JSON</button>
			<button on:click={importLayout}>Import JSON</button>
		</div>
	</header>

	<div class="workspace">
		<DockContainer
			navDock={$layoutStore.navDock}
			navWidth={$layoutStore.channelSidebarWidth}
			rightWidth={$layoutStore.rightPanelWidth}
			showNav={true}
			showRight={$layoutStore.rightPanelView !== 'none'}
			isResizing={$layoutStore.isResizing}
			on:resizenavstart={() => startDrag('nav')}
			on:resizerightstart={() => startDrag('right')}
		>
			<div slot="nav" class="panel nav">
				<div class="module gate">Gate Switcher</div>
				<div class="module">Nav Panel</div>
			</div>

			<main slot="center" class="panel content">
				<h2>Content Panel</h2>
				<p>Primary view should never be hidden.</p>
				<div class="hint">Try docking nav left/right, collapse, resize, and save/load workspaces.</div>
			</main>

			<div slot="right" class="panel right">
				{#if $layoutStore.rightPanelView !== 'none'}
					<div class="module">Right Panel ({$layoutStore.activeRightTab})</div>
				{/if}
			</div>
		</DockContainer>
	</div>

	<textarea bind:value={layoutJsonBuffer} spellcheck="false"></textarea>
</div>

<style>
	:global(body) {
		margin: 0;
	}

	.dock-demo {
		min-height: 100vh;
		background: radial-gradient(circle at 20% 20%, #1f2937 0, #0f172a 45%, #020617 100%);
		color: #e5e7eb;
		padding: 0.9rem;
		display: grid;
		gap: 0.75rem;
		grid-template-rows: auto 1fr 180px;
		font-family: 'IBM Plex Sans', 'Segoe UI', sans-serif;
	}

	.toolbar {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		padding: 0.7rem;
		border: 1px solid rgba(148, 163, 184, 0.2);
		border-radius: 12px;
		background: rgba(15, 23, 42, 0.72);
		backdrop-filter: blur(5px);
	}

	.group {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		flex-wrap: wrap;
	}

	label {
		font-size: 0.82rem;
		color: #93c5fd;
	}

	button,
	select,
	input,
	textarea {
		background: rgba(15, 23, 42, 0.9);
		color: #f8fafc;
		border: 1px solid rgba(148, 163, 184, 0.28);
		border-radius: 8px;
		padding: 0.45rem 0.6rem;
	}

	button {
		cursor: pointer;
	}

	button.active {
		border-color: #22d3ee;
		background: rgba(6, 182, 212, 0.2);
	}

	.workspace {
		display: flex;
		min-height: 0;
		border: 1px solid rgba(148, 163, 184, 0.2);
		border-radius: 12px;
		overflow: hidden;
		background: rgba(2, 6, 23, 0.65);
		position: relative;
	}

	.workspace :global(.dock-container) {
		height: 100%;
	}

	.panel {
		min-height: 0;
	}

	.nav {
		background: rgba(15, 23, 42, 0.94);
		border-right: 1px solid rgba(148, 163, 184, 0.2);
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.7rem;
	}

	.module {
		background: rgba(30, 41, 59, 0.88);
		border: 1px solid rgba(148, 163, 184, 0.26);
		padding: 0.75rem;
		border-radius: 8px;
	}

	.module.gate {
		background: rgba(14, 116, 144, 0.3);
	}

	.content {
		flex: 1;
		min-width: 0;
		padding: 1rem;
	}

	.content h2 {
		margin: 0 0 0.3rem;
	}

	.hint {
		font-size: 0.86rem;
		opacity: 0.82;
	}

	.right {
		background: rgba(30, 41, 59, 0.88);
		border-left: 1px solid rgba(148, 163, 184, 0.2);
		padding: 0.7rem;
	}

	textarea {
		width: 100%;
		resize: vertical;
		font-family: 'IBM Plex Mono', 'Fira Code', monospace;
	}

	@media (max-width: 900px) {
		.dock-demo {
			grid-template-rows: auto minmax(320px, 1fr) 160px;
		}
	}
</style>
