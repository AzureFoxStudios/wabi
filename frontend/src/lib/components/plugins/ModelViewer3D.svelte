<script lang="ts">
  import { onMount } from 'svelte';
  import ModelViewerShell from './ModelViewerShell.svelte';
  import ModelViewerSettingsMenu from './ModelViewerSettingsMenu.svelte';
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

  export let src: string;
  export let fileName = '3D model';
  export let height = 320;
  export let fullBleed = false;
  export let lazyLoad = true;
  export let hideUi = false;

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
      disposed = true;
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

<ModelViewerShell
  {viewMode}
  {hideUi}
  {loadingViewer}
  {hasStarted}
  {fileName}
  {error}
  {fullBleed}
  bind:host
  onStartViewer={startViewer}
  onViewModeChange={setViewMode}
  onToggleHideUi={toggleHideUi}
>
  <canvas slot="canvas" bind:this={canvas} aria-label={`3D model viewer for ${fileName}`}></canvas>

  <svelte:fragment slot="settings-menu">
    <ModelViewerSettingsMenu
      bind:menuOpen
      {autoRotate}
      {showGrid}
      {showAxes}
      {showRig}
      {showDebugStats}
      {animationClipOptions}
      bind:selectedAnimationIndex
      {animationPlaying}
      {animationSpeed}
      bind:animationLoopMode
      bind:threadMode
      onToggleAutoRotate={toggleAutoRotate}
      onResetView={resetView}
      onToggleGrid={toggleGrid}
      onToggleAxes={toggleAxes}
      onToggleRig={toggleRig}
      onToggleDebugStats={toggleDebugStats}
      onAnimationClipChange={handleAnimationClipChange}
      onToggleAnimationPlayback={toggleAnimationPlayback}
      onAnimationLoopModeChange={handleAnimationLoopModeChange}
      onAnimationSpeedChange={handleAnimationSpeedChange}
      onThreadModeChange={handleThreadModeChange}
    />
  </svelte:fragment>

  <svelte:fragment slot="notes">
    {#if !hideUi && threadingNotice}
      <div class="threading-note">{threadingNotice}</div>
    {/if}
    {#if !hideUi && showRig && rigStatusNote}
      <div class="rig-note">{rigStatusNote}</div>
    {/if}
    {#if !hideUi && showDebugStats && debugStats}
      <div class="debug-note">{debugStats}</div>
    {/if}
  </svelte:fragment>
</ModelViewerShell>
