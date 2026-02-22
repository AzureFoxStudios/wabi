<script lang="ts">
  import { onMount } from 'svelte';

  export let src: string;
  export let fileName = '3D model';
  export let height = 320;
  export let fullBleed = false;
  type ThreadMode = 'auto' | 'always' | 'off';
  type RenderMode = 'normal' | 'wireframe';
  const THREAD_MODE_KEY = 'wabi:model-viewer-thread-mode';
  const AUTO_WORKER_THRESHOLD_BYTES = 8 * 1024 * 1024;

  let host: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let viewerHintEl: HTMLDivElement | undefined;
  let threadingNoteEl: HTMLDivElement | undefined;
  let error: string | null = null;
  let disposed = false;
  let threadMode: ThreadMode = 'auto';
  let renderMode: RenderMode = 'normal';
  let showGrid = true;
  let showAxes = false;
  let autoRotate = false;
  let threadingNotice = '';
  const THREE_BASE = 'https://esm.sh/three@0.181.1';
  let applyRenderModeRuntime: ((mode: RenderMode) => void) | null = null;
  let toggleGridRuntime: ((visible: boolean) => void) | null = null;
  let toggleAxesRuntime: ((visible: boolean) => void) | null = null;
  let setAutoRotateRuntime: ((enabled: boolean) => void) | null = null;
  let resetViewRuntime: (() => void) | null = null;

  function getThreadMode(): ThreadMode {
    const raw = localStorage.getItem(THREAD_MODE_KEY);
    // Backwards compatibility with legacy "single" key value.
    if (raw === 'single') return 'off';
    if (raw === 'always' || raw === 'off' || raw === 'auto') return raw;
    return 'auto';
  }

  function persistThreadMode(mode: ThreadMode): void {
    localStorage.setItem(THREAD_MODE_KEY, mode);
  }

  async function getRemoteFileSize(url: string): Promise<number | null> {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      const rawLength = response.headers.get('content-length');
      if (!rawLength) return null;
      const parsed = Number.parseInt(rawLength, 10);
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function workerSupportedForExt(ext: string): boolean {
    return ext === 'stl';
  }

  async function shouldUseWorker(ext: string): Promise<boolean> {
    if (!workerSupportedForExt(ext)) return false;
    if (threadMode === 'off') return false;
    if (threadMode === 'always') return true;

    // Auto mode: main thread for smaller models, worker for larger models.
    const sizeBytes = await getRemoteFileSize(src);
    if (sizeBytes === null) {
      threadingNotice = 'Auto mode could not determine file size. Using main-thread path.';
      return false;
    }

    if (sizeBytes >= AUTO_WORKER_THRESHOLD_BYTES) {
      threadingNotice = `Auto selected worker mode (${(sizeBytes / (1024 * 1024)).toFixed(1)} MB).`;
      return true;
    }

    threadingNotice = `Auto selected main-thread mode (${(sizeBytes / (1024 * 1024)).toFixed(1)} MB).`;
    return false;
  }

  function handleThreadModeChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as ThreadMode;
    threadMode = value;
    persistThreadMode(value);
  }

  function setRenderMode(mode: RenderMode): void {
    renderMode = mode;
    applyRenderModeRuntime?.(mode);
  }

  function toggleGrid(): void {
    showGrid = !showGrid;
    toggleGridRuntime?.(showGrid);
  }

  function toggleAxes(): void {
    showAxes = !showAxes;
    toggleAxesRuntime?.(showAxes);
  }

  function toggleAutoRotate(): void {
    autoRotate = !autoRotate;
    setAutoRotateRuntime?.(autoRotate);
  }

  function resetView(): void {
    resetViewRuntime?.();
  }

  onMount(() => {
    threadMode = getThreadMode();
    let renderer: any;
    let scene: any;
    let camera: any;
    let controls: any;
    let grid: any;
    let axes: any;
    let loadedRoot: any = null;
    let fitCameraToObjectRef: ((object: any, THREE: any) => void) | null = null;
    let frameHandle = 0;
    let worker: Worker | null = null;
    const meshes: any[] = [];

    const dispose = () => {
      disposed = true;
      if (frameHandle) cancelAnimationFrame(frameHandle);
      controls?.dispose?.();
      for (const mesh of meshes) {
        mesh.geometry?.dispose?.();
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((m: any) => m?.dispose?.());
        } else {
          mesh.material?.dispose?.();
        }
      }
      renderer?.dispose?.();
      worker?.terminate?.();
      applyRenderModeRuntime = null;
      toggleGridRuntime = null;
      toggleAxesRuntime = null;
      setAutoRotateRuntime = null;
      resetViewRuntime = null;
    };

    const fitCameraToObject = (object: any, THREE: any) => {
      const box = new THREE.Box3().setFromObject(object);
      if (box.isEmpty()) return;
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxSize = Math.max(size.x, size.y, size.z);
      const distance = maxSize * 1.6 || 2;

      camera.position.set(center.x + distance, center.y + distance * 0.45, center.z + distance);
      camera.near = Math.max(distance / 100, 0.01);
      camera.far = Math.max(distance * 100, 1000);
      camera.updateProjectionMatrix();

      controls.target.copy(center);
      controls.update();
    };

    const start = async () => {
      try {
        const loadModule = async (url: string): Promise<any> => import(/* @vite-ignore */ url);

        const THREE = await loadModule(THREE_BASE);
        const { OrbitControls } = await loadModule(`${THREE_BASE}/examples/jsm/controls/OrbitControls`);

        if (disposed) return;

        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x0f1218);

        camera = new THREE.PerspectiveCamera(55, 1, 0.01, 2000);
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

        const hemi = new THREE.HemisphereLight(0xffffff, 0x263238, 1.2);
        const key = new THREE.DirectionalLight(0xffffff, 1.1);
        key.position.set(3, 5, 2);
        scene.add(hemi, key);

        grid = new THREE.GridHelper(20, 20, 0x364150, 0x202833);
        grid.position.y = -0.01;
        grid.visible = showGrid;
        scene.add(grid);

        axes = new THREE.AxesHelper(3);
        axes.visible = showAxes;
        scene.add(axes);

        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.07;
        controls.minDistance = 0.1;
        controls.maxDistance = 200;
        controls.autoRotate = autoRotate;
        controls.autoRotateSpeed = 1.0;

        const ext = (fileName.split('.').pop() || '').toLowerCase();
        threadingNotice = '';
        const addLoadedObject = (object: any) => {
          loadedRoot = object;
          scene.add(object);
          object.traverse?.((child: any) => {
            if (child?.isMesh) meshes.push(child);
          });
          fitCameraToObject(object, THREE);
        };
        fitCameraToObjectRef = fitCameraToObject;

        applyRenderModeRuntime = (mode: RenderMode) => {
          for (const mesh of meshes) {
            const material = mesh.material;
            if (Array.isArray(material)) {
              for (const mat of material) {
                if (mat && 'wireframe' in mat) mat.wireframe = mode === 'wireframe';
              }
            } else if (material && 'wireframe' in material) {
              material.wireframe = mode === 'wireframe';
            }
          }
        };
        toggleGridRuntime = (visible: boolean) => {
          if (grid) grid.visible = visible;
        };
        toggleAxesRuntime = (visible: boolean) => {
          if (axes) axes.visible = visible;
        };
        setAutoRotateRuntime = (enabled: boolean) => {
          if (controls) controls.autoRotate = enabled;
        };
        resetViewRuntime = () => {
          if (loadedRoot && fitCameraToObjectRef) {
            fitCameraToObjectRef(loadedRoot, THREE);
          }
        };

        if (ext === 'glb' || ext === 'gltf') {
          if (threadMode === 'always') {
            threadingNotice = 'Worker parse not available for this format. Falling back to main-thread.';
          }
          const { GLTFLoader } = await loadModule(`${THREE_BASE}/examples/jsm/loaders/GLTFLoader`);
          const loader = new GLTFLoader();
          const gltf = await loader.loadAsync(src);
          if (disposed) return;
          addLoadedObject(gltf.scene);
        } else if (ext === 'obj') {
          if (threadMode === 'always') {
            threadingNotice = 'Worker parse not available for this format. Falling back to main-thread.';
          }
          const { OBJLoader } = await loadModule(`${THREE_BASE}/examples/jsm/loaders/OBJLoader`);
          const loader = new OBJLoader();
          const obj = await loader.loadAsync(src);
          if (disposed) return;
          addLoadedObject(obj);
        } else if (ext === 'stl') {
          const useWorker = await shouldUseWorker(ext);
          if (useWorker) {
            worker = new Worker(new URL('./model-loader.worker.ts', import.meta.url), { type: 'module' });
            const workerResult = await new Promise<any>((resolve, reject) => {
              worker?.addEventListener('message', (ev: MessageEvent<any>) => resolve(ev.data), { once: true });
              worker?.addEventListener('error', (ev: ErrorEvent) => reject(new Error(ev.message)), { once: true });
              worker?.postMessage({ type: 'parse-stl', src });
            });

            if (!workerResult?.ok) {
              throw new Error(workerResult?.error || 'Worker STL parse failed');
            }
            if (threadMode === 'always') {
              threadingNotice = 'Worker mode enabled.';
            }

            const geometry = new THREE.BufferGeometry();
            const position = new Float32Array(workerResult.position);
            geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
            if (workerResult.normal) {
              const normal = new Float32Array(workerResult.normal);
              geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
            } else {
              geometry.computeVertexNormals();
            }
            if (workerResult.index) {
              geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(workerResult.index), 1));
            }

            const material = new THREE.MeshStandardMaterial({ color: 0x9ad1ff, metalness: 0.1, roughness: 0.65 });
            const mesh = new THREE.Mesh(geometry, material);
            meshes.push(mesh);
            scene.add(mesh);
            fitCameraToObject(mesh, THREE);
          } else {
            const { STLLoader } = await loadModule(`${THREE_BASE}/examples/jsm/loaders/STLLoader`);
            const loader = new STLLoader();
            const geometry = await loader.loadAsync(src);
            if (disposed) return;
            const material = new THREE.MeshStandardMaterial({ color: 0x9ad1ff, metalness: 0.1, roughness: 0.65 });
            const mesh = new THREE.Mesh(geometry, material);
            meshes.push(mesh);
            scene.add(mesh);
            fitCameraToObject(mesh, THREE);
          }
        } else {
          error = `Unsupported model format: .${ext || 'unknown'}`;
          return;
        }
        applyRenderModeRuntime?.(renderMode);

        const resize = () => {
          if (!host || !renderer || !camera) return;
          const width = Math.max(host.clientWidth, 1);
          const hintHeight = viewerHintEl?.offsetHeight ?? 0;
          const noteHeight = threadingNoteEl?.offsetHeight ?? 0;
          const nextHeight = fullBleed
            ? Math.max(host.clientHeight - hintHeight - noteHeight, 180)
            : Math.max(height, 180);
          renderer.setSize(width, nextHeight, false);
          camera.aspect = width / nextHeight;
          camera.updateProjectionMatrix();
        };

        const animate = () => {
          if (disposed) return;
          frameHandle = requestAnimationFrame(animate);
          controls?.update?.();
          renderer?.render?.(scene, camera);
        };

        const resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(host);
        resize();
        animate();

        return () => resizeObserver.disconnect();
      } catch (e) {
        error = e instanceof Error ? e.message : 'Failed to initialize 3D viewer';
      }
    };

    let stopResizeWatch: (() => void) | undefined;
    start().then((cleanup) => {
      if (typeof cleanup === 'function') stopResizeWatch = cleanup;
    });

    return () => {
      stopResizeWatch?.();
      dispose();
    };
  });
</script>

<div class="model-viewer" class:full-bleed={fullBleed} bind:this={host}>
  {#if error}
    <div class="model-error">{error}</div>
  {:else}
    <canvas bind:this={canvas} aria-label={`3D model viewer for ${fileName}`}></canvas>
    <div class="viewer-hint" bind:this={viewerHintEl}>
      <div class="viewer-controls-row">
        <span>Drag to rotate, wheel to zoom, right-drag to pan</span>
      </div>
      <div class="viewer-controls-row">
        <div class="view-mode-controls">
          <button
            type="button"
            class="view-btn"
            class:active={renderMode === 'normal'}
            on:click={() => setRenderMode('normal')}
          >
            Normal
          </button>
          <button
            type="button"
            class="view-btn"
            class:active={renderMode === 'wireframe'}
            on:click={() => setRenderMode('wireframe')}
          >
            Wireframe
          </button>
          <button type="button" class="view-btn" class:active={showGrid} on:click={toggleGrid}>Grid</button>
          <button type="button" class="view-btn" class:active={showAxes} on:click={toggleAxes}>Axes</button>
          <button type="button" class="view-btn" class:active={autoRotate} on:click={toggleAutoRotate}>Auto-rotate</button>
          <button type="button" class="view-btn" on:click={resetView}>Reset View</button>
        </div>
        <label class="thread-mode-control">
          <span>Threading</span>
          <select bind:value={threadMode} on:change={handleThreadModeChange}>
            <option value="auto">Auto</option>
            <option value="always">Always Multi-thread</option>
            <option value="off">Off</option>
          </select>
        </label>
      </div>
    </div>
    {#if threadingNotice}
      <div class="threading-note" bind:this={threadingNoteEl}>{threadingNotice}</div>
    {/if}
  {/if}
</div>

<style>
  .model-viewer {
    width: 100%;
    max-width: 560px;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    background: #0f1218;
  }

  .model-viewer.full-bleed {
    max-width: none;
    height: 100%;
    border: none;
    border-radius: 0;
  }

  canvas {
    width: 100%;
    display: block;
    min-height: 180px;
  }

  .viewer-hint {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.4rem;
    padding: 0.35rem 0.55rem;
    font-size: 0.72rem;
    color: #c8d2dc;
    background: #141a24;
    border-top: 1px solid #273041;
  }

  .viewer-controls-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.45rem;
    flex-wrap: wrap;
  }

  .view-mode-controls {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    flex-wrap: wrap;
  }

  .view-btn {
    border: 1px solid #2d394d;
    background: #0f141d;
    color: #d9e4ef;
    border-radius: 5px;
    padding: 0.14rem 0.44rem;
    font-size: 0.7rem;
    cursor: pointer;
  }

  .view-btn.active {
    background: #1b2d45;
    border-color: #3f5f8a;
  }

  .thread-mode-control {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    white-space: nowrap;
  }

  .thread-mode-control select {
    border: 1px solid #2d394d;
    background: #0f141d;
    color: #d9e4ef;
    border-radius: 5px;
    padding: 0.12rem 0.35rem;
    font-size: 0.72rem;
  }

  .threading-note {
    padding: 0.25rem 0.55rem 0.45rem;
    font-size: 0.68rem;
    color: #9db2c7;
    background: #141a24;
    border-top: 1px solid rgba(39, 48, 65, 0.55);
  }

  .model-error {
    color: #ffd4d4;
    font-size: 0.82rem;
    padding: 0.6rem 0.75rem;
    background: #2a1010;
  }
</style>
