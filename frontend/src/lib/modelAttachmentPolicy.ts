/** File recognition and navigation decisions only. No downloads or renderer imports. */
export type ModelFamily = 'mesh' | 'cad' | 'mmd' | 'unknown';
export type CadDimension = '2d' | '3d' | null;
export type ModelPreviewKind = 'mesh-3d' | 'cad-2d' | 'cad-3d' | null;
export type ModelSource = 'chat' | 'local-temp';
export interface ModelAsset { src: string; fileName: string; source?: ModelSource }
export type ModelDestination =
  | { kind: 'workspace' }
  | { kind: 'dock' };

export type CadImporterKind = 'builtin-dxf' | 'browser-3mf' | 'occt-wasm' | 'server-convert' | 'unavailable';
export interface CadImportPlan {
  preferred: CadImporterKind;
  fallback: CadImporterKind | null;
  canonicalPreview: 'dxf' | 'glb' | null;
  availableNow: boolean;
}

const MESH = new Set(['glb', 'gltf', 'obj', 'stl']);
const CAD_2D = new Set(['dxf', 'dwg']);
const CAD_3D = new Set(['step', 'stp', 'iges', 'igs', '3mf']);
const CAD = new Set([...CAD_2D, ...CAD_3D]);
const MMD = new Set(['pmx', 'pmd', 'vmd', 'vpd']);

export function modelExtension(value: string | undefined): string {
  if (typeof value !== 'string' || !value) return '';
  let name = value;
  try { name = new URL(value).pathname; } catch { name = value.split(/[?#]/, 1)[0]; }
  try { name = decodeURIComponent(name); } catch { /* Preserve malformed literal filename. */ }
  const leaf = name.split(/[\\/]/).pop() || '';
  const dot = leaf.lastIndexOf('.');
  return dot > -1 ? leaf.slice(dot + 1).toLowerCase() : '';
}
export function modelFamily(name: string | undefined): ModelFamily {
  const ext = modelExtension(name);
  return MESH.has(ext) ? 'mesh' : CAD.has(ext) ? 'cad' : MMD.has(ext) ? 'mmd' : 'unknown';
}
export function isModelAttachmentFile(name: string | undefined): boolean { return modelFamily(name) !== 'unknown'; }
export function cadDimension(name: string | undefined): CadDimension {
  const ext = modelExtension(name);
  return CAD_2D.has(ext) ? '2d' : CAD_3D.has(ext) ? '3d' : null;
}

/**
 * One routing table for Wabi's hybrid CAD strategy. Importers may execute in
 * the browser, desktop helper or server, but every path converges on a viewer
 * Wabi already owns instead of teaching each renderer every source format.
 */
export function cadImportPlan(name: string | undefined): CadImportPlan {
  const ext = modelExtension(name);
  if (ext === 'dxf') return { preferred: 'builtin-dxf', fallback: null, canonicalPreview: 'dxf', availableNow: true };
  if (ext === '3mf') return { preferred: 'browser-3mf', fallback: 'server-convert', canonicalPreview: 'glb', availableNow: true };
  if (ext === 'dwg') return { preferred: 'server-convert', fallback: null, canonicalPreview: 'dxf', availableNow: false };
  if (['step', 'stp', 'iges', 'igs'].includes(ext)) return { preferred: 'occt-wasm', fallback: 'server-convert', canonicalPreview: 'glb', availableNow: false };
  return { preferred: 'unavailable', fallback: null, canonicalPreview: null, availableNow: false };
}

export function modelPreviewKind(name: string | undefined): ModelPreviewKind {
  const ext = modelExtension(name);
  if (MESH.has(ext)) return 'mesh-3d';
  const plan = cadImportPlan(name);
  if (plan.availableNow && plan.preferred === 'builtin-dxf') return 'cad-2d';
  if (plan.availableNow && plan.preferred === 'browser-3mf') return 'cad-3d';
  return null;
}
export function modelWorkspaceLabel(name: string | undefined): string {
  return modelFamily(name) === 'cad' ? 'Open CAD workspace' : 'Open model workspace';
}
export function modelFileNameFromUrl(src: string): string {
  try {
    const leaf = new URL(src).pathname.split('/').filter(Boolean).pop() || '3D model';
    try { return decodeURIComponent(leaf); } catch { return leaf; }
  } catch { return '3D model'; }
}
export function safeModelSource(src: string): string | null {
  if (typeof src !== 'string' || !src.trim()) return null;
  try {
    const url = new URL(src);
    if (!['https:', 'http:', 'blob:'].includes(url.protocol) || url.username || url.password) return null;
    // Keep the original string: signed/query-bearing attachment URLs must not be rebuilt.
    return src;
  } catch { return null; }
}
export function missingModelSupport(name: string): string | null {
  const family = modelFamily(name);
  const ext = modelExtension(name);
  const plan = cadImportPlan(name);
  if (family === 'mesh' || plan.availableNow) return null;
  if (ext === 'dwg') return 'DWG is recognized as 2D CAD. Its import plan is server conversion to ASCII DXF; this server does not have that converter enabled yet.';
  if (family === 'cad' && cadDimension(name) === '3d') return 'This 3D CAD/manufacturing file is routed to the OpenCascade importer with server conversion as fallback. That adapter is not enabled in this build yet.';
  if (family === 'cad') return 'This CAD file needs a compatible importer. ASCII DXF is the built-in 2D format in this build.';
  if (family === 'mmd') return 'This file needs an MMD adapter. The current viewer does not decode MMD models or motion files.';
  return 'No compatible model or CAD importer is available for this file.';
}

/** Small ports keep the decisions testable without booting chat, WebRTC or a renderer. */
export interface ModelNavigationPorts {
  isMobile(): boolean;
  select(asset: ModelAsset): void;
  showWorkspace(): void;
  showDock(): void;
  stopInline(): void;
}
export function routeModelAsset(asset: ModelAsset, target: ModelDestination, ports: ModelNavigationPorts): void {
  if (!safeModelSource(asset.src) || typeof asset.fileName !== 'string' || !asset.fileName.trim()) throw new Error('This model attachment does not have a valid source.');
  // File actions never switch the user's saved Wabi layout. Reject stale callers
  // as well as invalid destinations before changing selection or renderer ownership.
  if (target.kind !== 'workspace' && target.kind !== 'dock') throw new Error('Unknown model destination.');
  if (target.kind === 'dock' && ports.isMobile()) throw new Error('Side docking is unavailable on this screen. Open the model workspace instead.');
  ports.stopInline();
  ports.select(asset);
  if (target.kind === 'dock') ports.showDock(); else ports.showWorkspace();
}
export function clampModelMenu(x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number): { left: number; top: number } {
  const pad = 8;
  const right = Math.max(pad, viewportWidth - width - pad);
  const bottom = Math.max(pad, viewportHeight - height - pad);
  return { left: Math.max(pad, Math.min(Number.isFinite(x) ? x : pad, right)), top: Math.max(pad, Math.min(Number.isFinite(y) ? y : pad, bottom)) };
}

/** Keep Tab navigation within the action popup, skipping disabled actions. */
export function trapModelMenuTab(event: KeyboardEvent, container: HTMLElement): void {
  if (event.key !== 'Tab') return;
  const items = Array.from(container.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), a[href]'))
    .filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
  if (items.length === 0) { event.preventDefault(); container.focus(); return; }
  const first = items[0], last = items[items.length - 1];
  const active = container.ownerDocument.activeElement;
  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && (active === last || !container.contains(active))) {
    event.preventDefault(); first.focus();
  }
}
