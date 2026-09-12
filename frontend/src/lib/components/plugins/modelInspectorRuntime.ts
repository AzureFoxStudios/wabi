import {
  distanceBetween, effectivelyVisible, finitePoint, frameDistance, sectionCoordinate, triangleEstimate,
  VIEW_DIRECTIONS, type InspectorSnapshot, type ModelView, type SectionAxis
} from './modelInspector';

/** Three is injected by the EXISTING viewer; this module never fetches files, code, or credentials. */
export interface ModelInspectorOptions {
  THREE: any;
  root: any;
  scene: any;
  camera: any;
  controls: any;
  renderer: any;
  canvas: HTMLCanvasElement;
  onChange: (snapshot: InspectorSnapshot) => void;
  onInspect: () => void;
}
export interface ModelInspectorRuntime {
  select: (id: string | null) => void;
  toggleVisibility: (id: string) => void;
  isolate: () => void;
  restoreVisibility: () => void;
  setView: (view: ModelView) => void;
  fit: () => void;
  refresh: () => void;
  setMeasuring: (enabled: boolean) => void;
  clearMeasurement: () => void;
  setSection: (axis: SectionAxis, percent: number, flipped: boolean) => void;
  reset: () => void;
  dispose: () => void;
}

export function createModelInspectorRuntime(options: ModelInspectorOptions): ModelInspectorRuntime {
  const { THREE, root, scene, camera, controls, renderer, canvas, onChange, onInspect } = options;
  const objects: any[] = [];
  const originalVisibility = new Map<any, boolean>();
  root.traverse((object: any) => {
    originalVisibility.set(object, object.visible);
    if (object.isMesh) objects.push(object);
  });
  const byId = new Map<string, any>(objects.map((object, i) => [String(i), object]));
  const ids = new Map<any, string>([...byId].map(([id, object]) => [object, id]));
  const priorClipping = renderer.clippingPlanes;
  const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
  const selection = new THREE.Box3Helper(new THREE.Box3(), 0x80cbbd);
  selection.visible = false;
  scene.add(selection);
  let selectedId: string | null = null;
  let measuring = false;
  let points: any[] = [];
  let markers: any[] = [];
  let sectionAxis: SectionAxis = 'off';
  let sectionPercent = 50;
  let sectionFlipped = false;
  let disposed = false;
  let pointerStart: { id: number; x: number; y: number } | null = null;
  const activePointers = new Set<number>();
  let multiPointerGesture = false;

  const focusObject = () => (selectedId !== null ? byId.get(selectedId) : root) || root;
  const boundsOf = (object: any) => {
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object, true);
    if (box.isEmpty() || !finitePoint(box.min) || !finitePoint(box.max)) return null;
    return box;
  };
  function emit(): void {
    if (disposed) return;
    const bounds = boundsOf(focusObject());
    const dimensions = bounds?.getSize(new THREE.Vector3()) || null;
    if (selectedId !== null && bounds && effectivelyVisible(focusObject())) {
      selection.box.copy(bounds);
      selection.visible = true;
    } else selection.visible = false;
    onChange({
      meshes: [...byId].map(([id, object]) => ({
        id, name: object.name?.trim() || `Mesh ${Number(id) + 1}`, visible: effectivelyVisible(object),
        triangles: triangleEstimate(object.geometry?.index?.count, object.geometry?.attributes?.position?.count, object.isInstancedMesh ? object.count : 1)
      })),
      selectedId, dimensions: dimensions && finitePoint(dimensions) ? { x: dimensions.x, y: dimensions.y, z: dimensions.z } : null,
      measurePoints: points.length, distance: points.length === 2 ? distanceBetween(points[0], points[1]) : null,
      measuring, sectionAxis, sectionPercent, sectionFlipped
    });
  }
  function clearMarkers(): void {
    for (const marker of markers) {
      scene.remove(marker);
      marker.geometry?.dispose();
      const materials = Array.isArray(marker.material) ? marker.material : [marker.material];
      for (const material of materials) material?.dispose();
    }
    markers = [];
  }
  function clearMeasurement(): void { points = []; clearMarkers(); emit(); }
  function drawMeasurement(): void {
    clearMarkers();
    const bounds = boundsOf(root);
    const size = bounds?.getSize(new THREE.Vector3());
    const radius = Math.max(size ? size.length() * 0.004 : 0.01, 1e-6);
    for (const point of points) {
      const marker = new THREE.Mesh(new THREE.SphereGeometry(radius, 10, 8), new THREE.MeshBasicMaterial({ color: 0xf1ca82, depthTest: false }));
      marker.position.copy(point);
      marker.renderOrder = 1700;
      markers.push(marker);
      scene.add(marker);
    }
    if (points.length === 2) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0xf1ca82, depthTest: false }));
      line.renderOrder = 1700;
      markers.push(line);
      scene.add(line);
    }
  }
  function frame(view?: ModelView): void {
    if (disposed) return;
    const box = boundsOf(focusObject());
    if (!box) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const distance = frameDistance(size, camera.fov, camera.aspect);
    if (distance === null) return;
    const direction = view ? new THREE.Vector3(VIEW_DIRECTIONS[view].x, VIEW_DIRECTIONS[view].y, VIEW_DIRECTIONS[view].z)
      : camera.position.clone().sub(controls.target);
    if (direction.lengthSq() < 1e-12) direction.set(1, 0.65, 1);
    direction.normalize();
    onInspect();
    // OrbitControls caches the camera-up quaternion; keep Y-up stable and offset pole views slightly.
    if (Math.abs(direction.y) > 0.99999) direction.z = view === 'bottom' ? 0.00001 : -0.00001;
    direction.normalize();
    const damping = controls.enableDamping;
    controls.enableDamping = false;
    controls.update();
    camera.position.copy(center).addScaledVector(direction, distance);
    const radius = Math.max(size.length() / 2, 1e-6);
    camera.near = Math.max(radius / 1000, 1e-7);
    camera.far = Math.max(distance + radius * 100, camera.near * 1000);
    camera.updateProjectionMatrix();
    controls.minDistance = Math.max(radius / 100, 1e-7);
    controls.maxDistance = Math.max(distance * 50, radius * 100);
    controls.target.copy(center);
    controls.update();
    controls.enableDamping = damping;
    emit();
  }
  function setSection(axis: SectionAxis, percent: number, flipped: boolean): void {
    if (disposed || !['off', 'x', 'y', 'z'].includes(axis) || !Number.isFinite(percent)) return;
    onInspect();
    sectionAxis = axis;
    sectionPercent = Math.max(0, Math.min(100, percent));
    sectionFlipped = flipped;
    points = [];
    clearMarkers();
    if (axis === 'off') renderer.clippingPlanes = priorClipping;
    else {
      const box = boundsOf(root);
      const coordinate = box ? sectionCoordinate(box.min[axis], box.max[axis], sectionPercent) : null;
      if (coordinate === null) { sectionAxis = 'off'; renderer.clippingPlanes = priorClipping; emit(); return; }
      const sign = flipped ? 1 : -1;
      plane.normal.set(axis === 'x' ? sign : 0, axis === 'y' ? sign : 0, axis === 'z' ? sign : 0);
      plane.constant = -sign * coordinate;
      renderer.clippingPlanes = [...(priorClipping || []), plane];
    }
    emit();
  }
  function select(id: string | null): void {
    if (disposed || (id !== null && !byId.has(id))) return;
    onInspect(); selectedId = id; emit();
  }
  function revealParents(object: any): void {
    for (let node = object; node && node !== root.parent; node = node.parent) node.visible = true;
  }
  function isRelated(object: any, selected: any): boolean {
    for (let node = object; node; node = node.parent) if (node === selected) return true;
    for (let node = selected; node; node = node.parent) if (node === object) return true;
    return false;
  }
  function toggleVisibility(id: string): void {
    const object = byId.get(id);
    if (disposed || !object) return;
    onInspect();
    if (effectivelyVisible(object)) object.visible = false;
    else revealParents(object);
    clearMeasurement();
  }
  function isolate(): void {
    const selected = selectedId === null ? null : byId.get(selectedId);
    if (disposed || !selected) return;
    onInspect();
    for (const object of objects) object.visible = isRelated(object, selected);
    revealParents(selected);
    clearMeasurement();
  }
  function restoreVisibility(): void {
    if (disposed) return;
    for (const [object, visible] of originalVisibility) object.visible = visible;
    clearMeasurement();
  }
  function pointerDown(event: PointerEvent): void {
    activePointers.add(event.pointerId);
    if (activePointers.size > 1) { multiPointerGesture = true; pointerStart = null; return; }
    if (event.button !== 0) return;
    pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
  }
  function pointerUp(event: PointerEvent): void {
    const start = pointerStart;
    const wasMulti = multiPointerGesture;
    activePointers.delete(event.pointerId);
    if (!activePointers.size) multiPointerGesture = false;
    pointerStart = null;
    if (disposed || wasMulti || !start || start.id !== event.pointerId || event.button !== 0 || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    // Pause animation BEFORE computing matrices/raycast; markers are pose snapshots, not bone anchors.
    onInspect();
    root.updateMatrixWorld(true); camera.updateMatrixWorld(true);
    const pointer = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(objects.filter(effectivelyVisible), false);
    const hit = hits.find((candidate: any) => finitePoint(candidate.point) &&
      (renderer.clippingPlanes || []).every((clip: any) => clip.distanceToPoint(candidate.point) >= -1e-8));
    if (!hit) { if (!measuring) select(null); return; }
    if (measuring) {
      if (points.length >= 2) points = [];
      points.push(hit.point.clone());
      drawMeasurement(); emit();
    } else select(ids.get(hit.object) ?? null);
  }
  function pointerCancel(): void { pointerStart = null; activePointers.clear(); multiPointerGesture = false; }
  canvas.addEventListener('pointerdown', pointerDown);
  canvas.addEventListener('pointerup', pointerUp);
  canvas.addEventListener('pointercancel', pointerCancel);
  canvas.addEventListener('pointerleave', pointerCancel);
  emit();
  return {
    select, toggleVisibility, isolate, restoreVisibility, setView: (view) => { if (Object.hasOwn(VIEW_DIRECTIONS, view)) frame(view); },
    fit: () => frame(), refresh: () => { if (!disposed) { onInspect(); clearMeasurement(); } },
    setMeasuring: (enabled) => { if (!disposed) { onInspect(); measuring = enabled; clearMeasurement(); } },
    clearMeasurement, setSection,
    reset: () => { if (!disposed) { selectedId = null; measuring = false; restoreVisibility(); setSection('off', 50, false); frame('iso'); } },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener('pointerdown', pointerDown);
      canvas.removeEventListener('pointerup', pointerUp);
      canvas.removeEventListener('pointercancel', pointerCancel);
      canvas.removeEventListener('pointerleave', pointerCancel);
      clearMarkers();
      scene.remove(selection); selection.geometry?.dispose(); selection.material?.dispose();
      renderer.clippingPlanes = priorClipping;
      for (const [object, visible] of originalVisibility) object.visible = visible;
    }
  };
}
