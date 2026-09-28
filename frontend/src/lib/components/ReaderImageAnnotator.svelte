<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { activeServerUrl } from '$lib/serverUrl';
	import { getAuthToken, getGuestSessionId, getStoredDbUserId } from '$lib/authSession';
	import { getReaderAnonymousDeviceId, makeReaderDocumentScope } from '$lib/readerDocumentScope';
	import type { ImagePage } from '$lib/readerWorkspace';

	type Point = { x: number; y: number; pressure: number };
	type Mark = { id: string; kind: 'pen' | 'highlight'; color: string; width: number; points: Point[] } | { id: string; kind: 'note'; color: string; x: number; y: number; text: string };
	type Mode = 'read' | 'pen' | 'highlight' | 'note' | 'erase';
	let { image, pageIndex, documentKey }: { image: ImagePage; pageIndex: number; documentKey: string } = $props();
	const dispatch = createEventDispatcher<{ open: void }>();
	let mode: Mode = $state('read');
	let color = $state('#efb443');
	let width = $state(4);
	let naturalWidth = $state(image.width || 0);
	let naturalHeight = $state(image.height || 0);
	let marks: Mark[] = $state([]);
	let drawing: Mark | null = $state(null);
	let undoStack: Mark[][] = $state([]);
	let redoStack: Mark[][] = $state([]);
	let saveError = $state('');
	let svg = $state<SVGSVGElement | null>(null);
	function makeId(): string { return (typeof crypto !== 'undefined' ? crypto.randomUUID?.() : undefined) || `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
	const identity = $derived.by(() => {
		const server = $activeServerUrl;
		const registered = getAuthToken(server) && getStoredDbUserId(server);
		return registered ? `user:${registered}` : getGuestSessionId(server) ? `guest:${getGuestSessionId(server)}` : `device:${getReaderAnonymousDeviceId()}`;
	});
	const scope = $derived(makeReaderDocumentScope($activeServerUrl, identity));
	const storageKey = $derived(image.digest ? `wabi:reader:image-marks:v1:${encodeURIComponent(scope)}:${image.digest}` : '');
	$effect(() => {
		const key = storageKey;
		marks = [];
		undoStack = [];
		redoStack = [];
		saveError = '';
		if (!key) return;
		try {
			const saved = JSON.parse(localStorage.getItem(key) || 'null');
			if (saved?.version === 1 && saved.sourceDigest === image.digest && Array.isArray(saved.marks)) marks = saved.marks;
		} catch { saveError = 'Saved marks could not be read. The source image is unchanged.'; }
	});
	function remember(): void { undoStack = [...undoStack.slice(-49), structuredClone(marks)]; redoStack = []; }
	function save(): void {
		if (!storageKey || !naturalWidth || !naturalHeight) return;
		try {
			localStorage.setItem(storageKey, JSON.stringify({ version: 1, sourceDigest: image.digest, documentKey, pageIndex, width: naturalWidth, height: naturalHeight, marks }));
			saveError = '';
		} catch { saveError = 'Marks could not be saved on this device. Export a copy before leaving.'; }
	}
	function point(event: PointerEvent): Point {
		const bounds = svg!.getBoundingClientRect();
		return { x: Math.max(0, Math.min(naturalWidth, (event.clientX - bounds.left) * naturalWidth / bounds.width)), y: Math.max(0, Math.min(naturalHeight, (event.clientY - bounds.top) * naturalHeight / bounds.height)), pressure: event.pressure || 0.5 };
	}
	function pointerDown(event: PointerEvent): void {
		if (!naturalWidth || !naturalHeight || mode === 'read' || mode === 'erase') return;
		const p = point(event);
		if (mode === 'note') {
			const text = window.prompt('Text note')?.trim();
			if (text) { remember(); marks = [...marks, { id: makeId(), kind: 'note', color, x: p.x, y: p.y, text: text.slice(0, 500) }]; save(); }
			return;
		}
		event.preventDefault();
		remember();
		drawing = { id: makeId(), kind: mode, color, width, points: [p] };
		svg?.setPointerCapture(event.pointerId);
	}
	function pointerMove(event: PointerEvent): void {
		if (!drawing || drawing.kind === 'note') return;
		for (const sample of event.getCoalescedEvents?.() || [event]) drawing.points.push(point(sample));
		drawing = { ...drawing, points: [...drawing.points] };
	}
	function pointerEnd(event: PointerEvent): void {
		if (!drawing || drawing.kind === 'note') return;
		if (svg?.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
		marks = [...marks, drawing]; drawing = null; save();
	}
	function erase(id: string): void { if (mode !== 'erase') return; remember(); marks = marks.filter(mark => mark.id !== id); save(); }
	function undo(): void { const previous = undoStack.at(-1); if (!previous) return; redoStack = [...redoStack, structuredClone(marks)]; undoStack = undoStack.slice(0, -1); marks = previous; save(); }
	function redo(): void { const next = redoStack.at(-1); if (!next) return; undoStack = [...undoStack, structuredClone(marks)]; redoStack = redoStack.slice(0, -1); marks = next; save(); }
	function exportMarks(): void {
		const content = JSON.stringify({ version: 1, sourceDigest: image.digest, documentKey, pageIndex, width: naturalWidth, height: naturalHeight, marks }, null, 2);
		const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
		const link = document.createElement('a'); link.href = url; link.download = `reader-marks-${image.digest?.slice(0, 12) || pageIndex}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
	function path(mark: Extract<Mark, { points: Point[] }>): string { return mark.points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' '); }
</script>

<div class="annotation-page">
	<div class="annotation-tools" role="toolbar" aria-label={`Image ${pageIndex + 1} annotation tools`}>
		{#each ['read', 'pen', 'highlight', 'note', 'erase'] as choice}
			<button type="button" class:active={mode === choice} aria-pressed={mode === choice} disabled={!image.digest} onclick={() => mode = choice as Mode}>{choice === 'note' ? 'Text note' : choice[0].toUpperCase() + choice.slice(1)}</button>
		{/each}
		{#if mode !== 'read'}<label>Color <input type="color" bind:value={color} /></label><label>Width <input type="range" min="1" max="20" bind:value={width} /></label>{/if}
		<button type="button" disabled={!undoStack.length} onclick={undo}>Undo</button><button type="button" disabled={!redoStack.length} onclick={redo}>Redo</button><button type="button" disabled={!marks.length} onclick={exportMarks}>Export marks</button>
		{#if mode === 'erase'}{#each marks as mark, index (mark.id)}<button type="button" onclick={() => erase(mark.id)}>Remove {mark.kind} {index + 1}</button>{/each}{/if}
	</div>
	{#if !image.digest}<p class="annotation-note">Import an image file to annotate this page.</p>{/if}
	{#if saveError}<p class="annotation-error" role="alert">{saveError}</p>{/if}
	<div class="annotation-image-wrap">
		<button type="button" class="annotation-image-button" aria-label={`Open image ${pageIndex + 1}: ${image.alt || 'Image'}`} onclick={() => { if (mode === 'read') dispatch('open'); }}><img src={image.url} alt={image.alt || `Image ${pageIndex + 1}`} width={image.width} height={image.height} decoding="async" onload={(event) => { naturalWidth = (event.currentTarget as HTMLImageElement).naturalWidth; naturalHeight = (event.currentTarget as HTMLImageElement).naturalHeight; }} /></button>
		{#if naturalWidth && naturalHeight}<svg bind:this={svg} class:interactive={mode !== 'read'} viewBox={`0 0 ${naturalWidth} ${naturalHeight}`} preserveAspectRatio="none" aria-label="Image annotations" onpointerdown={pointerDown} onpointermove={pointerMove} onpointerup={pointerEnd} onpointercancel={pointerEnd}>
			{#each [...marks, ...(drawing ? [drawing] : [])] as mark (mark.id)}
				{#if mark.kind === 'note'}<text x={mark.x} y={mark.y} fill={mark.color} font-size="20" stroke="black" stroke-width="0.4" onclick={() => erase(mark.id)}>{mark.text}</text>{:else}<path d={path(mark)} fill="none" stroke={mark.color} stroke-width={mark.kind === 'highlight' ? mark.width * 5 : mark.width} stroke-opacity={mark.kind === 'highlight' ? 0.35 : 1} stroke-linecap="round" stroke-linejoin="round" onclick={() => erase(mark.id)} />{/if}
			{/each}
		</svg>{/if}
	</div>
</div>

<style>
	.annotation-page { display: grid; justify-items: center; gap: 8px; }
	.annotation-tools { display: flex; flex-wrap: wrap; justify-content: center; gap: 5px; }
	.annotation-tools button { border: 1px solid var(--border-default); border-radius: 6px; background: var(--surface-raised); color: var(--text-primary); padding: 6px 9px; font: inherit; cursor: pointer; }
	.annotation-tools button.active { border-color: var(--accent-primary); color: var(--accent-primary); }
	.annotation-tools button:disabled { opacity: .5; cursor: default; }
	.annotation-tools label { display: flex; align-items: center; gap: 4px; font-size: 12px; }
	.annotation-image-wrap { position: relative; display: inline-block; max-width: 100%; }
	.annotation-image-button { display: block; border: 0; padding: 0; background: transparent; max-width: 100%; cursor: zoom-in; }
	.annotation-image-button img { display: block; max-width: 100%; height: auto; }
	svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
	svg.interactive { pointer-events: auto; touch-action: none; cursor: crosshair; }
	svg.interactive path, svg.interactive text { cursor: pointer; }
	.annotation-note, .annotation-error { color: var(--text-secondary); font-size: 12px; }
	.annotation-error { color: var(--text-danger); }
</style>
