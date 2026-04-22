<script lang="ts">
  import { onMount } from 'svelte';

  export let src: string;
  export let fileName = '3D model';
  export let height = 320;
  export let fullBleed = false;
  export let lazyLoad = true;
  export let hideUi = false;

  type ThreadMode = 'auto' | 'always' | 'off';
  type ViewMode = 'textured' | 'normal' | 'wireframe-lines';
  type AnimationLoopMode = 'repeat' | 'once' | 'pingpong';

  const THREAD_MODE_KEY = 'wabi:model-viewer-thread-mode';
  const AUTO_WORKER_THRESHOLD_BYTES = 8 * 1024 * 1024;
  const THREE_BASE = 'https://esm.sh/three@0.181.1';

  let host: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let error: string | null = null;
  let disposed = false;
  let hasStarted = false;
  let loadingViewer = false;
  let menuOpen = false;
  let threadMode: ThreadMode = 'auto';
  let threadingNotice = '';
  let viewMode: ViewMode = 'textured';
  let showGrid = true;
  let showAxes = false;
  let showRig = true;
  let showDebugStats = false;
  let debugStats = '';
  let rigStatusNote = '';
  let autoRotate = false;
  let animationClipOptions: Array<{ index: number; name: string; duration: number }> = [];
  let selectedAnimationIndex = 0;
  let animationPlaying = true;
  let animationSpeed = 1;
  let animationLoopMode: AnimationLoopMode = 'repeat';

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
  let startViewer: () => void = () => {};

  function getThreadMode(): ThreadMode {
    const raw = localStorage.getItem(THREAD_MODE_KEY);
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
    selectedAnimationIndex = value;
    setAnimationClipRuntime?.(value);
  }

  function toggleAnimationPlayback(): void {
    animationPlaying = !animationPlaying;
    setAnimationPlayingRuntime?.(animationPlaying);
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

  function handleWindowClick(): void {
    if (menuOpen) menuOpen = false;
  }

  onMount(() => {
    threadMode = getThreadMode();

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
    type RigOverlay = {
      bones: any[];
      pairs: Array<[any, any]>;
      line: any;
      lineGeometry: any;
      lineMaterial: any;
      linePositions: Float32Array;
      sticks: any[];
      stickGeometry: any;
      stickMaterial: any;
      joints: any[];
      jointGeometry: any;
      jointMaterial: any;
    };
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

    const materialTextureKeys = [
      'map',
      'emissiveMap',
      'specularColorMap',
      'sheenColorMap'
    ];

    const clearSkeletonHelpers = () => {
      for (const helper of skeletonHelpers) {
        helper?.parent?.remove?.(helper);
        helper?.geometry?.dispose?.();
        helper?.material?.dispose?.();
      }
      skeletonHelpers.length = 0;
    };

    const clearRigOverlays = () => {
      for (const overlay of rigOverlays) {
        overlay.line?.parent?.remove?.(overlay.line);
        overlay.lineGeometry?.dispose?.();
        overlay.lineMaterial?.dispose?.();
        for (const stick of overlay.sticks) {
          stick?.parent?.remove?.(stick);
        }
        overlay.stickGeometry?.dispose?.();
        overlay.stickMaterial?.dispose?.();
        for (const joint of overlay.joints) {
          joint?.parent?.remove?.(joint);
        }
        overlay.jointGeometry?.dispose?.();
        overlay.jointMaterial?.dispose?.();
      }
      rigOverlays.length = 0;
    };

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

    const disposeMaterialLike = (materialLike: any) => {
      if (Array.isArray(materialLike)) {
        for (const mat of materialLike) mat?.dispose?.();
      } else {
        materialLike?.dispose?.();
      }
    };

    const clearOverlayLines = () => {
      for (const overlay of overlayLines) {
        overlay.line?.parent?.remove?.(overlay.line);
        overlay.geometry?.dispose?.();
        overlay.material?.dispose?.();
      }
      overlayLines.length = 0;
    };

    const disposeRuntimeMaterials = () => {
      for (const material of runtimeMaterials) {
        material?.dispose?.();
      }
      runtimeMaterials.length = 0;
    };

    const setColorTextureSpace = (texture: any) => {
      if (!texture) return;
      if (typeof THREE?.SRGBColorSpace !== 'undefined' && 'colorSpace' in texture) {
        texture.colorSpace = THREE.SRGBColorSpace;
      } else if (typeof THREE?.sRGBEncoding !== 'undefined' && 'encoding' in texture) {
        texture.encoding = THREE.sRGBEncoding;
      }
      texture.needsUpdate = true;
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
          setColorTextureSpace((material as any)[key]);
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
        vertexShader: `
          varying vec3 vNormal;
          void main() {
            vNormal = normalize(normalMatrix * normal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          varying vec3 vNormal;
          void main() {
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
        color: 0x0a0a0a,
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

      clearOverlayLines();
      disposeRuntimeMaterials();

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
      disposed = true;
      if (frameHandle) cancelAnimationFrame(frameHandle);
      controls?.dispose?.();
      clearOverlayLines();
      clearSkeletonHelpers();
      clearRigOverlays();
      rigStatusNote = '';
      disposeRuntimeMaterials();
      for (const material of sourceMaterials) {
        disposeMaterialLike(material);
      }
      for (const mesh of meshes) {
        mesh.geometry?.dispose?.();
        disposeMaterialLike(mesh.material);
      }
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

        const ext = (fileName.split('.').pop() || '').toLowerCase();
        threadingNotice = '';
        const addLoadedObject = (object: any) => {
          loadedRoot = object;
          scene.add(object);
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
          const loader = new GLTFLoader();
          const gltf = await loader.loadAsync(src);
          if (disposed) return;
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
            meshes.push(mesh);
            loadedRoot = mesh;
            scene.add(mesh);
            fitCameraToObject(mesh, THREE);
          } else {
            const { STLLoader } = await loadModule(`${THREE_BASE}/examples/jsm/loaders/STLLoader`);
            const loader = new STLLoader();
            const geometry = await loader.loadAsync(src);
            if (disposed) return;
            const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
            meshes.push(mesh);
            loadedRoot = mesh;
            scene.add(mesh);
            fitCameraToObject(mesh, THREE);
          }
        } else {
          error = `Unsupported model format: .${ext || 'unknown'}`;
          return;
        }

        applyViewMode(viewMode);

        const resize = () => {
          if (!host || !renderer || !camera) return;
          const width = Math.max(host.clientWidth, 1);
          const nextHeight = fullBleed ? Math.max(host.clientHeight, 180) : Math.max(height, 180);
          renderer.setSize(width, nextHeight, false);
          camera.aspect = width / nextHeight;
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
        resizeObserver.observe(host);
        resize();
        animate();

        return () => resizeObserver.disconnect();
      } catch (e) {
        error = e instanceof Error ? e.message : 'Failed to initialize 3D viewer';
      }
    };

    let stopResizeWatch: (() => void) | undefined;
    const runStart = () => {
      if (hasStarted || loadingViewer) return;
      hasStarted = true;
      loadingViewer = true;
      start()
        .then((cleanup) => {
          if (typeof cleanup === 'function') stopResizeWatch = cleanup;
        })
        .finally(() => {
          loadingViewer = false;
        });
    };
    startViewer = runStart;

    if (!lazyLoad) {
      runStart();
    }

    return () => {
      startViewer = () => {};
      stopResizeWatch?.();
      dispose();
    };
  });
</script>

<svelte:window on:click={handleWindowClick} />

<div class="model-viewer" class:full-bleed={fullBleed} bind:this={host}>
  {#if error}
    <div class="model-error">{error}</div>
  {:else}
    <canvas bind:this={canvas} aria-label={`3D model viewer for ${fileName}`}></canvas>
    {#if !hasStarted}
      <button
        type="button"
        class="activation-overlay"
        on:click={startViewer}
      >
        <span class="activation-title">Click to load 3D preview</span>
        <span class="activation-subtitle">{fileName}</span>
      </button>
    {/if}
    {#if loadingViewer}
      <div class="loading-overlay">Loading 3D preview...</div>
    {/if}

    {#if hasStarted && !hideUi}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions: this wrapper only stops control clicks from reaching the viewport -->
    <div class="overlay-controls overlay-left" role="group" on:click|stopPropagation on:keydown|stopPropagation>
      <button
        type="button"
        class="view-btn"
        class:active={viewMode === 'textured'}
        on:click={() => setViewMode('textured')}
      >
        Textured
      </button>
      <button
        type="button"
        class="view-btn"
        class:active={viewMode === 'normal'}
        on:click={() => setViewMode('normal')}
      >
        Normal
      </button>
      <button
        type="button"
        class="view-btn"
        class:active={viewMode === 'wireframe-lines'}
        on:click={() => setViewMode('wireframe-lines')}
      >
        Wireframe Lines
      </button>
      <!-- Wireframe overlay mode intentionally disabled for now. -->
    </div>

    <!-- svelte-ignore a11y_no_noninteractive_element_interactions: this wrapper only stops control clicks from reaching the viewport -->
    <div class="overlay-controls overlay-right" role="group" on:click|stopPropagation on:keydown|stopPropagation>
      <button
        type="button"
        class="settings-fab"
        on:click={toggleHideUi}
      >
        Hide UI
      </button>
      <button
        type="button"
        class="settings-fab"
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        on:click={() => (menuOpen = !menuOpen)}
      >
        View Settings
      </button>
      {#if menuOpen}
        <div class="settings-menu" role="menu">
          <button type="button" class="menu-item" class:active={autoRotate} on:click={toggleAutoRotate}>Auto-rotate</button>
          <button type="button" class="menu-item" on:click={resetView}>Reset View</button>
      <button type="button" class="menu-item" class:active={showGrid} on:click={toggleGrid}>Grid</button>
      <button type="button" class="menu-item" class:active={showAxes} on:click={toggleAxes}>Axes</button>
      <button type="button" class="menu-item" class:active={showRig} on:click={toggleRig}>Bones / Controllers</button>
      <button type="button" class="menu-item" class:active={showDebugStats} on:click={toggleDebugStats}>Debug Stats Overlay</button>
          {#if animationClipOptions.length > 0}
            <div class="menu-section">
              <div class="menu-section-title">Animation</div>
              <label class="menu-item clip-control">
                <span>Clip</span>
                <select bind:value={selectedAnimationIndex} on:change={handleAnimationClipChange}>
                  {#each animationClipOptions as clip}
                    <option value={clip.index}>{clip.name}</option>
                  {/each}
                </select>
              </label>
              <button type="button" class="menu-item" class:active={animationPlaying} on:click={toggleAnimationPlayback}>
                {animationPlaying ? 'Pause' : 'Play'}
              </button>
              <label class="menu-item clip-control">
                <span>Loop</span>
                <select bind:value={animationLoopMode} on:change={handleAnimationLoopModeChange}>
                  <option value="repeat">Repeat</option>
                  <option value="once">Once</option>
                  <option value="pingpong">Ping Pong</option>
                </select>
              </label>
              <label class="menu-item speed-control">
                <span>Speed {animationSpeed.toFixed(1)}x</span>
                <input
                  type="range"
                  min="0.1"
                  max="2.5"
                  step="0.1"
                  value={animationSpeed}
                  on:input={handleAnimationSpeedChange}
                />
              </label>
            </div>
          {/if}
          <label class="menu-item thread-mode-control">
            <span>Threading</span>
            <select bind:value={threadMode} on:change={handleThreadModeChange}>
              <option value="auto">Auto</option>
              <option value="always">Always Multi-thread</option>
              <option value="off">Off</option>
            </select>
          </label>
        </div>
      {/if}
    </div>
    {/if}
    {#if hasStarted && hideUi}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions: this wrapper only stops control clicks from reaching the viewport -->
      <div class="overlay-controls overlay-right minimal-toggle" role="group" on:click|stopPropagation on:keydown|stopPropagation>
        <button
          type="button"
          class="settings-fab"
          on:click={toggleHideUi}
        >
          Show UI
        </button>
      </div>
    {/if}

    {#if !hideUi}
    <div class="viewer-hint">Drag to rotate, wheel to zoom, right-drag to pan</div>
    {/if}
    {#if !hideUi && threadingNotice}
      <div class="threading-note">{threadingNotice}</div>
    {/if}
    {#if !hideUi && showRig && rigStatusNote}
      <div class="rig-note">{rigStatusNote}</div>
    {/if}
    {#if !hideUi && showDebugStats && debugStats}
      <div class="debug-note">{debugStats}</div>
    {/if}
  {/if}
</div>

<style>
  .model-viewer {
    width: 100%;
    max-width: none;
    align-self: stretch;
    margin: 0;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    background: #0f1218;
    position: relative;
    justify-self: start;
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

  .activation-overlay {
    position: absolute;
    inset: 0;
    border: none;
    background:
      radial-gradient(circle at 20% 15%, rgba(120, 150, 190, 0.24), transparent 42%),
      linear-gradient(155deg, rgba(22, 28, 40, 0.9), rgba(10, 14, 22, 0.95));
    color: #e6edf5;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    cursor: pointer;
    z-index: 4;
  }

  .activation-title {
    font-size: 0.9rem;
    font-weight: 700;
  }

  .activation-subtitle {
    max-width: min(76vw, 520px);
    font-size: 0.72rem;
    color: #b8c6d4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .loading-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #dce7f2;
    font-size: 0.82rem;
    background: rgba(8, 12, 18, 0.62);
    z-index: 5;
    pointer-events: none;
  }

  .overlay-controls {
    position: absolute;
    top: 0.55rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    z-index: 3;
    pointer-events: none;
  }

  .overlay-left {
    left: 0.55rem;
    right: 8.75rem;
    max-width: none;
  }

  .overlay-right {
    right: 0.55rem;
    flex-direction: column;
    align-items: flex-end;
  }

  .overlay-right.minimal-toggle {
    top: 0.55rem;
  }

  .view-btn,
  .settings-fab,
  .menu-item {
    border: 1px solid #2d394d;
    background: rgba(15, 20, 30, 0.9);
    color: #d9e4ef;
    border-radius: 6px;
    padding: 0.22rem 0.5rem;
    font-size: 0.72rem;
    cursor: pointer;
    white-space: nowrap;
    pointer-events: auto;
  }

  .view-btn.active,
  .menu-item.active,
  .settings-fab[aria-expanded="true"] {
    background: #1b2d45;
    border-color: #3f5f8a;
  }

  .settings-menu {
    margin-top: 0.3rem;
    width: 220px;
    padding: 0.45rem;
    border-radius: 8px;
    border: 1px solid #31445d;
    background: rgba(10, 14, 22, 0.96);
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    backdrop-filter: blur(5px);
    pointer-events: auto;
  }

  .menu-item {
    text-align: left;
  }

  .thread-mode-control {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .menu-section {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    border-top: 1px solid rgba(82, 108, 141, 0.4);
    padding-top: 0.35rem;
  }

  .menu-section-title {
    color: #9bb5d0;
    font-size: 0.66rem;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    padding: 0 0.2rem;
  }

  .clip-control {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .clip-control select {
    border: 1px solid #2d394d;
    background: #0f141d;
    color: #d9e4ef;
    border-radius: 5px;
    padding: 0.12rem 0.35rem;
    font-size: 0.72rem;
    width: 132px;
  }

  .speed-control {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.35rem;
  }

  .speed-control input[type='range'] {
    width: 100%;
    accent-color: #5c8fcb;
  }

  .thread-mode-control select {
    border: 1px solid #2d394d;
    background: #0f141d;
    color: #d9e4ef;
    border-radius: 5px;
    padding: 0.12rem 0.35rem;
    font-size: 0.72rem;
    width: 132px;
  }

  .viewer-hint {
    position: absolute;
    left: 0.55rem;
    bottom: 0.55rem;
    color: #d8e3ef;
    background: rgba(15, 20, 30, 0.3);
    border: 1px solid rgba(62, 79, 102, 0.3);
    border-radius: 6px;
    padding: 0.22rem 0.45rem;
    font-size: 0.7rem;
    z-index: 2;
    pointer-events: none;
    opacity: 0.3;
  }

  .threading-note {
    position: absolute;
    right: 0.55rem;
    bottom: 0.55rem;
    max-width: min(46vw, 460px);
    color: #b8cbde;
    background: rgba(15, 20, 30, 0.84);
    border: 1px solid rgba(62, 79, 102, 0.85);
    border-radius: 6px;
    padding: 0.22rem 0.45rem;
    font-size: 0.68rem;
    z-index: 2;
  }

  .debug-note {
    position: absolute;
    left: 0.55rem;
    bottom: 2.15rem;
    max-width: min(86vw, 760px);
    color: #d8f1ff;
    background: rgba(6, 22, 35, 0.88);
    border: 1px solid rgba(82, 153, 204, 0.72);
    border-radius: 6px;
    padding: 0.22rem 0.45rem;
    font-size: 0.67rem;
    z-index: 2;
    pointer-events: none;
  }

  .rig-note {
    position: absolute;
    right: 0.55rem;
    bottom: 2.35rem;
    max-width: min(46vw, 460px);
    color: #e9f7ff;
    background: rgba(9, 19, 30, 0.9);
    border: 1px solid rgba(93, 140, 190, 0.85);
    border-radius: 6px;
    padding: 0.22rem 0.45rem;
    font-size: 0.67rem;
    z-index: 2;
    pointer-events: none;
  }

  .model-error {
    color: #ffd4d4;
    font-size: 0.82rem;
    padding: 0.6rem 0.75rem;
    background: #2a1010;
  }

  @media (max-width: 768px) {
    .settings-menu {
      width: 200px;
    }

    .overlay-left {
      right: 7.9rem;
      max-width: none;
    }

    .view-btn,
    .settings-fab,
    .menu-item {
      font-size: 0.68rem;
    }
  }
</style>
