/** Pure, renderer-independent helpers. Measurements describe display meshes, not CAD tolerances. */
export type ModelUnit = 'model' | 'mm' | 'cm' | 'm' | 'in';
export type ModelView = 'iso' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';
export type SectionAxis = 'off' | 'x' | 'y' | 'z';
export type Point3 = { x: number; y: number; z: number };
export interface MeshEntry { id: string; name: string; visible: boolean; triangles: number; }
export interface InspectorSnapshot {
  meshes: MeshEntry[];
  selectedId: string | null;
  dimensions: Point3 | null;
  measurePoints: number;
  distance: number | null;
  measuring: boolean;
  sectionAxis: SectionAxis;
  sectionPercent: number;
  sectionFlipped: boolean;
}
export const EMPTY_INSPECTOR: InspectorSnapshot = {
  meshes: [], selectedId: null, dimensions: null, measurePoints: 0, distance: null,
  measuring: false, sectionAxis: 'off', sectionPercent: 50, sectionFlipped: false
};
const METERS: Record<Exclude<ModelUnit, 'model'>, number> = { mm: 0.001, cm: 0.01, m: 1, in: 0.0254 };
export const MODEL_UNITS: ModelUnit[] = ['model', 'mm', 'cm', 'm', 'in'];
export function isModelUnit(value: unknown): value is ModelUnit {
  return typeof value === 'string' && MODEL_UNITS.includes(value as ModelUnit);
}
export function extensionOf(name: string): string {
  return name.trim().split(/[?#]/, 1)[0].split('.').pop()?.toLowerCase() || '';
}
/** Do not guess units for OBJ/STL. The user declares the source scale explicitly. */
export function defaultSourceUnit(_fileName: string): ModelUnit { return 'model'; }
export function modelFormatMessage(name: string): string | null {
  const ext = extensionOf(name);
  if (['glb', 'gltf', 'obj', 'stl'].includes(ext)) return null;
  if (['step', 'stp', 'iges', 'igs', '3mf', 'dxf', 'dwg'].includes(ext)) {
    return `${ext.toUpperCase()} import needs a dedicated CAD adapter that is not available in this browser viewer. Export GLB, OBJ or STL for read-only mesh inspection. The original file is unchanged.`;
  }
  if (['pmx', 'pmd', 'vmd', 'vpd'].includes(ext)) {
    return 'This file needs an MMD adapter. The current browser viewer supports GLB, glTF, OBJ and STL; it does not decode MMD models or motions.';
  }
  return 'This browser viewer supports GLB, glTF, OBJ and STL. No compatible importer is available for this file.';
}
export function finitePoint(p: Point3): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}
export function distanceBetween(a: Point3, b: Point3): number | null {
  if (!finitePoint(a) || !finitePoint(b)) return null;
  const distance = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  return Number.isFinite(distance) ? distance : null;
}
export function convertLength(value: number, source: ModelUnit, target: ModelUnit): number | null {
  if (!Number.isFinite(value) || value < 0 || !isModelUnit(source) || !isModelUnit(target)) return null;
  // Unknown coordinate units must never be presented as a physical length.
  if (source === 'model' || target === 'model') return source === target ? value : null;
  const converted = value * METERS[source] / METERS[target];
  return Number.isFinite(converted) ? converted : null;
}
export function formatLength(value: number | null, source: ModelUnit, target: ModelUnit): string {
  if (value === null) return '—';
  const converted = convertLength(value, source, target);
  if (converted === null) return '—';
  const number = converted !== 0 && (converted < 0.001 || converted >= 1e9)
    ? converted.toExponential(3)
    : converted.toLocaleString('en-US', { maximumFractionDigits: 3 });
  return `${number} ${target === 'model' ? 'units' : target}`;
}
export function frameDistance(size: Point3, verticalFovDegrees: number, aspect: number): number | null {
  if (!finitePoint(size) || Math.min(size.x, size.y, size.z) < 0 || !Number.isFinite(aspect) || aspect <= 0 ||
      !Number.isFinite(verticalFovDegrees) || verticalFovDegrees <= 0 || verticalFovDegrees >= 180) return null;
  const radius = Math.max(Math.hypot(size.x, size.y, size.z) / 2, 1e-6);
  const vertical = verticalFovDegrees * Math.PI / 360;
  const horizontal = Math.atan(Math.tan(vertical) * aspect);
  const distance = radius / Math.sin(Math.min(vertical, horizontal)) * 1.15;
  return Number.isFinite(distance) ? distance : null;
}
export function sectionCoordinate(min: number, max: number, percent: number): number | null {
  if (![min, max, percent].every(Number.isFinite) || max < min) return null;
  const clamped = Math.max(0, Math.min(100, percent)) / 100;
  const coordinate = min * (1 - clamped) + max * clamped;
  return Number.isFinite(coordinate) ? coordinate : null;
}
export function triangleEstimate(indexCount: number | undefined, vertexCount: number | undefined, instances = 1): number {
  const count = indexCount ?? vertexCount ?? 0;
  if (!Number.isFinite(count) || !Number.isFinite(instances) || count < 0 || instances < 0) return 0;
  return Math.floor(count / 3) * Math.floor(instances);
}
export function effectivelyVisible(object: { visible?: boolean; parent?: any }): boolean {
  const visited = new Set<unknown>();
  for (let node: any = object; node; node = node.parent) {
    if (visited.has(node) || node.visible === false) return false;
    visited.add(node);
  }
  return true;
}
export const VIEW_DIRECTIONS: Record<ModelView, Point3> = {
  iso: { x: 1, y: 0.65, z: 1 }, front: { x: 0, y: 0, z: 1 }, back: { x: 0, y: 0, z: -1 },
  left: { x: -1, y: 0, z: 0 }, right: { x: 1, y: 0, z: 0 }, top: { x: 0, y: 1, z: 0 }, bottom: { x: 0, y: -1, z: 0 }
};
