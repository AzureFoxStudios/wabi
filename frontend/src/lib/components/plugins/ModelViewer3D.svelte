<script lang="ts">
  import { onMount } from 'svelte';
  import ModelViewerShell from './ModelViewerShell.svelte';
  import ModelViewerSettingsMenu from './ModelViewerSettingsMenu.svelte';
  import ModelInspectorPanel from './model-viewer/ModelInspectorPanel.svelte';
  import { createModelInspectorRuntime, type ModelInspectorRuntime } from './modelInspectorRuntime';
  import { EMPTY_INSPECTOR, frameDistance, extensionOf, modelFormatMessage, formatLength, type ModelUnit, type InspectorSnapshot, type ModelView } from './modelInspector';
  import {
    clearOverlayLines,
    clearRigOverlays,
    clearSkeletonHelpers,
    disposeMaterialLike,
    disposeRuntimeMaterials,
    getThreadMode,
    materialTextureKeys,
    persistThreadMode,
    resolveWorkerDecision,
    setColorTextureSpace,
    type AnimationLoopMode,
    type RigOverlay,
    type ThreadMode,
    type ViewMode
  } from './modelViewerHelpers';

  let {
    src, fileName = '3D model', height = 320, fullBleed = false, lazyLoad = true,
    hideUi = $bindable(false), onRetry
  }: {
    src: string; fileName?: string; height?: number; fullBleed?: boolean; lazyLoad?: boolean;
    hideUi?: boolean; onRetry?: () => void;
  } = $props();

  const THREE_BASE = 'https://esm.sh/three@0.181.1';

  let host = $state<HTMLDivElement>();
  let canvas = $state<HTMLCanvasElement>();
  let error = $state<string | null>(null);
  let disposed = false;
  let hasStarted = $state(false);
  let loadingViewer = $state(false);
  let menuOpen = $state(false);
  let threadMode = $state<ThreadMode>('auto');
  let threadingNotice = $state('');
  let viewMode = $state<ViewMode>('textured');
  let showGrid = $state(true);
  let showAxes = $state(false);
  let showRig = $state(true);
  let showDebugStats = $state(false);
  let debugStats = $state('');
  let rigStatusNote = $state('');
  let autoRotate = $state(false);
  let animationClipOptions = $state<Array<{ index: number; name: string; duration: number }>>([]);
  let selectedAnimationIndex = $state(0);
  let animationPlaying = $state(true);
  let animationSpeed = $state(1);
  let animationLoopMode = $state<AnimationLoopMode>('repeat');

  let applyViewModeRuntime: ((mode: ViewMode) => void) | null = null;
  let toggleGridRuntime: ((visible: boolean) => void) | null = null;
  let toggleAxesRuntime: ((visible: boolean) => void) | null = null;
  let toggleRigRuntime: ((visible: boolean) => void) | null = null;
  let setAutoRotateRuntime: ((enabled: boolean) => void) | null = null;
  let resetViewRuntime: (() => void) | null = null;
  let setAnimationClipRuntime: ((index: number) => void) | null = null;
  let setAnimationPlayingRuntime: ((playing: boolean) => void) | null = null;
  let setAnimationSpeedRuntime: ((speed: number) => void) | null = null;
  let setAnimationLoopRuntime: ((mode: AnimationLoopMode) => void) | null = null;
  let startViewer = $state<() => void>(() => {});
  let stopPreview = $state<() => void>(() => {});
  let inspector = $state.raw<ModelInspectorRuntime | null>(null);
  let inspectorSnapshot = $state.raw<InspectorSnapshot>({ ...EMPTY_INSPECTOR });
  let inspectorOpen = $state(false);
  let sourceUnit = $state<ModelUnit>('model');
  let displayUnit = $state<ModelUnit>('model');
  let fullscreenError = $state('');
  const measurementLabel = $derived(inspectorSnapshot.measuring
    ? inspectorSnapshot.distance === null
      ? inspectorSnapshot.measurePoints ? 'Pick a second point on the mesh' : 'Pick a point on the mesh'
      : `Approx. ${formatLength(inspectorSnapshot.distance, sourceUnit, displayUnit)}`
    : '');
  let isFullscreen = $state(false);

  async function shouldUseWorker(ext: string): Promise<boolean> {
    const decision = await resolveWorkerDecision(src, ext, threadMode);
    threadingNotice = decision.notice;
    return decision.useWorker;
  }

  function handleThreadModeChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as ThreadMode;
    threadMode = value;
    persistThreadMode(value);
  }

  function setViewMode(mode: ViewMode): void {
    viewMode = mode;
    applyViewModeRuntime?.(mode);
  }

  function toggleGrid(): void {
    showGrid = !showGrid;
    toggleGridRuntime?.(showGrid);
  }

  function toggleAxes(): void {
    showAxes = !showAxes;
    toggleAxesRuntime?.(showAxes);
  }

  function toggleRig(): void {
    showRig = !showRig;
    toggleRigRuntime?.(showRig);
  }

  function toggleDebugStats(): void {
    showDebugStats = !showDebugStats;
  }

  function toggleAutoRotate(): void {
    autoRotate = !autoRotate;
    setAutoRotateRuntime?.(autoRotate);
  }

  function handleAnimationClipChange(event: Event): void {
    const value = Number.parseInt((event.target as HTMLSelectElement).value, 10);
    if (!Number.isFinite(value)) return;
    inspector?.clearMeasurement();
    inspector?.select(null);
    selectedAnimationIndex = value;
    setAnimationClipRuntime?.(value);
  }

  function toggleAnimationPlayback(): void {
    const next = !animationPlaying;
    inspector?.clearMeasurement();
    inspector?.select(null);
    animationPlaying = next;
    setAnimationPlayingRuntime?.(next);
  }

  function handleAnimationSpeedChange(event: Event): void {
    const value = Number.parseFloat((event.target as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;
    animationSpeed = value;
    setAnimationSpeedRuntime?.(value);
  }

  function handleAnimationLoopModeChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as AnimationLoopMode;
    if (value !== 'repeat' && value !== 'once' && value !== 'pingpong') return;
    animationLoopMode = value;
    setAnimationLoopRuntime?.(value);
  }

  function resetView(): void {
    resetViewRuntime?.();
  }

  function toggleHideUi(): void {
    hideUi = !hideUi;
    if (hideUi) menuOpen = false;
  }

  async function toggleFullscreen(): Promise<void> {
    if (!host) return;
    fullscreenError = '';
    try {
      if (document.fullscreenElement === host) await document.exitFullscreen();
      else if (host.requestFullscreen) await host.requestFullscreen();
      else fullscreenError = 'Fullscreen is not available in this browser.';
    } catch {
      fullscreenError = 'Fullscreen was not allowed. The normal viewer is still available.';
    }
    syncFullscreen();
  }

  function syncFullscreen(): void { isFullscreen = !!host && document.fullscreenElement === host; }
  function toggleInspector(): void { inspectorOpen = !inspectorOpen; menuOpen = false; }
  function toggleDisplay(): void { menuOpen = !menuOpen; inspectorOpen = false; }
  function handleViewerKey(event: KeyboardEvent): void {
    if (!host?.contains(document.activeElement) || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Escape' && (menuOpen || inspectorOpen)) {
      menuOpen = false; inspectorOpen = false; canvas?.focus(); event.preventDefault(); return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, select, textarea, [contenteditable=true]')) return;
    if (event.key.toLowerCase() === 'f') { inspector?.fit(); event.preventDefault(); }
    const views: Record<string, ModelView> = { '0': 'iso', '1': 'front', '3': 'right', '7': 'top' };
    if (Object.hasOwn(views, event.key)) { inspector?.setView(views[event.key]); event.preventDefault(); }
  }

  onMount(() => {
    threadMode = getThreadMode();
    document.addEventListener('fullscreenchange', syncFullscreen);
    const pauseForInspection = () => {
      autoRotate = false;
      if (controls) controls.autoRotate = false;
      if (activeAction) { activeAction.paused = true; animationPlaying = false; }
    };
    let rejectWorker: ((reason: Error) => void) | null = null;

    let renderer: any;
    let scene: any;
    let camera: any;
    let controls: any;
    let grid: any;
    let axes: any;
    let clock: any;
    let mixer: any = null;
    let activeAction: any = null;
    let animationClips: any[] = [];
    const skeletonHelpers: any[] = [];
    const rigOverlays: RigOverlay[] = [];
    let frameHandle = 0;
    let worker: Worker | null = null;
    let loadedRoot: any = null;
    let fitCameraToObjectRef: ((object: any, THREE: any) => void) | null = null;
    let THREE: any = null;
    let tmpBonePosA: any = null;
    let tmpBonePosB: any = null;
    let tmpBoneMid: any = null;
    let tmpBoneDir: any = null;
    let tmpBoneQuat: any = null;
    let rigUpAxis: any = null;
    let sourceMaterialsCaptured = false;
    const meshes: any[] = [];
    const sourceMaterials: any[] = [];
    const runtimeMaterials: any[] = [];
    const overlayLines: Array<{ line: any; geometry: any; material: any }> = [];

    const collectBonesFromRoot = (rootBone: any): any[] => {
      const list: any[] = [];
      rootBone?.traverse?.((node: any) => {
        if (node?.isBone) list.push(node);
      });
      return list;
    };

    const getBoneRoot = (bone: any): any => {
      let current = bone;
      while (current?.parent?.isBone) {
        current = current.parent;
      }
      return current;
    };

    const createRigOverlayFromBones = (bones: any[], jointRadius: number) => {
      if (!THREE || !scene || !Array.isArray(bones) || bones.length === 0) return;

      const pairs: Array<[any, any]> = [];
      for (const bone of bones) {
        const parent = bone?.parent;
        if (parent?.isBone) pairs.push([bone, parent]);
      }

      const linePositions = new Float32Array(Math.max(1, pairs.length) * 6);
      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
      lineGeometry.attributes.position.setUsage(THREE.DynamicDrawUsage);
      const lineMaterial = new THREE.LineBasicMaterial({
        color: 0x1fc8ff,
        transparent: true,
        opacity: 1,
        depthTest: false,
        depthWrite: false,
        toneMapped: false
      });
      const line = new THREE.LineSegments(lineGeometry, lineMaterial);
      line.visible = showRig;
      line.frustumCulled = false;
      line.renderOrder = 1650;
      scene.add(line);

      const stickGeometry = new THREE.CylinderGeometry(Math.max(jointRadius * 0.18, 0.0015), Math.max(jointRadius * 0.18, 0.0015), 1, 6, 1, true);
      const stickMaterial = new THREE.MeshBasicMaterial({
        color: 0x111924,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
        depthWrite: false,
        toneMapped: false
      });
      const sticks: any[] = [];
      for (let pairIndex = 0; pairIndex < pairs.length; pairIndex += 1) {
        const stick = new THREE.Mesh(stickGeometry, stickMaterial);
        stick.visible = showRig;
        stick.frustumCulled = false;
        stick.renderOrder = 1651;
        scene.add(stick);
        sticks.push(stick);
      }

      const jointGeometry = new THREE.OctahedronGeometry(jointRadius, 0);
      const jointMaterial = new THREE.MeshBasicMaterial({
        color: 0xfff2a8,
        transparent: true,
        opacity: 1,
        depthTest: false,
        depthWrite: false,
        toneMapped: false
      });
      const joints: any[] = [];
      for (const _bone of bones) {
        const marker = new THREE.Mesh(jointGeometry, jointMaterial);
        marker.visible = showRig;
        marker.frustumCulled = false;
        marker.renderOrder = 1652;
        scene.add(marker);
        joints.push(marker);
      }

      rigOverlays.push({
        bones,
        pairs,
        line,
        lineGeometry,
        lineMaterial,
        linePositions,
        sticks,
        stickGeometry,
        stickMaterial,
        joints,
        jointGeometry,
        jointMaterial
      });
    };

    const updateRigOverlays = () => {
      if (!THREE || rigOverlays.length === 0) return;
      if (!tmpBonePosA) tmpBonePosA = new THREE.Vector3();
      if (!tmpBonePosB) tmpBonePosB = new THREE.Vector3();
      if (!tmpBoneMid) tmpBoneMid = new THREE.Vector3();
      if (!tmpBoneDir) tmpBoneDir = new THREE.Vector3();
      if (!tmpBoneQuat) tmpBoneQuat = new THREE.Quaternion();
      if (!rigUpAxis) rigUpAxis = new THREE.Vector3(0, 1, 0);

      for (const overlay of rigOverlays) {
        for (let boneIndex = 0; boneIndex < overlay.bones.length; boneIndex += 1) {
          const bone = overlay.bones[boneIndex];
          const joint = overlay.joints[boneIndex];
          if (!bone || !joint) continue;
          bone.getWorldPosition(tmpBonePosA);
          joint.position.copy(tmpBonePosA);
        }

        if (overlay.pairs.length === 0) continue;
        for (let pairIndex = 0; pairIndex < overlay.pairs.length; pairIndex += 1) {
          const [childBone, parentBone] = overlay.pairs[pairIndex];
          childBone.getWorldPosition(tmpBonePosA);
          parentBone.getWorldPosition(tmpBonePosB);
          const base = pairIndex * 6;
          overlay.linePositions[base] = tmpBonePosA.x;
          overlay.linePositions[base + 1] = tmpBonePosA.y;
          overlay.linePositions[base + 2] = tmpBonePosA.z;
          overlay.linePositions[base + 3] = tmpBonePosB.x;
          overlay.linePositions[base + 4] = tmpBonePosB.y;
          overlay.linePositions[base + 5] = tmpBonePosB.z;

          const stick = overlay.sticks[pairIndex];
          if (!stick) continue;
          tmpBoneMid.copy(tmpBonePosA).add(tmpBonePosB).multiplyScalar(0.5);
          tmpBoneDir.copy(tmpBonePosB).sub(tmpBonePosA);
          const length = tmpBoneDir.length();
          if (length <= 0.0001) {
            stick.visible = false;
            continue;
          }
          if (showRig) stick.visible = true;
          tmpBoneDir.multiplyScalar(1 / length);
          tmpBoneQuat.setFromUnitVectors(rigUpAxis, tmpBoneDir);
          stick.position.copy(tmpBoneMid);
          stick.quaternion.copy(tmpBoneQuat);
          stick.scale.set(1, length, 1);
        }
        overlay.lineGeometry.attributes.position.needsUpdate = true;
      }
    };

    const normalizeMeshMaterial = (mesh: any) => {
      const applySingle = (material: any) => {
        if (!material) return;
        if (mesh?.isSkinnedMesh && 'skinning' in material) {
          material.skinning = true;
        }
        if ('side' in material && (mesh?.isSkinnedMesh || material.transparent)) {
          material.side = THREE.DoubleSide;
        }
        for (const key of materialTextureKeys) {
          setColorTextureSpace((material as any)[key], THREE);
        }
        material.needsUpdate = true;
      };

      if (Array.isArray(mesh?.material)) {
        for (const material of mesh.material) applySingle(material);
      } else {
        applySingle(mesh?.material);
      }
    };

    const styleSkeletonHelper = (helper: any) => {
      const materials = Array.isArray(helper?.material) ? helper.material : [helper?.material];
      for (const material of materials) {
        if (!material) continue;
        if ('depthTest' in material) material.depthTest = false;
        if ('transparent' in material) material.transparent = true;
        if ('opacity' in material) material.opacity = 0.95;
        if (material?.color?.setHex) material.color.setHex(0x66d9ff);
      }
      helper.renderOrder = 999;
    };

    const createFaceDirectionMaterial = () => {
      const material = new THREE.ShaderMaterial({
        side: THREE.DoubleSide,
        toneMapped: false,
        clipping: true,
        vertexShader: `
          #include <common>
          #include <morphtarget_pars_vertex>
          #include <skinning_pars_vertex>
          #include <clipping_planes_pars_vertex>
          varying vec3 vNormal;
          void main() {
            #include <beginnormal_vertex>
            #include <morphnormal_vertex>
            #include <skinbase_vertex>
            #include <skinnormal_vertex>
            #include <defaultnormal_vertex>
            vNormal = normalize(transformedNormal);
            #include <begin_vertex>
            #include <morphtarget_vertex>
            #include <skinning_vertex>
            #include <project_vertex>
            #include <clipping_planes_vertex>
          }
        `,
        fragmentShader: `
          #include <clipping_planes_pars_fragment>
          varying vec3 vNormal;
          void main() {
            #include <clipping_planes_fragment>
            vec3 n = normalize(vNormal);
            vec3 frontColor = 0.5 * (n + 1.0);
            vec3 backColor = vec3(1.0, 0.22, 0.22);
            vec3 outColor = gl_FrontFacing ? frontColor : backColor;
            gl_FragColor = vec4(outColor, 1.0);
          }
        `
      });
      runtimeMaterials.push(material);
      return material;
    };

    const createWireframeOnlyMaterial = () => {
      const material = new THREE.MeshBasicMaterial({
        color: 0xb8d4d1,
        wireframe: true
      });
      runtimeMaterials.push(material);
      return material;
    };

    // Wireframe overlay mode has been intentionally disabled for now.
    // const createWireframeOverlayBaseMaterial = () => {
    //   const material = new THREE.MeshStandardMaterial({
    //     color: 0x99a8ba,
    //     metalness: 0.08,
    //     roughness: 0.7
    //   });
    //   runtimeMaterials.push(material);
    //   return material;
    // };

    const applyViewMode = (mode: ViewMode) => {
      if (!THREE || meshes.length === 0) return;
      if (!sourceMaterialsCaptured) {
        for (const mesh of meshes) {
          sourceMaterials.push(mesh.material);
        }
        sourceMaterialsCaptured = true;
      }

      clearOverlayLines(overlayLines);
      disposeRuntimeMaterials(runtimeMaterials);

      for (let meshIndex = 0; meshIndex < meshes.length; meshIndex += 1) {
        const mesh = meshes[meshIndex];
        if (mode === 'textured') {
          mesh.material = sourceMaterials[meshIndex];
          continue;
        }

        if (mode === 'normal') {
          mesh.material = createFaceDirectionMaterial();
          continue;
        }

        if (mode === 'wireframe-lines') {
          mesh.material = createWireframeOnlyMaterial();
          continue;
        }
      }

      // Wireframe overlay mode has been intentionally disabled for now.
      // if (mode === 'wireframe-overlay') { ... }
    };

    const applyAnimationLoopModeToAction = (action: any, mode: AnimationLoopMode) => {
      if (!action || !THREE) return;
      if (mode === 'once') {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
        return;
      }
      if (mode === 'pingpong') {
        action.setLoop(THREE.LoopPingPong, Infinity);
        action.clampWhenFinished = false;
        return;
      }
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = false;
    };

    const playAnimationClip = (clipIndex: number) => {
      if (!mixer || animationClips.length === 0) return;
      const nextClip = animationClips[clipIndex];
      if (!nextClip) return;

      if (activeAction) {
        activeAction.stop();
      }

      selectedAnimationIndex = clipIndex;
      activeAction = mixer.clipAction(nextClip);
      applyAnimationLoopModeToAction(activeAction, animationLoopMode);
      activeAction.reset();
      activeAction.setEffectiveTimeScale(animationSpeed);
      activeAction.play();
      activeAction.paused = !animationPlaying;
    };

    const dispose = () => {
      if (disposed) return;
      disposed = true;
      rejectWorker?.(new Error('Preview stopped'));
      rejectWorker = null;
      inspector?.dispose();
      inspector = null;
      if (frameHandle) cancelAnimationFrame(frameHandle);
      controls?.dispose?.();
      clearOverlayLines(overlayLines);
      clearSkeletonHelpers(skeletonHelpers);
      clearRigOverlays(rigOverlays);
      rigStatusNote = '';
      disposeRuntimeMaterials(runtimeMaterials);
      for (const material of sourceMaterials) {
        disposeMaterialLike(material);
      }
      for (const mesh of meshes) {
        mesh.geometry?.dispose?.();
        disposeMaterialLike(mesh.material);
      }
      grid?.geometry?.dispose?.();
      disposeMaterialLike(grid?.material);
      axes?.geometry?.dispose?.();
      disposeMaterialLike(axes?.material);
      renderer?.dispose?.();
      worker?.terminate?.();
      mixer?.stopAllAction?.();
      applyViewModeRuntime = null;
      toggleGridRuntime = null;
      toggleAxesRuntime = null;
      toggleRigRuntime = null;
      setAutoRotateRuntime = null;
      resetViewRuntime = null;
      setAnimationClipRuntime = null;
      setAnimationPlayingRuntime = null;
      setAnimationSpeedRuntime = null;
      setAnimationLoopRuntime = null;
    };

    const fitCameraToObject = (object: any, ThreeNs: any) => {
      const box = new ThreeNs.Box3().setFromObject(object);
      if (box.isEmpty()) return;
      const size = box.getSize(new ThreeNs.Vector3());
      const center = box.getCenter(new ThreeNs.Vector3());
      const stage = canvas?.parentElement;
      const aspect = stage ? Math.max(stage.clientWidth, 1) / Math.max(stage.clientHeight, 1) : 1;
      camera.aspect = aspect;
      const distance = frameDistance(size, camera.fov, aspect);
      if (distance === null) throw new Error('This model has invalid or excessively large bounds.');
      const direction = new ThreeNs.Vector3(1, 0.65, 1).normalize();
      camera.position.copy(center).addScaledVector(direction, distance);
      camera.near = Math.max(distance / 1000, 1e-7);
      camera.far = Math.max(distance * 100, 1);
      controls.minDistance = Math.max(distance / 1000, 1e-7);
      controls.maxDistance = distance * 50;
      camera.updateProjectionMatrix();

      controls.target.copy(center);
      controls.update();
    };

    const releaseLateObject = (object: any) => {
      object.traverse?.((child: any) => { child.geometry?.dispose?.(); disposeMaterialLike(child.material); });
    };

    const start = async () => {
      try {
        const formatError = modelFormatMessage(fileName);
        if (formatError) throw new Error(formatError);
        const loadModule = async (url: string): Promise<any> => import(/* @vite-ignore */ url);

        THREE = await loadModule(THREE_BASE);
        const { OrbitControls } = await loadModule(`${THREE_BASE}/examples/jsm/controls/OrbitControls`);

        if (disposed) return;

        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x0f1218);

        camera = new THREE.PerspectiveCamera(55, 1, 0.01, 2000);
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.0;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        clock = new THREE.Clock();

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

        const ext = extensionOf(fileName);
        threadingNotice = '';
        const addLoadedObject = (object: any) => {
          loadedRoot = object;
          scene.add(object);
          object.updateMatrixWorld(true);
          const objectBounds = new THREE.Box3().setFromObject(object);
          const objectSize = objectBounds.getSize(new THREE.Vector3());
          const maxObjectSize = Math.max(objectSize.x, objectSize.y, objectSize.z) || 1;
          const jointRadius = Math.min(0.07, Math.max(0.009, maxObjectSize * 0.014));
          const seenMaterial = new Set<any>();
          const seenTexture = new Set<any>();
          const boneRoots = new Set<any>();
          const rigRoots = new Set<any>();
          let meshCount = 0;
          let skinnedMeshCount = 0;
          let boneCount = 0;
          object.traverse?.((child: any) => {
            if (child?.isBone) {
              boneCount += 1;
              const parent = child?.parent;
              if (!parent?.isBone) boneRoots.add(child);
            }
            if (child?.isMesh) {
              meshCount += 1;
              meshes.push(child);
              normalizeMeshMaterial(child);
              if (Array.isArray(child.material)) {
                for (const mat of child.material) {
                  if (!mat) continue;
                  seenMaterial.add(mat);
                  for (const key of materialTextureKeys) {
                    const texture = (mat as any)[key];
                    if (texture) seenTexture.add(texture);
                  }
                }
              } else if (child.material) {
                seenMaterial.add(child.material);
                for (const key of materialTextureKeys) {
                  const texture = (child.material as any)[key];
                  if (texture) seenTexture.add(texture);
                }
              }
              if (child?.isSkinnedMesh) {
                skinnedMeshCount += 1;
                const helper = new THREE.SkeletonHelper(child);
                helper.visible = showRig;
                styleSkeletonHelper(helper);
                scene.add(helper);
                skeletonHelpers.push(helper);
                const skinnedBones = child?.skeleton?.bones;
                if (Array.isArray(skinnedBones) && skinnedBones.length > 0) {
                  const rootBone = getBoneRoot(skinnedBones[0]);
                  if (rootBone && !rigRoots.has(rootBone)) {
                    rigRoots.add(rootBone);
                    createRigOverlayFromBones(collectBonesFromRoot(rootBone), jointRadius);
                  }
                }
              }
            }
          });
          if (rigRoots.size === 0 && boneRoots.size > 0) {
            for (const rootBone of boneRoots) {
              const helper = new THREE.SkeletonHelper(rootBone);
              helper.visible = showRig;
              styleSkeletonHelper(helper);
              scene.add(helper);
              skeletonHelpers.push(helper);
              createRigOverlayFromBones(collectBonesFromRoot(rootBone), jointRadius);
            }
          }
          const overlayJointCount = rigOverlays.reduce((total, overlay) => total + overlay.bones.length, 0);
          const overlayLinkCount = rigOverlays.reduce((total, overlay) => total + overlay.pairs.length, 0);
          if (boneCount === 0) {
            rigStatusNote = 'No skeleton detected in this model file.';
          } else if (overlayJointCount === 0) {
            rigStatusNote = `Detected ${boneCount} bones, but no rig overlay could be built.`;
          } else {
            rigStatusNote = `Rig overlay: ${overlayJointCount} joints, ${overlayLinkCount} links.`;
          }
          debugStats =
            `Meshes ${meshCount} | Skinned ${skinnedMeshCount} | Bones ${boneCount} | ` +
            `Materials ${seenMaterial.size} | Textures ${seenTexture.size} | Rig overlays ${rigOverlays.length} | Rig links ${overlayLinkCount}`;
          fitCameraToObject(object, THREE);
        };
        fitCameraToObjectRef = fitCameraToObject;

        applyViewModeRuntime = (mode: ViewMode) => applyViewMode(mode);
        toggleGridRuntime = (visible: boolean) => {
          if (grid) grid.visible = visible;
        };
        toggleAxesRuntime = (visible: boolean) => {
          if (axes) axes.visible = visible;
        };
        toggleRigRuntime = (visible: boolean) => {
          for (const helper of skeletonHelpers) helper.visible = visible;
          for (const overlay of rigOverlays) {
            overlay.line.visible = visible;
            for (const stick of overlay.sticks) stick.visible = visible;
            for (const joint of overlay.joints) joint.visible = visible;
          }
        };
        setAutoRotateRuntime = (enabled: boolean) => {
          if (controls) controls.autoRotate = enabled;
        };
        resetViewRuntime = () => {
          if (loadedRoot && fitCameraToObjectRef) fitCameraToObjectRef(loadedRoot, THREE);
        };
        setAnimationClipRuntime = (index: number) => {
          playAnimationClip(index);
        };
        setAnimationPlayingRuntime = (playing: boolean) => {
          if (!activeAction) return;
          activeAction.paused = !playing;
        };
        setAnimationSpeedRuntime = (speed: number) => {
          if (!activeAction) return;
          activeAction.setEffectiveTimeScale(speed);
        };
        setAnimationLoopRuntime = (mode: AnimationLoopMode) => {
          if (!activeAction) return;
          applyAnimationLoopModeToAction(activeAction, mode);
        };

        if (ext === 'glb' || ext === 'gltf') {
          if (threadMode === 'always') {
            threadingNotice = 'Worker parse not available for this format. Falling back to main-thread.';
          }
          const { GLTFLoader } = await loadModule(`${THREE_BASE}/examples/jsm/loaders/GLTFLoader`);
          if (disposed) return;
          const loader = new GLTFLoader();
          const gltf = await loader.loadAsync(src);
          if (disposed) { releaseLateObject(gltf.scene); return; }
          addLoadedObject(gltf.scene);
          animationClips = Array.isArray(gltf.animations) ? gltf.animations : [];
          animationClipOptions = animationClips.map((clip: any, index: number) => ({
            index,
            name: clip?.name || `Animation ${index + 1}`,
            duration: Number.isFinite(clip?.duration) ? clip.duration : 0
          }));
          if (animationClipOptions.length > 0) {
            mixer = new THREE.AnimationMixer(gltf.scene);
            selectedAnimationIndex = 0;
            animationPlaying = true;
            playAnimationClip(0);
          }
        } else if (ext === 'obj') {
          if (threadMode === 'always') {
            threadingNotice = 'Worker parse not available for this format. Falling back to main-thread.';
          }
          const { OBJLoader } = await loadModule(`${THREE_BASE}/examples/jsm/loaders/OBJLoader`);
          if (disposed) return;
          const loader = new OBJLoader();
          const obj = await loader.loadAsync(src);
          if (disposed) { releaseLateObject(obj); return; }
          addLoadedObject(obj);
        } else if (ext === 'stl') {
          const useWorker = await shouldUseWorker(ext);
          if (disposed) return;
          if (useWorker) {
            worker = new Worker(new URL('./model-loader.worker.ts', import.meta.url), { type: 'module' });
            const workerResult = await new Promise<any>((resolve, reject) => {
              const timer = window.setTimeout(() => finish(new Error('STL parsing timed out. Try a smaller model.')), 60_000);
              const finish = (error: Error | null, data?: any) => {
                window.clearTimeout(timer);
                worker?.terminate(); worker = null; rejectWorker = null;
                if (error) reject(error); else resolve(data);
              };
              rejectWorker = (error) => finish(error);
              worker?.addEventListener('message', (ev: MessageEvent<any>) => finish(null, ev.data), { once: true });
              worker?.addEventListener('error', (ev: ErrorEvent) => finish(new Error(ev.message)), { once: true });
              worker?.postMessage({ type: 'parse-stl', src });
            });

            if (disposed) return;
            if (!workerResult?.ok) {
              throw new Error(workerResult?.error || 'Worker STL parse failed');
            }
            if (threadMode === 'always') threadingNotice = 'Worker mode enabled.';

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

            const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
            mesh.name = fileName;
            addLoadedObject(mesh);
          } else {
            const { STLLoader } = await loadModule(`${THREE_BASE}/examples/jsm/loaders/STLLoader`);
            if (disposed) return;
            const loader = new STLLoader();
            const geometry = await loader.loadAsync(src);
            if (disposed) { geometry.dispose(); return; }
            const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
            mesh.name = fileName;
            addLoadedObject(mesh);
          }
        } else {
          error = `Unsupported model format: .${ext || 'unknown'}`;
          return;
        }

        if (disposed || !canvas || !loadedRoot) return;
        applyViewMode(viewMode);
        inspector = createModelInspectorRuntime({
          THREE, root: loadedRoot, scene, camera, controls, renderer, canvas,
          onChange: (snapshot) => { inspectorSnapshot = snapshot; }, onInspect: pauseForInspection
        });

        const resize = () => {
          if (disposed || !canvas?.parentElement || !renderer || !camera) return;
          const stage = canvas.parentElement;
          const width = Math.max(stage.clientWidth, 1);
          const nextHeight = Math.max(stage.clientHeight, 1);
          const nextAspect = width / nextHeight;
          const referenceSize = { x: 1, y: 1, z: 1 };
          const oldFit = frameDistance(referenceSize, camera.fov, camera.aspect);
          const newFit = frameDistance(referenceSize, camera.fov, nextAspect);
          if (oldFit && newFit && controls && Math.abs(camera.aspect - nextAspect) > 0.0001) {
            const ratio = newFit / oldFit;
            camera.position.sub(controls.target).multiplyScalar(ratio).add(controls.target);
            camera.near *= ratio; camera.far *= ratio;
            controls.minDistance *= ratio; controls.maxDistance *= ratio;
          }
          renderer.setSize(width, nextHeight, false);
          camera.aspect = nextAspect;
          camera.updateProjectionMatrix();
        };

        const animate = () => {
          if (disposed) return;
          frameHandle = requestAnimationFrame(animate);
          if (mixer && clock) {
            const delta = clock.getDelta();
            mixer.update(delta);
          }
          loadedRoot?.updateMatrixWorld?.(true);
          updateRigOverlays();
          controls?.update?.();
          renderer?.render?.(scene, camera);
        };

        const resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(canvas.parentElement!);
        resize();
        animate();

        return () => resizeObserver.disconnect();
      } catch (e) {
        if (!disposed) {
          error = e instanceof Error ? e.message : 'Failed to initialize 3D viewer';
          dispose();
        }
      }
    };

    let stopResizeWatch: (() => void) | undefined;
    const runStart = () => {
      if (hasStarted || loadingViewer) return;
      hasStarted = true;
      loadingViewer = true;
      start()
        .then((cleanup) => {
          if (typeof cleanup === 'function') {
            if (disposed) cleanup(); else stopResizeWatch = cleanup;
          }
        })
        .finally(() => {
          loadingViewer = false;
        });
    };
    startViewer = runStart;
    stopPreview = () => {
      stopResizeWatch?.();
      dispose();
      loadingViewer = false;
      error = 'Preview stopped. Any outstanding file downloads may finish, but their result will not be displayed.';
    };

    if (!lazyLoad) {
      runStart();
    }

    return () => {
      startViewer = () => {};
      stopPreview = () => {};
      document.removeEventListener('fullscreenchange', syncFullscreen);
      stopResizeWatch?.();
      dispose();
    };
  });
</script>

<svelte:window onkeydown={handleViewerKey} />

<ModelViewerShell
  {viewMode} {hideUi} {loadingViewer} {hasStarted} {fileName} {error} {fullBleed} {height}
  {isFullscreen} {fullscreenError} {inspectorOpen} settingsOpen={menuOpen}
  ready={!!inspector && !loadingViewer && !error} {measurementLabel} bind:host
  onStartViewer={startViewer} onViewModeChange={setViewMode} onToggleHideUi={toggleHideUi}
  onToggleFullscreen={toggleFullscreen} onToggleInspector={toggleInspector} onToggleSettings={toggleDisplay}
  onFitView={() => inspector?.fit()} onViewPreset={(view) => inspector?.setView(view)}
  onRetry={modelFormatMessage(fileName) ? undefined : onRetry} onStopPreview={stopPreview}
>
  {#snippet canvasContent()}
    <canvas bind:this={canvas} tabindex="0" aria-label={`3D model ${fileName}. Drag to orbit. F fits the view. 0 isometric, 1 front, 3 right, 7 top.`}></canvas>
  {/snippet}
  {#snippet inspectorContent()}
    {#if inspector}<ModelInspectorPanel snapshot={inspectorSnapshot} runtime={inspector} {fileName} bind:sourceUnit bind:displayUnit />{/if}
  {/snippet}
  {#snippet settingsMenu()}
    <ModelViewerSettingsMenu
      {autoRotate} {showGrid} {showAxes} {showRig} {showDebugStats} {animationClipOptions}
      bind:selectedAnimationIndex {animationPlaying} {animationSpeed} bind:animationLoopMode bind:threadMode
      onToggleAutoRotate={toggleAutoRotate} onResetView={resetView} onToggleGrid={toggleGrid}
      onToggleAxes={toggleAxes} onToggleRig={toggleRig} onToggleDebugStats={toggleDebugStats}
      onAnimationClipChange={handleAnimationClipChange} onToggleAnimationPlayback={toggleAnimationPlayback}
      onAnimationLoopModeChange={handleAnimationLoopModeChange} onAnimationSpeedChange={handleAnimationSpeedChange}
      onThreadModeChange={handleThreadModeChange}
    />
  {/snippet}
  {#snippet notes()}
    {#if !hideUi && (threadingNotice || showDebugStats || showRig && rigStatusNote)}
      <details class="mv-diagnostics"><summary>Viewer information</summary>
        {#if threadingNotice}<p>{threadingNotice}</p>{/if}
        {#if showRig && rigStatusNote}<p>{rigStatusNote}</p>{/if}
        {#if showDebugStats && debugStats}<p>{debugStats}</p>{/if}
      </details>
    {/if}
  {/snippet}
</ModelViewerShell>
