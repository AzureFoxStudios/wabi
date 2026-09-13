<script lang="ts">
	import { onMount } from 'svelte';

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
	let host = $state<HTMLDivElement>();
	let canvas = $state<HTMLCanvasElement>();
	let started = $state(!lazyLoad);
	let loading = $state(false);
	let error = $state('');
	let showGrid = $state(true);
	let wireframe = $state(false);
	let fullscreen = $state(false);
	let resetViewRuntime: (() => void) | null = null;
	let setGridRuntime: ((visible: boolean) => void) | null = null;
	let setWireframeRuntime: ((enabled: boolean) => void) | null = null;

	function start(): void {
		if (started) return;
		started = true;
	}

	function resetView(): void { resetViewRuntime?.(); }
	function toggleGrid(): void {
		showGrid = !showGrid;
		setGridRuntime?.(showGrid);
	}
	function toggleWireframe(): void {
		wireframe = !wireframe;
		setWireframeRuntime?.(wireframe);
	}
	async function toggleFullscreen(): Promise<void> {
		if (!host) return;
		try {
			if (document.fullscreenElement === host) await document.exitFullscreen();
			else await host.requestFullscreen();
		} catch {
			error = 'Fullscreen was not allowed. The model is still available in the normal viewer.';
		}
	}
	function syncFullscreen(): void { fullscreen = !!host && document.fullscreenElement === host; }

	onMount(() => {
		let disposed = false;
		let renderer: any = null;
		let scene: any = null;
		let camera: any = null;
		let controls: any = null;
		let grid: any = null;
		let root: any = null;
		let observer: ResizeObserver | null = null;
		let frame = 0;
		let THREE: any = null;

		const releaseObject = (object: any) => {
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
		};

		const fit = () => {
			if (!THREE || !root || !camera || !controls) return;
			const box = new THREE.Box3().setFromObject(root);
			if (box.isEmpty()) return;
			const size = box.getSize(new THREE.Vector3());
			const center = box.getCenter(new THREE.Vector3());
			const radius = Math.max(size.length() / 2, 0.0001);
			const aspect = Math.max(camera.aspect || 1, 0.01);
			const verticalFov = camera.fov * Math.PI / 360;
			const horizontalFov = Math.atan(Math.tan(verticalFov) * aspect);
			const distance = radius / Math.sin(Math.min(verticalFov, horizontalFov)) * 1.18;
			const direction = new THREE.Vector3(1, 0.7, 1).normalize();
			camera.position.copy(center).addScaledVector(direction, distance);
			camera.near = Math.max(distance / 2000, 1e-6);
			camera.far = Math.max(distance * 100, 10);
			camera.updateProjectionMatrix();
			controls.target.copy(center);
			controls.minDistance = Math.max(distance / 1000, 1e-6);
			controls.maxDistance = distance * 40;
			controls.update();
			if (grid) grid.position.y = box.min.y;
		};

		const resize = () => {
			if (!host || !renderer || !camera) return;
			const width = Math.max(host.clientWidth, 1);
			const nextHeight = Math.max(host.clientHeight, 1);
			camera.aspect = width / nextHeight;
			camera.updateProjectionMatrix();
			renderer.setSize(width, nextHeight, false);
		};

		const boot = async () => {
			if (!started || disposed || loading || root) return;
			loading = true;
			error = '';
			try {
				const loadModule = async (url: string): Promise<any> => import(/* @vite-ignore */ url);
				THREE = await loadModule(THREE_BASE);
				const [{ OrbitControls }, { ThreeMFLoader }] = await Promise.all([
					loadModule(`${THREE_BASE}/examples/jsm/controls/OrbitControls`),
					loadModule(`${THREE_BASE}/examples/jsm/loaders/3MFLoader`)
				]);
				if (disposed) return;

				scene = new THREE.Scene();
				scene.background = new THREE.Color(0x0f1218);
				camera = new THREE.PerspectiveCamera(55, 1, 0.01, 2000);
				renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
				renderer.outputColorSpace = THREE.SRGBColorSpace;
				renderer.toneMapping = THREE.ACESFilmicToneMapping;
				renderer.toneMappingExposure = 1;
				renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

				const hemi = new THREE.HemisphereLight(0xffffff, 0x263238, 1.25);
				const key = new THREE.DirectionalLight(0xffffff, 1.15);
				key.position.set(4, 6, 3);
				scene.add(hemi, key);

				grid = new THREE.GridHelper(20, 20, 0x46525d, 0x252d35);
				grid.visible = showGrid;
				scene.add(grid);

				controls = new OrbitControls(camera, renderer.domElement);
				controls.enableDamping = true;
				controls.dampingFactor = 0.07;
				controls.screenSpacePanning = true;

				const loader = new ThreeMFLoader();
				root = await loader.loadAsync(src);
				if (disposed) { releaseObject(root); return; }
				root.name ||= fileName;
				scene.add(root);
				root.updateMatrixWorld(true);

				const applyWireframe = (enabled: boolean) => {
					root?.traverse?.((child: any) => {
						if (!child?.isMesh) return;
						const materials = Array.isArray(child.material) ? child.material : [child.material];
						for (const material of materials) {
							if (material && 'wireframe' in material) {
								material.wireframe = enabled;
								material.needsUpdate = true;
							}
						}
					});
				};
				setWireframeRuntime = applyWireframe;
				applyWireframe(wireframe);
				setGridRuntime = (visible) => { if (grid) grid.visible = visible; };
				resetViewRuntime = fit;

				resize();
				fit();
				observer = new ResizeObserver(resize);
				observer.observe(host);

				const render = () => {
					if (disposed) return;
					controls?.update?.();
					renderer?.render?.(scene, camera);
					frame = requestAnimationFrame(render);
				};
				render();
			} catch (reason) {
				if (!disposed) error = reason instanceof Error ? reason.message : 'Could not open this 3MF model.';
			} finally {
				if (!disposed) loading = false;
			}
		};

		const interval = window.setInterval(() => {
			if (started && !root && !loading && !error) void boot();
		}, 80);
		if (started) void boot();
		document.addEventListener('fullscreenchange', syncFullscreen);

		return () => {
			disposed = true;
			window.clearInterval(interval);
			document.removeEventListener('fullscreenchange', syncFullscreen);
			observer?.disconnect();
			if (frame) cancelAnimationFrame(frame);
			controls?.dispose?.();
			releaseObject(root);
			grid?.geometry?.dispose?.();
			grid?.material?.dispose?.();
			renderer?.dispose?.();
			resetViewRuntime = null;
			setGridRuntime = null;
			setWireframeRuntime = null;
		};
	});
</script>

<div bind:this={host} class="three-mf-viewer" class:full-bleed={fullBleed} style={`--viewer-height:${Math.max(220, height)}px`}>
	{#if !started}
		<button class="activate" type="button" onclick={start}>
			<strong>Activate 3MF preview</strong>
			<span>{fileName} · parsed locally in this browser</span>
		</button>
	{:else}
		<canvas bind:this={canvas} tabindex="0" aria-label={`3D manufacturing model ${fileName}`}></canvas>
		{#if !hideUi}
			<div class="toolbar" aria-label="3MF viewer tools">
				<button type="button" onclick={resetView}>Fit</button>
				<button type="button" class:active={wireframe} aria-pressed={wireframe} onclick={toggleWireframe}>Wireframe</button>
				<button type="button" class:active={showGrid} aria-pressed={showGrid} onclick={toggleGrid}>Grid</button>
				<button type="button" onclick={toggleFullscreen}>{fullscreen ? 'Exit full' : 'Fullscreen'}</button>
				<button type="button" onclick={() => (hideUi = true)}>Hide UI</button>
			</div>
		{:else}
			<button class="show-ui" type="button" onclick={() => (hideUi = false)}>Show UI</button>
		{/if}
		{#if loading}<div class="status">Reading 3MF…</div>{/if}
		{#if error}<div class="status error" role="alert"><strong>3MF preview unavailable</strong><span>{error}</span></div>{/if}
	{/if}
</div>

<style>
	.three-mf-viewer { position:relative;min-width:0;height:var(--viewer-height);min-height:220px;background:#0f1218;overflow:hidden;color:var(--text-heading,#e7efef); }
	.three-mf-viewer.full-bleed { flex:1;height:auto;min-height:0; }
	canvas { width:100%;height:100%;display:block;touch-action:none;outline:none; }
	.toolbar { position:absolute;left:10px;top:10px;display:flex;gap:6px;flex-wrap:wrap;z-index:3;padding:6px;border:1px solid rgba(130,155,160,.25);border-radius:9px;background:rgba(10,17,22,.82);backdrop-filter:blur(8px); }
	.toolbar button,.show-ui { border:1px solid var(--border-subtle,#43535a);border-radius:6px;background:var(--surface-raised,#26343a);color:inherit;font:inherit;font-size:10px;padding:6px 9px;cursor:pointer; }
	.toolbar button.active { border-color:var(--accent-primary-color,#8fd5c4);background:color-mix(in srgb,var(--accent-primary-color,#8fd5c4) 18%,var(--surface-raised,#26343a)); }
	.show-ui { position:absolute;right:10px;top:10px;z-index:4; }
	.activate { width:100%;height:100%;border:0;background:radial-gradient(circle at 25% 20%,rgba(98,168,156,.16),transparent 45%),#10191d;color:inherit;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;cursor:pointer;padding:20px; }
	.activate strong { font-size:13px; }.activate span { font-size:10px;color:var(--text-muted,#a9b9bc); }
	.status { position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:7px;flex-direction:column;background:rgba(15,18,24,.76);color:var(--text-muted,#a9b9bc);font-size:12px;padding:18px;text-align:center;z-index:2;pointer-events:none; }
	.status.error { color:var(--text-danger,#e5b589);pointer-events:auto; }.status.error strong { color:var(--text-heading,#e7efef); }
	:is(button,canvas):focus-visible { outline:2px solid var(--accent-primary-color,#78c7b8);outline-offset:2px; }
</style>
