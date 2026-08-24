<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import { renderToString } from 'katex';
	import {
		boardStore,
		activeTool,
		currentStyle,
		canUndo,
		canRedo,
		policy,
		selection,
		elements,
		boardState,
		activeLayerId,
		layers
	} from '$lib/whiteboard/boardStore';
	import type { ToolType } from '$lib/whiteboard/boardStore';
	import { onMathPlacement, buildMathElement, type MathPlacement } from '$lib/whiteboard/tools';

	const drawingTools: ReadonlySet<string> = new Set(['pen', 'line', 'rect', 'ellipse', 'arrow', 'text', 'math', 'eraser']);

	const tools: Array<{ id: ToolType | 'math'; label: string; shortcut: string; icon: string }> = [
		{ id: 'select', label: 'Select', shortcut: 'V', icon: 'cursor' },
		{ id: 'pen', label: 'Pen', shortcut: 'P', icon: 'pen' },
		{ id: 'eraser', label: 'Eraser', shortcut: '', icon: 'eraser' },
		{ id: 'line', label: 'Line', shortcut: 'L', icon: 'line' },
		{ id: 'rect', label: 'Rect', shortcut: 'R', icon: 'rect' },
		{ id: 'ellipse', label: 'Ellipse', shortcut: 'E', icon: 'ellipse' },
		{ id: 'arrow', label: 'Arrow', shortcut: 'A', icon: 'arrow' },
		{ id: 'text', label: 'Text', shortcut: 'T', icon: 'text' },
		{ id: 'math', label: 'Math', shortcut: '', icon: 'math' },
		{ id: 'pan', label: 'Pan', shortcut: 'Space', icon: 'pan' }
	];

	const strokeWidths = [1, 2, 4, 8];

	export let onExportPng: (() => void) | null = null;
	export let onExportJson: (() => void) | null = null;
	export let onImportImages: (() => void) | null = null;
	export let exportBusy = false;
	export let importDisabled = false;
	export let readOnly = false;

	// Local state for color text input
	let strokeColorInput = $currentStyle.strokeColor;
	let fillColorInput = $currentStyle.fillColor;
	let fontSizeInput = $currentStyle.fontSize || 16;

	$: strokeColorInput = $currentStyle.strokeColor;
	$: fillColorInput = $currentStyle.fillColor;
	$: fontSizeInput = $currentStyle.fontSize || 16;

	$: policyBadge = (() => {
		const p = $policy;
		if (p?.access === 'desktop_only') return { label: 'Desktop-only', icon: 'lock' };
		if (p?.writeAccess === 'desktop') return { label: 'Desktop-edit', icon: 'desktop' };
		return null;
	})();

	$: activeLayer = $layers.find((l) => l.id === $activeLayerId) || null;
	$: layerModeBadge = activeLayer
		? activeLayer.mode === 'raster'
			? { label: 'Paint', mode: 'raster' as const }
			: { label: 'Vector', mode: 'vector' as const }
		: null;

	function isToolDisabled(id: string): boolean {
		return readOnly && drawingTools.has(id);
	}

	function setTool(id: ToolType | 'math') {
		boardStore.setTool(id as ToolType);
	}

	function setStrokeColor(text: string) {
		const c = text.trim();
		if (c && /^#[0-9a-fA-F]{6}$/.test(c)) {
			boardStore.setStyle({ strokeColor: c });
		}
	}

	function setFillColor(text: string) {
		const c = text.trim();
		if (c && /^#[0-9a-fA-F]{6}$/.test(c)) {
			boardStore.setStyle({ fillColor: c });
		}
	}

	function pickStrokeColor(color: string) {
		boardStore.setStyle({ strokeColor: color });
	}

	function pickFillColor(color: string) {
		boardStore.setStyle({ fillColor: color });
	}

	function setBorderRadius(r: number) {
		boardStore.setStyle({ borderRadius: r });
	}

	function alignElements(axis: 'x' | 'y', mode: 'min' | 'center' | 'max') {
		const sel = $selection;
		if (sel.size < 2) return;
		const els = $elements.filter((e) => sel.has(e.id));
		if (els.length < 2) return;
		let ref: number;
		if (axis === 'x') {
			if (mode === 'min') ref = Math.min(...els.map((e) => e.x));
			else if (mode === 'max') ref = Math.max(...els.map((e) => e.x + (e.width || 0)));
			else ref = els.reduce((s, e) => s + e.x + (e.width || 0) / 2, 0) / els.length;
		} else {
			if (mode === 'min') ref = Math.min(...els.map((e) => e.y));
			else if (mode === 'max') ref = Math.max(...els.map((e) => e.y + (e.height || 0)));
			else ref = els.reduce((s, e) => s + e.y + (e.height || 0) / 2, 0) / els.length;
		}
		for (const el of els) {
			if (axis === 'x') {
				if (mode === 'min') boardStore.updateElement(el.id, { x: ref });
				else if (mode === 'max') boardStore.updateElement(el.id, { x: ref - (el.width || 0) });
				else boardStore.updateElement(el.id, { x: ref - (el.width || 0) / 2 });
			} else {
				if (mode === 'min') boardStore.updateElement(el.id, { y: ref });
				else if (mode === 'max') boardStore.updateElement(el.id, { y: ref - (el.height || 0) });
				else boardStore.updateElement(el.id, { y: ref - (el.height || 0) / 2 });
			}
		}
	}

	let canvasBgInput = $boardState.canvasBgColor || '';

	function setCanvasBgColorInStore(color: string) {
		const c = color.trim();
		if (c && /^#[0-9a-fA-F]{6}$/.test(c)) {
			boardStore.setCanvasBgColor(c);
		} else if (!c) {
			boardStore.setCanvasBgColor(undefined);
		}
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

	function setFontSize(s: number) {
		boardStore.setStyle({ fontSize: s });
	}

	function setStrokeDash(dash: number[] | undefined) {
		boardStore.setStyle({ strokeDash: dash });
	}

	const colorSwatches = ['#111111', '#ffffff', '#e11d48', '#f59e0b', '#16a34a', '#2563eb', '#7c3aed'];
	let toolbarPinned = false;
	let toolbarHover = false;
	$: toolbarOpen = toolbarPinned || toolbarHover;
</script>

<div
	class="wb-toolbar-rail"
	class:open={toolbarOpen}
	class:pinned={toolbarPinned}
	role="toolbar"
	aria-label="Whiteboard tools"
	on:mouseenter={() => (toolbarHover = true)}
	on:mouseleave={() => (toolbarHover = false)}
>
	<button type="button" class="wb-rail-toggle" on:click={() => (toolbarPinned = !toolbarPinned)} aria-pressed={toolbarPinned} title={toolbarPinned ? 'Collapse tools' : 'Keep tools open'}>
		<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 6h12M4 10h12M4 14h12"/></svg>
	</button>
	<div class="wb-toolbar">
	{#if activeLayer && layerModeBadge}
		<div class="wb-layer-mode-chip" class:raster={layerModeBadge.mode === 'raster'} title="Active layer: {activeLayer.name} ({layerModeBadge.label})">
			<span class="wb-layer-mode-name">{activeLayer.name}</span>
			<span class="wb-layer-mode-badge">{layerModeBadge.label}</span>
		</div>
	{/if}
	<div class="wb-toolbar-section tools">
		<span class="wb-toolbar-group-label">Tools</span>
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
					{:else if tool.icon === 'eraser'}
						<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="m3 13 8.6-8.6a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L8 18H5a2 2 0 0 1-2-2v-3Z"/><path d="m8 18 5-5"/><path d="M6 15h.01" stroke-linecap="round"/></svg>
					{/if}
				</span>
			</button>
		{/each}
	</div>

	<div class="wb-toolbar-divider"></div>

	<div class="wb-toolbar-section actions">
		<span class="wb-toolbar-group-label">Edit</span>
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

	<!-- Align tools (visible when ≥2 elements selected) -->
	{#if $selection.size >= 2}
		<div class="wb-toolbar-section aligns">
			<button class="wb-tool-btn" title="Align left" on:click={() => alignElements('x', 'min')} disabled={readOnly}>
				<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="12" height="12" rx="1.5"/><line x1="5" y1="15" x2="15" y2="15"/></svg>
			</button>
			<button class="wb-tool-btn" title="Align center" on:click={() => alignElements('x', 'center')} disabled={readOnly}>
				<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="12" height="12" rx="1.5"/><line x1="10" y1="4" x2="10" y2="16"/></svg>
			</button>
			<button class="wb-tool-btn" title="Align right" on:click={() => alignElements('x', 'max')} disabled={readOnly}>
				<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="12" height="12" rx="1.5"/><line x1="15" y1="4" x2="5" y2="16"/></svg>
			</button>
			<div class="wb-toolbar-divider-sm"></div>
			<button class="wb-tool-btn" title="Align top" on:click={() => alignElements('y', 'min')} disabled={readOnly}>
				<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="12" height="12" rx="1.5"/><line x1="4" y1="5" x2="16" y2="5"/></svg>
			</button>
			<button class="wb-tool-btn" title="Align middle" on:click={() => alignElements('y', 'center')} disabled={readOnly}>
				<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="12" height="12" rx="1.5"/><line x1="4" y1="10" x2="16" y2="10"/></svg>
			</button>
			<button class="wb-tool-btn" title="Align bottom" on:click={() => alignElements('y', 'max')} disabled={readOnly}>
				<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="12" height="12" rx="1.5"/><line x1="4" y1="15" x2="16" y2="5"/></svg>
			</button>
		</div>
	{/if}

	<div class="wb-toolbar-section exports">
		<span class="wb-toolbar-group-label">File</span>
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
		<label class="wb-color-quick" title="Stroke color">
			<span>Ink</span>
			<input type="color" value={$currentStyle.strokeColor} on:input={(e) => pickStrokeColor((e.currentTarget as HTMLInputElement).value)} disabled={readOnly} aria-label="Stroke color" />
		</label>
		<label class="wb-color-quick" title="Fill color">
			<span>Fill</span>
			<input type="color" value={$currentStyle.fillColor === 'transparent' ? '#ffffff' : $currentStyle.fillColor} on:input={(e) => pickFillColor((e.currentTarget as HTMLInputElement).value)} disabled={readOnly} aria-label="Fill color" />
		</label>
		<div class="wb-swatch-row" role="group" aria-label="Ink swatches">
			{#each colorSwatches as color}
				<button type="button" class="wb-color-swatch" class:active={$currentStyle.strokeColor === color} style="--swatch-color: {color}" on:click={() => pickStrokeColor(color)} disabled={readOnly} title={color}></button>
			{/each}
		</div>
	</div>

	<div class="wb-toolbar-divider"></div>

	<!-- Canvas background color -->
			<div class="wb-toolbar-section canvas-bg">
			<button class="wb-tool-btn" title="Canvas background" on:click={() => canvasBgInput = $boardState.canvasBgColor || ''} disabled={readOnly}>
			<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="14" height="14" rx="2"/><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"/></svg>
			</button>
			<input
			type="color"
			class="wb-color-native wb-canvas-bg-picker"
			value={canvasBgInput}
			on:input={(e) => setCanvasBgColorInStore((e.currentTarget as HTMLInputElement).value)}
			disabled={readOnly}
			title="Canvas background color"
			/>
			<button class="wb-tool-btn wb-clear-bg" title="Clear background" on:click={() => setCanvasBgColorInStore('')} disabled={readOnly || !$boardState.canvasBgColor}>
			<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 5l10 10M15 5L5 15" stroke-linecap="round"/></svg>
			</button>
			</div>

			<div class="wb-toolbar-divider"></div>

			{#if $activeTool === 'pen'}
		<div class="wb-brush-settings">
			<span class="wb-toolbar-group-label">Brush</span>
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

			{#if $activeTool === 'pen' || $activeTool === 'line' || $activeTool === 'arrow'}
				<label class="wb-brush-control">
					<span class="wb-brush-label">Dash</span>
					<span class="wb-brush-row">
						<select
							class="wb-brush-select"
							value={$currentStyle.strokeDash || 'none'}
							on:change={(e) => {
								const v = (e.currentTarget as HTMLSelectElement).value;
								setStrokeDash(v === 'none' ? undefined : v === 'dashed' ? [8, 4] : v === 'dotted' ? [2, 4] : undefined);
							}}
							disabled={readOnly}
							aria-label="Stroke dash style"
						>
							<option value="none">Solid</option>
							<option value="dashed">Dashed</option>
							<option value="dotted">Dotted</option>
						</select>
					</span>
				</label>
			{/if}
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

	{#if $activeTool === 'rect'}
		<div class="wb-toolbar-section context-settings">
			<label class="wb-brush-control">
				<span class="wb-brush-label">Radius</span>
				<span class="wb-brush-row">
					<input type="range" min="0" max="120" step="1" value={$currentStyle.borderRadius ?? 0} on:input={(e) => boardStore.setStyle({ borderRadius: Number((e.currentTarget as HTMLInputElement).value) })} class="wb-brush-slider" disabled={readOnly} aria-label="Corner radius" />
					<span class="wb-brush-value">{$currentStyle.borderRadius ?? 0}px</span>
				</span>
			</label>
		</div>
	{/if}

	{#if $activeTool === 'text'}
		<div class="wb-toolbar-section context-settings">
			<label class="wb-brush-control">
				<span class="wb-brush-label">Text size</span>
				<span class="wb-brush-row">
					<input type="range" min="8" max="120" step="1" value={fontSizeInput} on:input={(e) => setFontSize(Number((e.currentTarget as HTMLInputElement).value))} class="wb-brush-slider" disabled={readOnly} aria-label="Text size" />
					<span class="wb-brush-value">{fontSizeInput}px</span>
				</span>
			</label>
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
	.wb-toolbar-rail {
		position: absolute;
		top: var(--wb-chrome-top, 4.1rem);
		left: 0.7rem;
		z-index: 20;
		display: flex;
		align-items: flex-start;
		gap: 0.35rem;
		max-width: calc(100% - 1.4rem);
	}

	.wb-rail-toggle {
		width: 2rem;
		height: 2rem;
		border: 1px solid color-mix(in srgb, var(--text-heading, #fff) 16%, transparent);
		border-radius: 8px;
		background: color-mix(in srgb, var(--surface-base, #24243e) 92%, transparent);
		color: var(--text-heading, #f8fafc);
		cursor: pointer;
	}

	.wb-rail-toggle svg {
		width: 1rem;
		height: 1rem;
	}

	.wb-toolbar {
		display: none;
		align-items: center;
		gap: 0.4rem;
		padding: 0.35rem 0.45rem;
		border-radius: 10px;
		background: color-mix(in srgb, var(--surface-base, #24243e) 94%, transparent);
		border: 1px solid color-mix(in srgb, var(--text-heading, #fff) 14%, transparent);
		box-shadow: 0 8px 20px rgba(15, 23, 42, 0.18);
		user-select: none;
		max-width: calc(100vw - 5rem);
		overflow-x: auto;
		scrollbar-width: thin;
	}

	.wb-toolbar-rail.open .wb-toolbar,
	.wb-toolbar-rail:focus-within .wb-toolbar {
		display: flex;
	}

	.wb-toolbar-section {
		display: flex;
		align-items: center;
		gap: 3px;
		flex-shrink: 0;
		min-height: 2rem;
	}

	.wb-toolbar-group-label {
		display: none;
	}

	.wb-toolbar-section.tools,
	.wb-toolbar-section.actions,
	.wb-toolbar-section.exports,
	.wb-toolbar-section.colors,
	.wb-brush-settings {
		flex-direction: row;
		align-items: center;
		flex-wrap: nowrap;
		max-width: none;
		padding: 0;
	}

	.wb-color-quick {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.58rem;
		font-weight: 700;
		text-transform: uppercase;
		color: var(--text-secondary, #d7ddf5);
	}

	.wb-color-quick input {
		width: 1.35rem;
		height: 1.35rem;
		padding: 0;
		border: 1px solid color-mix(in srgb, var(--text-inverse, #fff) 32%, transparent);
		border-radius: 5px;
		background: transparent;
		cursor: pointer;
	}

	.wb-toolbar-divider {
		width: 1px;
		align-self: stretch;
		margin: 0.25rem 0.2rem;
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

	.wb-color-native {
		width: 22px;
		height: 22px;
		padding: 0;
		border: none;
		border-radius: 5px;
		cursor: pointer;
		background: transparent;
	}

	.wb-color-native::-webkit-color-swatch-wrapper {
		padding: 0;
	}

	.wb-color-native::-webkit-color-swatch {
		border: 1px solid color-mix(in srgb, var(--text-muted, #9999ff) 22%, transparent);
		border-radius: 4px;
	}

	.wb-swatch-row {
		display: flex;
		gap: 3px;
		margin-left: 4px;
	}

	.wb-width-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		padding: 0;
		border: none;
		border-radius: 8px;
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

	.wb-layer-mode-chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		margin-right: 2px;
		padding: 3px 8px;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--accent-primary, #6366f1) 34%, transparent);
		background: color-mix(in srgb, var(--accent-primary, #6366f1) 14%, transparent);
		color: var(--accent-primary, #6366f1);
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.02em;
		white-space: nowrap;
		user-select: none;
	}

	.wb-layer-mode-chip.raster {
		border-color: color-mix(in srgb, var(--color-info, #7dd3fc) 45%, transparent);
		background: color-mix(in srgb, var(--color-info, #7dd3fc) 14%, transparent);
		color: var(--color-info, #7dd3fc);
	}

	.wb-layer-mode-name {
		max-width: 10ch;
		overflow: hidden;
		text-overflow: ellipsis;
		font-weight: 600;
		opacity: 0.92;
	}

	.wb-layer-mode-badge {
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 1px 6px;
		border-radius: 999px;
		background: color-mix(in srgb, currentColor 18%, transparent);
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
