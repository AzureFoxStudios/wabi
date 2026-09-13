<script lang="ts">
	import { onDestroy } from 'svelte';
	import ModelViewer3D from './ModelViewer3D.svelte';

	let {
		src,
		fileName = 'Model.3mf',
		height = 320,
		fullBleed = false,
		lazyLoad = true,
		hideUi = $bindable(false)
	}: {
		src: string;
		fileName?: string;
		height?: number;
		fullBleed?: boolean;
		lazyLoad?: boolean;
		hideUi?: boolean;
	} = $props();

	const THREE_BASE = 'https://esm.sh/three@0.181.1';
	let started = $state(!lazyLoad);
	let converting = $state(false);
	let previewSrc = $state('');
	let error = $state('');
	let retryNonce = $state(0);
	let generation = 0;
	const previewFileName = $derived(`${fileName.replace(/\.3mf$/i, '') || '3MF model'}.glb`);

	function releaseObject(object: any): void {
		object?.traverse?.((child: any) => {
			child.geometry?.dispose?.();
			const materials = Array.isArray(child.material) ? child.material : [child.material];
			for (const material of materials) {
				if (!material) continue;
				for (const value of Object.values(material)) {
					if (value && typeof value === 'object' && (value as any).isTexture) (value as any).dispose?.();
				}
				material.dispose?.();
			}
		});
	}

	function revokePreview(): void {
		if (!previewSrc) return;
		URL.revokeObjectURL(previewSrc);
		previewSrc = '';
	}

	async function convert3mf(source: string, sourceName: string, requestGeneration: number): Promise<void> {
		let root: any = null;
		try {
			const loadModule = async (url: string): Promise<any> => import(/* @vite-ignore */ url);
			const [{ ThreeMFLoader }, { GLTFExporter }] = await Promise.all([
				loadModule(`${THREE_BASE}/examples/jsm/loaders/3MFLoader`),
				loadModule(`${THREE_BASE}/examples/jsm/exporters/GLTFExporter`)
			]);
			if (requestGeneration !== generation) return;

			const loader = new ThreeMFLoader();
			root = await loader.loadAsync(source);
			if (requestGeneration !== generation) return;
			root.name ||= sourceName;
			root.updateMatrixWorld?.(true);

			const exporter = new GLTFExporter();
			const result = await exporter.parseAsync(root, {
				binary: true,
				onlyVisible: true,
				trs: false
			});
			if (requestGeneration !== generation) return;
			if (!(result instanceof ArrayBuffer)) throw new Error('3MF conversion did not produce a binary glTF preview.');

			previewSrc = URL.createObjectURL(new Blob([result], { type: 'model/gltf-binary' }));
		} catch (reason) {
			if (requestGeneration === generation) {
				error = reason instanceof Error ? reason.message : 'Could not import this 3MF model.';
			}
		} finally {
			releaseObject(root);
			if (requestGeneration === generation) converting = false;
		}
	}

	function start(): void {
		started = true;
	}

	function retry(): void {
		retryNonce += 1;
	}

	$effect(() => {
		const source = src;
		const sourceName = fileName;
		const shouldStart = started;
		const retry = retryNonce;
		void retry;
		if (!shouldStart) return;

		const requestGeneration = ++generation;
		revokePreview();
		error = '';
		converting = true;
		void convert3mf(source, sourceName, requestGeneration);

		return () => {
			if (generation === requestGeneration) generation += 1;
		};
	});

	onDestroy(() => {
		generation += 1;
		revokePreview();
	});
</script>

<div class="three-mf-adapter" class:full-bleed={fullBleed} style={`--viewer-height:${Math.max(220, height)}px`}>
	{#if !started}
		<button class="activate" type="button" onclick={start}>
			<strong>Activate 3MF preview</strong>
			<span>{fileName} · imported locally, then opened in Wabi's normal 3D workspace</span>
		</button>
	{:else if previewSrc}
		<ModelViewer3D src={previewSrc} fileName={previewFileName} {height} {fullBleed} lazyLoad={false} bind:hideUi onRetry={retry} />
		{#if !hideUi}<span class="source-badge" title={fileName}>3MF source · {fileName}</span>{/if}
	{:else}
		<div class="status" class:error={!!error} role={error ? 'alert' : 'status'}>
			{#if error}
				<strong>3MF preview unavailable</strong>
				<span>{error}</span>
				<button type="button" onclick={retry}>Retry import</button>
			{:else}
				<strong>Preparing 3MF preview…</strong>
				<span>{converting ? 'Reading manufacturing geometry and building the GLB view.' : 'Starting importer…'}</span>
			{/if}
		</div>
	{/if}
</div>

<style>
	.three-mf-adapter { position:relative;min-width:0;height:var(--viewer-height);min-height:220px;background:#0f1218;color:var(--text-heading,#e7efef);overflow:hidden; }
	.three-mf-adapter.full-bleed { flex:1;height:auto;min-height:0;display:flex;flex-direction:column; }
	.three-mf-adapter.full-bleed > :global(*) { flex:1;min-height:0; }
	.activate,.status { width:100%;height:100%;min-height:220px;border:0;background:radial-gradient(circle at 25% 20%,rgba(98,168,156,.16),transparent 45%),#10191d;color:inherit;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;padding:20px;text-align:center; }
	.activate { cursor:pointer; }.activate strong,.status strong { font-size:13px; }.activate span,.status span { color:var(--text-muted,#a9b9bc);font-size:10px;line-height:1.45; }
	.status.error { color:var(--text-danger,#e5b589); }.status.error strong { color:var(--text-heading,#e7efef); }
	.status button { margin-top:4px;border:1px solid var(--border-subtle,#43535a);border-radius:6px;background:var(--surface-raised,#26343a);color:var(--text-heading,#e7efef);font:inherit;font-size:10px;padding:6px 10px;cursor:pointer; }
	.source-badge { position:absolute;right:10px;bottom:10px;z-index:5;max-width:min(360px,calc(100% - 20px));overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:5px 7px;border:1px solid rgba(130,155,160,.25);border-radius:6px;background:rgba(10,17,22,.82);color:var(--text-muted,#a9b9bc);font-size:9px;pointer-events:none; }
	button:focus-visible { outline:2px solid var(--accent-primary-color,#78c7b8);outline-offset:2px; }
</style>
