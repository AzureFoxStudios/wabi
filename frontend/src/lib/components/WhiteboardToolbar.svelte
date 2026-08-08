<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import { renderToString } from 'katex';
	import {
		boardStore,
		activeTool,
		currentStyle,
		canUndo,
		canRedo,
		policy
	} from '$lib/whiteboard/boardStore';
	import type { ToolType } from '$lib/whiteboard/boardStore';
	import { onMathPlacement, buildMathElement, type MathPlacement } from '$lib/whiteboard/tools';

	const drawingTools: ReadonlySet<string> = new Set(['pen', 'line', 'rect', 'ellipse', 'arrow', 'text', 'math']);

	const tools: Array<{ id: ToolType | 'math'; label: string; shortcut: string; icon: string }> = [
		{ id: 'select', label: 'Select', shortcut: 'V', icon: 'cursor' },
		{ id: 'pen', label: 'Pen', shortcut: 'P', icon: 'pen' },
		{ id: 'line', label: 'Line', shortcut: 'L', icon: 'line' },
		{ id: 'rect', label: 'Rect', shortcut: 'R', icon: 'rect' },
		{ id: 'ellipse', label: 'Ellipse', shortcut: 'E', icon: 'ellipse' },
		{ id: 'arrow', label: 'Arrow', shortcut: 'A', icon: 'arrow' },
		{ id: 'text', label: 'Text', shortcut: 'T', icon: 'text' },
		{ id: 'math', label: 'Math', shortcut: '', icon: 'math' },
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
	export let readOnly = false;

	$: policyBadge = (() => {
		const p = $policy;
		if (p?.access === 'desktop_only') return { label: 'Desktop-only', icon: 'lock' };
		if (p?.writeAccess === 'desktop') return { label: 'Desktop-edit', icon: 'desktop' };
		return null;
	})();

	function isToolDisabled(id: string): boolean {
		return readOnly && drawingTools.has(id);
	}

	function setTool(id: ToolType | 'math') {
		boardStore.setTool(id as ToolType);
	}

	const MATH_FONT_SIZE = 32;

	let mathEditorOpen = false;
	let mathPlacement: MathPlacement | null = null;
	let latexDraft = '';
	let mathInputEl: HTMLInputElement | null = null;

	const unsubMathPlacement = onMathPlacement((placement) => {
		mathPlacement = placement;
		latexDraft = '';
		mathEditorOpen = true;
	});

	onDestroy(() => {
		unsubMathPlacement();
	});

	$: if (mathEditorOpen) {
		tick().then(() => mathInputEl?.focus());
	}

	function commitMath() {
		if (!mathPlacement) {
			closeMath();
			return;
		}
		const latex = latexDraft.trim();
		if (latex) {
			boardStore.addElement(buildMathElement(mathPlacement, latex, MATH_FONT_SIZE));
		}
		closeMath();
	}

	function closeMath() {
		mathEditorOpen = false;
		mathPlacement = null;
		latexDraft = '';
	}

	function handleMathKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			commitMath();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			closeMath();
		}
	}

	$: mathPreviewHtml = (() => {
		if (!mathEditorOpen || !latexDraft.trim()) return '';
		try {
			return renderToString(latexDraft, {
				displayMode: false,
				output: 'html',
				throwOnError: false,
				strict: 'ignore'
			});
		} catch {
			return '';
		}
	})();

	function setColor(color: string) {
		boardStore.setStyle({ strokeColor: color });
	}

	function setWidth(w: number) {
		boardStore.setStyle({ strokeWidth: w });
	}

	function setHardness(h: number) {
		boardStore.setStyle({ hardness: h / 100 });
	}

	function setOpacity(o: number) {
		boardStore.setStyle({ opacity: o / 100 });
	}
</script>

<div class="wb-toolbar">
	<div class="wb-toolbar-section tools">
		{#each tools as tool}
			<button
				class="wb-tool-btn"
				class:active={$activeTool === tool.id}
				class:readonly-disabled={isToolDisabled(tool.id)}
				on:click={() => setTool(tool.id)}
				disabled={isToolDisabled(tool.id)}
				title="{tool.label} ({tool.shortcut}){readOnly && drawingTools.has(tool.id) ? ' — disabled in view-only mode' : ''}"
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
					{:else if tool.icon === 'math'}
						<svg viewBox="0 0 20 20" fill="currentColor"><text x="2.5" y="16" font-size="16" font-weight="bold" font-family="serif">Σ</text></svg>
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
			disabled={readOnly || !$canUndo}
			title="Undo (Ctrl+Z)"
		>
			<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 8l-3 3 3 3"/><path d="M2 11h11a4 4 0 000-8H8"/></svg>
		</button>
		<button
			class="wb-tool-btn"
			on:click={() => boardStore.redo()}
			disabled={readOnly || !$canRedo}
			title="Redo (Ctrl+Shift+Z)"
		>
			<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M15 8l3 3-3 3"/><path d="M18 11H7a4 4 0 010-8h5"/></svg>
		</button>
		<button
			class="wb-tool-btn"
			on:click={() => onImportImages?.()}
			disabled={readOnly || importDisabled || !onImportImages}
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
				disabled={readOnly}
				title={color}
			></button>
		{/each}
	</div>

	<div class="wb-toolbar-divider"></div>

	{#if $activeTool === 'pen'}
		<div class="wb-brush-settings">
			<label class="wb-brush-control">
				<span class="wb-brush-label">Size</span>
				<span class="wb-brush-row">
					<input
						type="range"
						min="1"
						max="64"
						step="1"
						value={$currentStyle.strokeWidth}
						on:input={(e) => setWidth(Number((e.currentTarget as HTMLInputElement).value))}
						class="wb-brush-slider"
						disabled={readOnly}
						aria-label="Brush size"
					/>
					<span class="wb-brush-value">{$currentStyle.strokeWidth}px</span>
				</span>
			</label>
			<label class="wb-brush-control">
				<span class="wb-brush-label">Hardness</span>
				<span class="wb-brush-row">
					<input
						type="range"
						min="0"
						max="100"
						step="1"
						value={Math.round(($currentStyle.hardness ?? 1) * 100)}
						on:input={(e) => setHardness(Number((e.currentTarget as HTMLInputElement).value))}
						class="wb-brush-slider"
						disabled={readOnly}
						aria-label="Brush hardness"
					/>
					<span class="wb-brush-value">{Math.round(($currentStyle.hardness ?? 1) * 100)}%</span>
				</span>
			</label>
			<label class="wb-brush-control">
				<span class="wb-brush-label">Opacity</span>
				<span class="wb-brush-row">
					<input
						type="range"
						min="10"
						max="100"
						step="1"
						value={Math.round(($currentStyle.opacity ?? 1) * 100)}
						on:input={(e) => setOpacity(Number((e.currentTarget as HTMLInputElement).value))}
						class="wb-brush-slider"
						disabled={readOnly}
						aria-label="Brush opacity"
					/>
					<span class="wb-brush-value">{Math.round(($currentStyle.opacity ?? 1) * 100)}%</span>
				</span>
			</label>
		</div>
	{:else}
		<div class="wb-toolbar-section widths">
			{#each strokeWidths as w}
				<button
					class="wb-width-btn"
					class:active={$currentStyle.strokeWidth === w}
					on:click={() => setWidth(w)}
					disabled={readOnly}
					title="{w}px"
				>
					<span class="wb-width-preview" style="height: {Math.max(2, w)}px"></span>
				</button>
			{/each}
		</div>
	{/if}

	{#if policyBadge}
		<div class="wb-policy-badge" title={policyBadge.label === 'Desktop-only'
			? 'Only the Wabi desktop app can open this board'
			: 'Only the Wabi desktop app can edit this board'}>
			<span class="wb-policy-badge-icon">
				{#if policyBadge.icon === 'lock'}
					<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="9" width="12" height="8" rx="1.5"/><path d="M7 9V6a3 3 0 016 0v3"/></svg>
				{:else}
					<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="14" height="9" rx="1.5"/><path d="M8 17h4M10 13v4"/></svg>
				{/if}
			</span>
			<span>{policyBadge.label}</span>
		</div>
	{/if}
</div>

{#if mathEditorOpen}
	<div class="wb-math-overlay" role="dialog" aria-modal="true" aria-label="Insert math" tabindex="-1">
		<button class="wb-math-backdrop" aria-label="Cancel math insertion" on:click={closeMath}></button>
		<div class="wb-math-popover">
			<div class="wb-math-header">
				<span class="wb-math-title">Insert math</span>
				<button class="wb-math-close" on:click={closeMath} aria-label="Close math editor">×</button>
			</div>
			<input
				class="wb-math-input"
				placeholder={'e.g. e^{i\\pi} + 1 = 0'}
				bind:this={mathInputEl}
				bind:value={latexDraft}
				on:keydown={handleMathKeydown}
				aria-label="LaTeX expression"
			/>
			<div class="wb-math-preview">
				{#if mathPreviewHtml}
					{@html mathPreviewHtml}
				{:else}
					<span class="wb-math-preview-empty">Preview appears here</span>
				{/if}
			</div>
			<div class="wb-math-actions">
				<button class="wb-math-btn wb-math-cancel" on:click={closeMath}>Cancel</button>
				<button class="wb-math-btn wb-math-commit" on:click={commitMath} disabled={!latexDraft.trim()}>Commit</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.wb-toolbar {
		position: absolute;
		top: 4.25rem;
		left: 0.9rem;
		transform: none;
		z-index: 20;
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 6px 9px;
		border-radius: 14px;
		background: color-mix(in srgb, var(--surface-base, #24243e) 82%, transparent);
		backdrop-filter: blur(12px);
		border: 1px solid color-mix(in srgb, var(--text-muted, #9999ff) 26%, transparent);
		box-shadow: 0 14px 32px rgba(var(--surface-app-rgb, 15, 23, 42), 0.14);
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
		background: color-mix(in srgb, var(--text-muted, #9999ff) 28%, transparent);
	}

	.wb-tool-btn {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		padding: 0;
		border: 1px solid transparent;
		border-radius: 8px;
		background: transparent;
		color: var(--text-secondary, #b3b3ff);
		cursor: pointer;
		transition: background 0.12s, color 0.12s, border-color 0.12s, transform 0.12s, box-shadow 0.12s;
	}

	.wb-tool-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--text-muted, #9999ff) 14%, transparent);
		color: var(--text-heading, #e0e0ff);
		border-color: color-mix(in srgb, var(--text-muted, #9999ff) 28%, transparent);
		transform: translateY(-1px);
		box-shadow: 0 6px 14px rgba(var(--surface-app-rgb, 15, 23, 42), 0.18);
	}

	.wb-tool-btn.active {
		background: color-mix(in srgb, var(--accent-primary, #6366f1) 16%, transparent);
		color: var(--accent-primary, #6366f1);
		border-color: color-mix(in srgb, var(--accent-primary, #6366f1) 34%, transparent);
	}

	.wb-tool-btn:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.wb-tool-btn.readonly-disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.wb-tool-btn.readonly-disabled:hover {
		transform: none;
		box-shadow: none;
	}

	@media (prefers-reduced-motion: reduce) {
		.wb-tool-btn {
			transition: background 0.12s, color 0.12s, border-color 0.12s;
		}

		.wb-tool-btn:hover:not(:disabled) {
			transform: none;
			box-shadow: none;
		}
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

	.wb-color-swatch:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.wb-color-swatch:disabled:hover {
		transform: none;
	}

	.wb-color-swatch.active {
		border-color: var(--text-inverse, #ffffff);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent-primary, #6366f1) 48%, transparent);
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
		background: color-mix(in srgb, var(--text-muted, #9999ff) 14%, transparent);
	}

	.wb-width-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.wb-width-btn:disabled:hover {
		background: transparent;
	}

	.wb-width-btn.active {
		background: color-mix(in srgb, var(--accent-primary, #6366f1) 16%, transparent);
	}

	.wb-width-preview {
		display: block;
		width: 16px;
		border-radius: 2px;
		background: color-mix(in srgb, var(--surface-base, #24243e) 72%, transparent);
	}

	.wb-brush-settings {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.wb-brush-control {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
	}

	.wb-brush-label {
		font-size: 8px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-muted, #9999ff);
	}

	.wb-brush-row {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.wb-brush-slider {
		width: 64px;
		height: 4px;
		border-radius: var(--radius-sm, 4px);
		background: color-mix(in srgb, var(--text-muted, #9999ff) 22%, transparent);
		outline: none;
		-webkit-appearance: none;
		appearance: none;
	}

	.wb-brush-slider::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--accent-primary, #6366f1);
		cursor: pointer;
		transition: transform 0.12s;
	}

	.wb-brush-slider::-webkit-slider-thumb:hover {
		transform: scale(1.25);
	}

	.wb-brush-slider::-moz-range-thumb {
		width: 10px;
		height: 10px;
		border: none;
		border-radius: 50%;
		background: var(--accent-primary, #6366f1);
		cursor: pointer;
		transition: transform 0.12s;
	}

	.wb-brush-slider::-moz-range-thumb:hover {
		transform: scale(1.25);
	}

	.wb-brush-slider:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.wb-brush-value {
		font-size: 9px;
		font-variant-numeric: tabular-nums;
		color: var(--text-secondary, #b3b3ff);
		min-width: 30px;
		text-align: right;
	}

	.wb-policy-badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		margin-left: 4px;
		padding: 3px 9px;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--accent-primary, #6366f1) 34%, transparent);
		background: color-mix(in srgb, var(--accent-primary, #6366f1) 14%, transparent);
		color: var(--accent-primary, #6366f1);
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.03em;
		white-space: nowrap;
		user-select: none;
	}

	.wb-policy-badge-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.wb-policy-badge-icon svg {
		width: 12px;
		height: 12px;
	}

	@media (prefers-reduced-motion: reduce) {
		.wb-brush-slider::-webkit-slider-thumb,
		.wb-brush-slider::-moz-range-thumb {
			transition: none;
		}
	}

	.wb-math-overlay {
		position: fixed;
		inset: 0;
		z-index: 1000;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(10, 8, 30, 0.45);
		backdrop-filter: blur(2px);
	}

	.wb-math-backdrop {
		position: absolute;
		inset: 0;
		border: none;
		padding: 0;
		background: transparent;
		cursor: default;
	}

	.wb-math-popover {
		position: relative;
		z-index: 1;
		width: min(480px, calc(100vw - 48px));
		padding: 18px 20px 16px;
		border-radius: var(--radius-md, 12px);
		background: var(--surface-raised, #302b63);
		border: 1px solid color-mix(in srgb, var(--text-muted, #9999ff) 26%, transparent);
		box-shadow: 0 20px 44px rgba(15, 12, 41, 0.5);
		color: var(--text-heading, #e0e0ff);
	}

	.wb-math-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 12px;
	}

	.wb-math-title {
		font-size: 13px;
		font-weight: 700;
		letter-spacing: 0.03em;
		color: var(--text-heading, #e0e0ff);
	}

	.wb-math-close {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		padding: 0;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: var(--text-muted, #9999ff);
		font-size: 16px;
		line-height: 1;
		cursor: pointer;
		transition: background 0.12s, color 0.12s;
	}

	.wb-math-close:hover {
		background: color-mix(in srgb, var(--text-muted, #9999ff) 14%, transparent);
		color: var(--text-heading, #e0e0ff);
	}

	.wb-math-input {
		width: 100%;
		box-sizing: border-box;
		padding: 9px 12px;
		border: 1px solid color-mix(in srgb, var(--text-muted, #9999ff) 30%, transparent);
		border-radius: var(--radius-md, 12px);
		background: var(--surface-sunken, #0f0c29);
		color: var(--text-heading, #e0e0ff);
		font-family: var(--font-mono, monospace);
		font-size: 13px;
		outline: none;
		transition: border-color 0.12s, box-shadow 0.12s;
	}

	.wb-math-input:focus {
		border-color: var(--accent-primary, #6366f1);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-primary, #6366f1) 30%, transparent);
	}

	.wb-math-preview {
		display: flex;
		align-items: center;
		min-height: 64px;
		margin-top: 12px;
		padding: 12px;
		border: 1px dashed color-mix(in srgb, var(--text-muted, #9999ff) 24%, transparent);
		border-radius: var(--radius-md, 12px);
		background: color-mix(in srgb, var(--surface-base, #24243e) 60%, transparent);
		font-size: 24px;
		overflow-x: auto;
	}

	.wb-math-preview-empty {
		font-size: 12px;
		color: var(--text-muted, #9999ff);
	}

	.wb-math-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 14px;
	}

	.wb-math-btn {
		padding: 7px 14px;
		border: none;
		border-radius: var(--radius-md, 12px);
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.12s, color 0.12s, transform 0.12s;
	}

	.wb-math-btn:hover:not(:disabled) {
		transform: translateY(-1px);
	}

	.wb-math-btn:disabled {
		opacity: 0.45;
		cursor: default;
	}

	.wb-math-cancel {
		background: color-mix(in srgb, var(--text-muted, #9999ff) 14%, transparent);
		color: var(--text-secondary, #b3b3ff);
	}

	.wb-math-cancel:hover:not(:disabled) {
		background: color-mix(in srgb, var(--text-muted, #9999ff) 22%, transparent);
		color: var(--text-heading, #e0e0ff);
	}

	.wb-math-commit {
		background: var(--accent-primary, #6366f1);
		color: #ffffff;
	}

	.wb-math-commit:hover:not(:disabled) {
		filter: brightness(1.08);
	}

	@media (prefers-reduced-motion: reduce) {
		.wb-math-btn {
			transition: background 0.12s, color 0.12s;
		}

		.wb-math-btn:hover:not(:disabled) {
			transform: none;
		}
	}
</style>
