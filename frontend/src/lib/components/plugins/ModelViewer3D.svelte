<script lang="ts">
  import { onMount } from 'svelte';

  export let src: string;
  export let fileName = '3D model';
  export let height = 320;
  type ThreadMode = 'auto' | 'always' | 'off';
  const THREAD_MODE_KEY = 'wabi:model-viewer-thread-mode';
  const AUTO_WORKER_THRESHOLD_BYTES = 8 * 1024 * 1024;

  let host: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let error: string | null = null;
  let disposed = false;
  let threadMode: ThreadMode = 'auto';
  let threadingNotice = '';
  const THREE_BASE = 'https://esm.sh/three@0.181.1';

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

  onMount(() => {
    threadMode = getThreadMode();
    let renderer: any;
    let scene: any;
    let camera: any;
    let controls: any;
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

        const grid = new THREE.GridHelper(20, 20, 0x364150, 0x202833);
        grid.position.y = -0.01;
        scene.add(grid);

        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.07;
        controls.minDistance = 0.1;
        controls.maxDistance = 200;

        const ext = (fileName.split('.').pop() || '').toLowerCase();
        threadingNotice = '';
        const addLoadedObject = (object: any) => {
          scene.add(object);
          object.traverse?.((child: any) => {
            if (child?.isMesh) meshes.push(child);
          });
          fitCameraToObject(object, THREE);
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

        const resize = () => {
          if (!host || !renderer || !camera) return;
          const width = Math.max(host.clientWidth, 1);
          const nextHeight = Math.max(height, 180);
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

<div class="model-viewer" bind:this={host}>
  {#if error}
    <div class="model-error">{error}</div>
  {:else}
    <canvas bind:this={canvas} aria-label={`3D model viewer for ${fileName}`}></canvas>
    <div class="viewer-hint">
      <span>Drag to rotate, wheel to zoom, right-drag to pan</span>
      <label class="thread-mode-control">
        <span>Threading</span>
        <select bind:value={threadMode} on:change={handleThreadModeChange}>
          <option value="auto">Auto</option>
          <option value="always">Always Multi-thread</option>
          <option value="off">Off</option>
        </select>
      </label>
    </div>
    {#if threadingNotice}
      <div class="threading-note">{threadingNotice}</div>
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

  canvas {
    width: 100%;
    display: block;
    min-height: 180px;
  }

  .viewer-hint {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.35rem 0.55rem;
    font-size: 0.72rem;
    color: #c8d2dc;
    background: #141a24;
    border-top: 1px solid #273041;
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
