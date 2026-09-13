<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import ModelViewer3D from './ModelViewer3D.svelte';

	let {
		src,
		fileName = 'Model.step',
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
	const MAX_SOURCE_BYTES = 60 * 1024 * 1024;
	const IMPORT_TIMEOUT_MS = 90_000;

	type CadFormat = 'step' | 'iges';
	type ColorTuple = [number, number, number] | null;
	interface WorkerFace { first: number; last: number; color: ColorTuple }
	interface WorkerMesh {
		name: string;
		color: ColorTuple;
		faces: WorkerFace[];
		position: ArrayBuffer;
		normal: ArrayBuffer | null;
		index: ArrayBuffer;
	}
	interface WorkerNode { name: string; meshes: number[]; children: WorkerNode[] }
	interface WorkerResult {
		id: string;
		ok: boolean;
		error?: string;
		root?: WorkerNode;
		meshes?: WorkerMesh[];
	}

	let started = $state(false);
	let converting = $state(false);
	let previewSrc = $state('');
	let error = $state('');
	let retryNonce = $state(0);
	let generation = 0;
	let activeAbort: AbortController | null = null;
	let activeWorker: Worker | null = null;

	const sourceFormat = $derived.by<CadFormat>(() => /\.(iges|igs)(?:$|[?#])/i.test(fileName) ? 'iges' : 'step');
	const sourceLabel = $derived(sourceFormat === 'iges' ? 'IGES' : 'STEP');
	const previewFileName = $derived(`${fileName.replace(/\.(step|stp|iges|igs)$/i, '') || `${sourceLabel} model`}.glb`);

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
		activeWorker?.terminate();
		activeWorker = null;
	}

	function releaseObject(root: any): void {
		const geometries = new Set<any>();
		const materials = new Set<any>();
		root?.traverse?.((child: any) => {
			if (child?.geometry) geometries.add(child.geometry);
			const list = Array.isArray(child?.material) ? child.material : [child?.material];
			for (const material of list) if (material) materials.add(material);
		});
		for (const geometry of geometries) geometry.dispose?.();
		for (const material of materials) material.dispose?.();
	}

	async function fetchSource(source: string, signal: AbortSignal): Promise<ArrayBuffer> {
		const response = await fetch(source, { signal });
		if (!response.ok) throw new Error(`Could not load ${sourceLabel} (${response.status}).`);
		const declared = Number(response.headers.get('content-length') || 0);
		if (declared > MAX_SOURCE_BYTES) throw new Error(`${sourceLabel} is larger than Wabi's 60 MB browser import limit.`);
		const buffer = await response.arrayBuffer();
		if (buffer.byteLength > MAX_SOURCE_BYTES) throw new Error(`${sourceLabel} is larger than Wabi's 60 MB browser import limit.`);
		if (buffer.byteLength === 0) throw new Error(`${sourceLabel} file is empty.`);
		return buffer;
	}

	async function parseCad(buffer: ArrayBuffer, format: CadFormat, requestGeneration: number): Promise<WorkerResult> {
		const worker = new Worker(new URL('../../cad/occtCad.worker.ts', import.meta.url), { type: 'module' });
		activeWorker?.terminate();
		activeWorker = worker;
		const id = `${requestGeneration}-${Math.random().toString(36).slice(2)}`;
		return await new Promise<WorkerResult>((resolve, reject) => {
			let settled = false;
			const finish = (reason: Error | null, result?: WorkerResult) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				worker.terminate();
				if (activeWorker === worker) activeWorker = null;
				if (reason) reject(reason); else resolve(result as WorkerResult);
			};
			const timer = window.setTimeout(() => finish(new Error(`${sourceLabel} import timed out after 90 seconds.`)), IMPORT_TIMEOUT_MS);
			worker.addEventListener('message', (event: MessageEvent<WorkerResult>) => {
				if (event.data?.id !== id) return;
				finish(null, event.data);
			});
			worker.addEventListener('error', (event: ErrorEvent) => finish(new Error(event.message || 'OpenCascade worker failed.')), { once: true });
			worker.postMessage({ id, format, buffer }, [buffer]);
		});
	}

	function normalizedColor(value: ColorTuple, fallback: [number, number, number]): [number, number, number] {
		if (!value) return fallback;
		const scale = value.some((channel) => channel > 1) ? 255 : 1;
		return value.map((channel) => Math.max(0, Math.min(1, channel / scale))) as [number, number, number];
	}

	function buildScene(result: WorkerResult, THREE: any): any {
		const sourceMeshes = Array.isArray(result.meshes) ? result.meshes : [];
		if (sourceMeshes.length === 0) throw new Error(`OpenCascade imported ${sourceLabel}, but no renderable meshes were found.`);

		const built = sourceMeshes.map((sourceMesh, meshIndex) => {
			const positions = new Float32Array(sourceMesh.position);
			const indices = new Uint32Array(sourceMesh.index);
			if (positions.length < 3 || positions.length % 3 !== 0 || indices.length < 3 || indices.length % 3 !== 0) {
				throw new Error(`Imported CAD mesh ${meshIndex + 1} has invalid geometry.`);
			}
			const geometry = new THREE.BufferGeometry();
			geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
			if (sourceMesh.normal) {
				const normals = new Float32Array(sourceMesh.normal);
				if (normals.length === positions.length) geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
			}
			if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
			geometry.setIndex(new THREE.BufferAttribute(indices, 1));

			const materials: any[] = [];
			const materialByColor = new Map<string, number>();
			const addMaterial = (raw: ColorTuple, fallback: [number, number, number]) => {
				const rgb = normalizedColor(raw, fallback);
				const key = rgb.map((value) => value.toFixed(5)).join(':');
				const known = materialByColor.get(key);
				if (known !== undefined) return known;
				const material = new THREE.MeshStandardMaterial({
					color: new THREE.Color(rgb[0], rgb[1], rgb[2]),
					metalness: 0.05,
					roughness: 0.72,
					side: THREE.DoubleSide
				});
				const index = materials.push(material) - 1;
				materialByColor.set(key, index);
				return index;
			};

			const defaultColor: [number, number, number] = [0.78, 0.83, 0.84];
			const baseMaterial = addMaterial(sourceMesh.color, defaultColor);
			const triangleCount = Math.floor(indices.length / 3);
			const faces = (sourceMesh.faces || [])
				.map((face) => ({ first: Math.max(0, Math.floor(face.first)), last: Math.min(triangleCount - 1, Math.floor(face.last)), color: face.color }))
				.filter((face) => face.first <= face.last && face.first < triangleCount)
				.sort((a, b) => a.first - b.first || a.last - b.last);

			geometry.clearGroups();
			let cursor = 0;
			for (const face of faces) {
				const first = Math.max(cursor, face.first);
				if (first > face.last) continue;
				if (first > cursor) geometry.addGroup(cursor * 3, (first - cursor) * 3, baseMaterial);
				const faceMaterial = face.color ? addMaterial(face.color, normalizedColor(sourceMesh.color, defaultColor)) : baseMaterial;
				geometry.addGroup(first * 3, (face.last - first + 1) * 3, faceMaterial);
				cursor = face.last + 1;
			}
			if (cursor < triangleCount) geometry.addGroup(cursor * 3, (triangleCount - cursor) * 3, baseMaterial);
			if (geometry.groups.length === 0) geometry.addGroup(0, indices.length, baseMaterial);

			const mesh = new THREE.Mesh(geometry, materials.length === 1 ? materials[0] : materials);
			mesh.name = sourceMesh.name || `CAD mesh ${meshIndex + 1}`;
			return mesh;
		});

		const used = new Set<number>();
		const makeNode = (node: WorkerNode | undefined): any => {
			const group = new THREE.Group();
			group.name = node?.name || '';
			for (const index of node?.meshes || []) {
				if (!Number.isInteger(index) || index < 0 || index >= built.length || used.has(index)) continue;
				used.add(index);
				group.add(built[index]);
			}
			for (const child of node?.children || []) group.add(makeNode(child));
			return group;
		};

		const root = makeNode(result.root);
		root.name ||= fileName;
		for (let index = 0; index < built.length; index += 1) {
			if (!used.has(index)) root.add(built[index]);
		}
		root.updateMatrixWorld(true);
		return root;
	}

	async function convert(source: string, sourceName: string, format: CadFormat, requestGeneration: number, controller: AbortController): Promise<void> {
		let root: any = null;
		try {
			const buffer = await fetchSource(source, controller.signal);
			if (requestGeneration !== generation || controller.signal.aborted) return;
			const parsed = await parseCad(buffer, format, requestGeneration);
			if (requestGeneration !== generation || controller.signal.aborted) return;
			if (!parsed.ok) throw new Error(parsed.error || `OpenCascade could not import this ${sourceLabel} file.`);

			const loadModule = async (url: string): Promise<any> => import(/* @vite-ignore */ url);
			const [THREE, { GLTFExporter }] = await Promise.all([
				loadModule(THREE_BASE),
				loadModule(`${THREE_BASE}/examples/jsm/exporters/GLTFExporter`)
			]);
			if (requestGeneration !== generation || controller.signal.aborted) return;
			root = buildScene(parsed, THREE);
			root.name ||= sourceName;

			const exporter = new GLTFExporter();
			const exported = await exporter.parseAsync(root, { binary: true, onlyVisible: true, trs: false });
			if (requestGeneration !== generation || controller.signal.aborted) return;
			if (!(exported instanceof ArrayBuffer)) throw new Error(`${sourceLabel} import did not produce a binary glTF preview.`);
			revokePreview();
			previewSrc = URL.createObjectURL(new Blob([exported], { type: 'model/gltf-binary' }));
		} catch (reason) {
			if (requestGeneration === generation && !controller.signal.aborted) {
				error = reason instanceof Error ? reason.message : `Could not import this ${sourceLabel} model.`;
			}
		} finally {
			releaseObject(root);
			if (requestGeneration === generation) converting = false;
		}
	}

	function begin(source: string, sourceName: string, format: CadFormat): void {
		stopInFlight();
		const requestGeneration = ++generation;
		const controller = new AbortController();
		activeAbort = controller;
		revokePreview();
		error = '';
		converting = true;
		void convert(source, sourceName, format, requestGeneration, controller);
	}

	function start(): void { started = true; }
	function retry(): void { retryNonce += 1; }

	$effect(() => {
		const source = src;
		const sourceName = fileName;
		const format = sourceFormat;
		const shouldStart = started;
		const retry = retryNonce;
		void retry;
		if (!shouldStart) return;
		untrack(() => begin(source, sourceName, format));
	});

	onDestroy(() => {
		generation += 1;
		stopInFlight();
		revokePreview();
	});
</script>

<div class="occt-adapter" class:full-bleed={fullBleed} style={`--viewer-height:${Math.max(220, height)}px`}>
	{#if !started}
		<button class="activate" type="button" onclick={start}>
			<strong>Activate {sourceLabel} preview</strong>
			<span>{fileName} · OpenCascade runs in a worker, then Wabi opens the result in its normal 3D workspace</span>
		</button>
	{:else if previewSrc}
		<ModelViewer3D src={previewSrc} fileName={previewFileName} {height} {fullBleed} lazyLoad={false} bind:hideUi onRetry={retry} />
		{#if !hideUi}<span class="source-badge" title={fileName}>{sourceLabel} source · OpenCascade WASM</span>{/if}
	{:else}
		<div class="status" class:error={!!error} role={error ? 'alert' : 'status'}>
			{#if error}
				<strong>{sourceLabel} preview unavailable</strong>
				<span>{error}</span>
				<button type="button" onclick={retry}>Retry import</button>
			{:else}
				<strong>Preparing {sourceLabel} preview…</strong>
				<span>{converting ? 'OpenCascade is tessellating CAD geometry off the UI thread.' : 'Starting importer…'}</span>
			{/if}
		</div>
	{/if}
</div>

<style>
	.occt-adapter { position:relative;min-width:0;height:var(--viewer-height);min-height:220px;background:#0f1218;color:var(--text-heading,#e7efef);overflow:hidden; }
	.occt-adapter.full-bleed { flex:1;height:auto;min-height:0;display:flex;flex-direction:column; }
	.occt-adapter.full-bleed > :global(*) { flex:1;min-height:0; }
	.activate,.status { width:100%;height:100%;min-height:220px;border:0;background:radial-gradient(circle at 25% 20%,rgba(98,168,156,.16),transparent 45%),#10191d;color:inherit;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;padding:20px;text-align:center; }
	.activate { cursor:pointer; }.activate strong,.status strong { font-size:13px; }.activate span,.status span { color:var(--text-muted,#a9b9bc);font-size:10px;line-height:1.45;max-width:520px; }
	.status.error { color:var(--text-danger,#e5b589); }.status.error strong { color:var(--text-heading,#e7efef); }
	.status button { margin-top:4px;border:1px solid var(--border-subtle,#43535a);border-radius:6px;background:var(--surface-raised,#26343a);color:var(--text-heading,#e7efef);font:inherit;font-size:10px;padding:6px 10px;cursor:pointer; }
	.source-badge { position:absolute;right:10px;bottom:10px;z-index:5;max-width:min(360px,calc(100% - 20px));overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:5px 7px;border:1px solid rgba(130,155,160,.25);border-radius:6px;background:rgba(10,17,22,.82);color:var(--text-muted,#a9b9bc);font-size:9px;pointer-events:none; }
	button:focus-visible { outline:2px solid var(--accent-primary-color,#78c7b8);outline-offset:2px; }
</style>
