<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { getApiBase, fetchWithTimeout, parseApiJson } from '$lib/api/utils';
	import { getAuthToken } from '$lib/authSession';
	import Cad2DViewer from './Cad2DViewer.svelte';

	let {
		src,
		fileName = 'Drawing.dwg',
		height = 460,
		fullBleed = false,
		lazyLoad = true,
		channelId = null
	}: {
		src: string;
		fileName?: string;
		height?: number;
		fullBleed?: boolean;
		lazyLoad?: boolean;
		channelId?: string | null;
	} = $props();

	const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
	const CONVERSION_TIMEOUT_MS = 55_000;
	let started = $state(false);
	let converting = $state(false);
	let previewSrc = $state('');
	let error = $state('');
	let retryNonce = $state(0);
	let generation = 0;
	let activeAbort: AbortController | null = null;

	$effect(() => {
		if (!lazyLoad) started = true;
	});

	function revokePreview(): void {
		if (!previewSrc) return;
		URL.revokeObjectURL(previewSrc);
		previewSrc = '';
	}

	function stopInFlight(): void {
		activeAbort?.abort();
		activeAbort = null;
	}

	async function jsonError(response: Response, fallback: string): Promise<string> {
		try {
			const payload = await parseApiJson(response.clone()) as { error?: unknown } | null;
			if (typeof payload?.error === 'string' && payload.error.trim()) return payload.error.trim();
		} catch { /* fall through */ }
		try {
			const text = (await response.text()).trim();
			if (text && !/^<!doctype|^<html/i.test(text)) return text.slice(0, 800);
		} catch { /* fall through */ }
		return fallback;
	}

	async function sourceBytes(source: string, signal: AbortSignal): Promise<ArrayBuffer> {
		const response = await fetch(source, { signal });
		if (!response.ok) throw new Error(`Could not load DWG (${response.status}).`);
		const declared = Number(response.headers.get('content-length') || 0);
		if (declared > MAX_SOURCE_BYTES) throw new Error("DWG is larger than Wabi's 20 MB preview limit.");
		const buffer = await response.arrayBuffer();
		if (buffer.byteLength > MAX_SOURCE_BYTES) throw new Error("DWG is larger than Wabi's 20 MB preview limit.");
		if (buffer.byteLength === 0) throw new Error('DWG file is empty.');
		return buffer;
	}

	async function convert(source: string, requestGeneration: number, controller: AbortController): Promise<void> {
		try {
			const server = getApiBase().replace(/\/+$/, '');
			const token = getAuthToken(server);
			if (!token) throw new Error('Sign in to this Wabi server before converting DWG previews.');
			const headers = { Authorization: `Bearer ${token}` };

			const capabilities = await fetchWithTimeout(`${server}/api/cad/capabilities`, {
				headers,
				signal: controller.signal,
				timeoutMs: 8_000
			});
			if (!capabilities.ok) {
				throw new Error(await jsonError(capabilities, `Could not check DWG converter availability (${capabilities.status}).`));
			}
			const capabilityPayload = await parseApiJson(capabilities) as { dwg_to_dxf?: boolean } | null;
			if (!capabilityPayload) {
				throw new Error('This Wabi server does not expose the CAD conversion API yet. Update the server before opening DWG previews.');
			}
			if (!capabilityPayload.dwg_to_dxf) {
				throw new Error("This Wabi server does not have LibreDWG's dwg2dxf helper enabled. Install it on the server or point WABI_DWG2DXF_BIN at the helper; the original DWG remains unchanged.");
			}
			if (requestGeneration !== generation || controller.signal.aborted) return;

			const bytes = await sourceBytes(source, controller.signal);
			if (requestGeneration !== generation || controller.signal.aborted) return;
			const response = await fetchWithTimeout(`${server}/api/cad/dwg-to-dxf`, {
				method: 'POST',
				headers: {
					...headers,
					'Content-Type': 'application/vnd.dwg'
				},
				body: bytes,
				signal: controller.signal,
				timeoutMs: CONVERSION_TIMEOUT_MS
			});
			if (!response.ok) {
				throw new Error(await jsonError(response, `DWG conversion failed (${response.status}).`));
			}
			const declared = Number(response.headers.get('content-length') || 0);
			if (declared > MAX_SOURCE_BYTES) throw new Error("Converted DXF is larger than Wabi's 20 MB preview limit.");
			const dxf = await response.arrayBuffer();
			if (dxf.byteLength === 0) throw new Error('DWG conversion returned an empty DXF preview.');
			if (dxf.byteLength > MAX_SOURCE_BYTES) throw new Error("Converted DXF is larger than Wabi's 20 MB preview limit.");
			if (requestGeneration !== generation || controller.signal.aborted) return;

			revokePreview();
			previewSrc = URL.createObjectURL(new Blob([dxf], { type: 'text/plain;charset=utf-8' }));
		} catch (reason) {
			if (requestGeneration === generation && !controller.signal.aborted) {
				error = reason instanceof Error ? reason.message : 'Could not convert this DWG preview.';
			}
		} finally {
			if (requestGeneration === generation) converting = false;
		}
	}

	function begin(source: string): void {
		stopInFlight();
		const requestGeneration = ++generation;
		const controller = new AbortController();
		activeAbort = controller;
		revokePreview();
		error = '';
		converting = true;
		void convert(source, requestGeneration, controller);
	}

	function start(): void { started = true; }
	function retry(): void { retryNonce += 1; }

	$effect(() => {
		const source = src;
		const shouldStart = started;
		const retry = retryNonce;
		void retry;
		if (!shouldStart) return;
		untrack(() => begin(source));
	});

	onDestroy(() => {
		generation += 1;
		stopInFlight();
		revokePreview();
	});
</script>

<div class="dwg-adapter" class:full-bleed={fullBleed} style={`--viewer-height:${Math.max(220, height)}px`}>
	{#if !started}
		<button class="activate" type="button" onclick={start}>
			<strong>Activate DWG preview</strong>
			<span>{fileName} · Wabi converts a temporary copy to read-only DXF on your server</span>
		</button>
	{:else if previewSrc}
		<Cad2DViewer
			src={previewSrc}
			{fileName}
			{height}
			compact={!fullBleed}
			{channelId}
			sourceIdentity={src}
			allowConvertedSource
		/>
		{#if fullBleed}<span class="source-badge" title={fileName}>DWG source · LibreDWG preview</span>{/if}
	{:else}
		<div class="status" class:error={!!error} role={error ? 'alert' : 'status'}>
			{#if error}
				<strong>DWG preview unavailable</strong>
				<span>{error}</span>
				<button type="button" onclick={retry}>Retry conversion</button>
			{:else}
				<strong>Preparing DWG preview…</strong>
				<span>{converting ? 'Checking the server converter and building a temporary DXF view.' : 'Starting converter…'}</span>
			{/if}
		</div>
	{/if}
</div>

<style>
	.dwg-adapter { position:relative;min-width:0;height:var(--viewer-height);min-height:220px;background:#10191d;color:var(--text-heading,#e7efef);overflow:hidden; }
	.dwg-adapter.full-bleed { flex:1;height:auto;min-height:0;display:flex;flex-direction:column; }
	.dwg-adapter.full-bleed > :global(*) { flex:1;min-height:0; }
	.activate,.status { width:100%;height:100%;min-height:220px;border:0;background:radial-gradient(circle at 25% 20%,rgba(98,168,156,.16),transparent 45%),#10191d;color:inherit;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;padding:20px;text-align:center; }
	.activate { cursor:pointer; }.activate strong,.status strong { font-size:13px; }.activate span,.status span { color:var(--text-muted,#a9b9bc);font-size:10px;line-height:1.45;max-width:520px; }
	.status.error { color:var(--text-danger,#e5b589); }.status.error strong { color:var(--text-heading,#e7efef); }
	.status button { margin-top:4px;border:1px solid var(--border-subtle,#43535a);border-radius:6px;background:var(--surface-raised,#26343a);color:var(--text-heading,#e7efef);font:inherit;font-size:10px;padding:6px 10px;cursor:pointer; }
	.source-badge { position:absolute;right:10px;bottom:10px;z-index:12;max-width:min(360px,calc(100% - 20px));overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:5px 7px;border:1px solid rgba(130,155,160,.25);border-radius:6px;background:rgba(10,17,22,.82);color:var(--text-muted,#a9b9bc);font-size:9px;pointer-events:none; }
	button:focus-visible { outline:2px solid var(--accent-primary-color,#78c7b8);outline-offset:2px; }
</style>
