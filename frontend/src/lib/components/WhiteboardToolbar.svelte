<script lang="ts">
	import {
		boardStore,
		activeTool,
		currentStyle,
		canUndo,
		canRedo
	} from '$lib/whiteboard/boardStore';
	import type { ToolType } from '$lib/whiteboard/boardStore';

	const tools: Array<{ id: ToolType; label: string; shortcut: string; icon: string }> = [
		{ id: 'select', label: 'Select', shortcut: 'V', icon: 'cursor' },
		{ id: 'pen', label: 'Pen', shortcut: 'P', icon: 'pen' },
		{ id: 'line', label: 'Line', shortcut: 'L', icon: 'line' },
		{ id: 'rect', label: 'Rect', shortcut: 'R', icon: 'rect' },
		{ id: 'ellipse', label: 'Ellipse', shortcut: 'E', icon: 'ellipse' },
		{ id: 'arrow', label: 'Arrow', shortcut: 'A', icon: 'arrow' },
		{ id: 'text', label: 'Text', shortcut: 'T', icon: 'text' },
		{ id: 'pan', label: 'Pan', shortcut: 'Space', icon: 'pan' }
	];

	const colorSwatches = [
		'#1f2937', '#b91c1c', '#c2410c', '#a16207',
		'#166534', '#0369a1', '#6d28d9', '#be185d'
	];

	const strokeWidths = [1, 2, 4, 8];

	export let onExportPng: (() => void) | null = null;
	export let onExportJson: (() => void) | null = null;
	export let onImportImages: (() => void) | null = null;
	export let exportBusy = false;
	export let importDisabled = false;

	function setTool(id: ToolType) {
		boardStore.setTool(id);
	}

	function setColor(color: string) {
		boardStore.setStyle({ strokeColor: color });
	}

	function setWidth(w: number) {
		boardStore.setStyle({ strokeWidth: w });
	}
</script>

<div class="wb-toolbar">
	<div class="wb-toolbar-section tools">
		{#each tools as tool}
			<button
				class="wb-tool-btn"
				class:active={$activeTool === tool.id}
				on:click={() => setTool(tool.id)}
				title="{tool.label} ({tool.shortcut})"
			>
				<span class="wb-tool-icon">
					{#if tool.icon === 'cursor'}
						<svg viewBox="0 0 20 20" fill="currentColor"><path d="M4 2l12 8-5 1.5L9.5 17z"/></svg>
					{:else if tool.icon === 'pen'}
						<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 17l1.5-5L15 2l2 2L7.5 14.5z"/><path d="M12 5l2 2"/></svg>
					{:else if tool.icon === 'line'}
						<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="3" y1="17" x2="17" y2="3"/></svg>
					{:else if tool.icon === 'rect'}
						<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="14" height="12" rx="1"/></svg>
					{:else if tool.icon === 'ellipse'}
						<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><ellipse cx="10" cy="10" rx="7" ry="5"/></svg>
					{:else if tool.icon === 'arrow'}
						<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="3" y1="17" x2="17" y2="3"/><polyline points="10,3 17,3 17,10"/></svg>
					{:else if tool.icon === 'text'}
						<svg viewBox="0 0 20 20" fill="currentColor"><text x="4" y="16" font-size="15" font-weight="bold" font-family="sans-serif">T</text></svg>
					{:else if tool.icon === 'pan'}
						<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 2v16M2 10h16M10 2l-2 3m2-3l2 3M10 18l-2-3m2 3l2-3M2 10l3-2m-3 2l3 2M18 10l-3-2m3 2l-3 2"/></svg>
					{/if}
				</span>
				<span class="wb-tool-shortcut">{tool.shortcut}</span>
			</button>
		{/each}
	</div>

	<div class="wb-toolbar-divider"></div>

	<div class="wb-toolbar-section actions">
		<button
			class="wb-tool-btn"
			on:click={() => boardStore.undo()}
			disabled={!$canUndo}
			title="Undo (Ctrl+Z)"
		>
			<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 8l-3 3 3 3"/><path d="M2 11h11a4 4 0 000-8H8"/></svg>
		</button>
		<button
			class="wb-tool-btn"
			on:click={() => boardStore.redo()}
			disabled={!$canRedo}
			title="Redo (Ctrl+Shift+Z)"
		>
			<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M15 8l3 3-3 3"/><path d="M18 11H7a4 4 0 010-8h5"/></svg>
		</button>
		<button
			class="wb-tool-btn"
			on:click={() => onImportImages?.()}
			disabled={importDisabled || !onImportImages}
			title="Import images"
		>
			<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
				<path d="M4 5.5A1.5 1.5 0 015.5 4h9A1.5 1.5 0 0116 5.5v9a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 014 14.5z"/>
				<path d="M7 12l2-2 2 2 2.5-3 1.5 2"/>
				<circle cx="8" cy="7.5" r="1"/>
			</svg>
		</button>
	</div>

	<div class="wb-toolbar-divider"></div>

	<div class="wb-toolbar-section exports">
		<button
			class="wb-tool-btn wb-export-btn"
			on:click={() => onExportPng?.()}
			disabled={exportBusy || !onExportPng}
			title="Export PNG"
		>
			<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 3v9"/><path d="M6.5 8.5L10 12l3.5-3.5"/><path d="M4 14.5h12"/></svg>
		</button>
		<button
			class="wb-tool-btn wb-export-btn"
			on:click={() => onExportJson?.()}
			disabled={exportBusy || !onExportJson}
			title="Export JSON"
		>
			<span class="wb-export-label">JSON</span>
		</button>
	</div>

	<div class="wb-toolbar-divider"></div>

	<div class="wb-toolbar-section colors">
		{#each colorSwatches as color}
			<button
				class="wb-color-swatch"
				class:active={$currentStyle.strokeColor === color}
				style="--swatch-color: {color}"
				on:click={() => setColor(color)}
				title={color}
			></button>
		{/each}
	</div>

	<div class="wb-toolbar-divider"></div>

	<div class="wb-toolbar-section widths">
		{#each strokeWidths as w}
			<button
				class="wb-width-btn"
				class:active={$currentStyle.strokeWidth === w}
				on:click={() => setWidth(w)}
				title="{w}px"
			>
				<span class="wb-width-preview" style="height: {Math.max(2, w)}px"></span>
			</button>
		{/each}
	</div>
</div>

<style>
	.wb-toolbar {
		position: absolute;
		top: 12px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 20;
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 6px 9px;
		border-radius: 14px;
		background: rgba(255, 251, 243, 0.96);
		backdrop-filter: blur(12px);
		border: 1px solid rgba(148, 163, 184, 0.26);
		box-shadow: 0 14px 32px rgba(15, 23, 42, 0.14);
		user-select: none;
	}

	.wb-toolbar-section {
		display: flex;
		align-items: center;
		gap: 2px;
	}

	.wb-toolbar-divider {
		width: 1px;
		height: 24px;
		margin: 0 4px;
		background: rgba(148, 163, 184, 0.28);
	}

	.wb-tool-btn {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		padding: 0;
		border: none;
		border-radius: 8px;
		background: transparent;
		color: rgba(30, 41, 59, 0.78);
		cursor: pointer;
		transition: background 0.12s, color 0.12s;
	}

	.wb-tool-btn:hover {
		background: rgba(148, 163, 184, 0.14);
		color: #0f172a;
	}

	.wb-tool-btn.active {
		background: rgba(59, 130, 246, 0.16);
		color: #1d4ed8;
	}

	.wb-tool-btn:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.wb-tool-btn svg {
		width: 16px;
		height: 16px;
	}

	.wb-tool-icon {
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.wb-tool-icon svg {
		width: 16px;
		height: 16px;
	}

	.wb-tool-shortcut {
		position: absolute;
		bottom: 1px;
		right: 2px;
		font-size: 7px;
		opacity: 0.45;
		font-family: monospace;
		pointer-events: none;
	}

	.wb-export-label {
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.04em;
	}

	.wb-color-swatch {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		border: 2px solid transparent;
		background: var(--swatch-color);
		cursor: pointer;
		padding: 0;
		transition: border-color 0.12s, transform 0.12s;
	}

	.wb-color-swatch:hover {
		transform: scale(1.15);
	}

	.wb-color-swatch.active {
		border-color: #fffef9;
		box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.48);
	}

	.wb-width-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		padding: 0;
		border: none;
		border-radius: 6px;
		background: transparent;
		cursor: pointer;
		transition: background 0.12s;
	}

	.wb-width-btn:hover {
		background: rgba(148, 163, 184, 0.14);
	}

	.wb-width-btn.active {
		background: rgba(59, 130, 246, 0.16);
	}

	.wb-width-preview {
		display: block;
		width: 16px;
		border-radius: 2px;
		background: rgba(30, 41, 59, 0.72);
	}
</style>
