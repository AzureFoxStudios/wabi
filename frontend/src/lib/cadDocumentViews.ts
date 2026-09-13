export type CadDocumentViewKind = 'model' | 'layout';
export type CadModelDimensionality = '2d' | '3d' | 'mixed' | 'unknown';

export interface CadDocumentViewSlice {
  id: string;
  name: string;
  kind: CadDocumentViewKind;
  entityCount: number;
  previewable2d: boolean;
  hasSpatialEntities: boolean;
  spatialEntityTypes: string[];
  text: string;
}

export interface CadDocumentViews {
  views: CadDocumentViewSlice[];
  modelDimensionality: CadModelDimensionality;
  hasSpatialModel: boolean;
  spatialEntityTypes: string[];
}

interface DxfPair {
  code: number;
  value: string;
  codeLine: string;
}

interface EntityChunk {
  type: string;
  pairs: DxfPair[];
}

interface LogicalEntity {
  type: string;
  chunks: EntityChunk[];
}

const TWO_D_PREVIEW_TYPES = new Set([
  'LINE', 'LWPOLYLINE', 'POLYLINE', 'CIRCLE', 'ARC', 'POINT', 'TEXT', 'MTEXT', 'DIMENSION'
]);

// These entity families carry actual spatial/model information that the current
// 2D SVG reader must not silently present as a complete representation.
const SPATIAL_TYPES = new Set([
  '3DFACE', '3DSOLID', 'BODY', 'REGION', 'SURFACE', 'PLANESURFACE', 'EXTRUDEDSURFACE',
  'LOFTEDSURFACE', 'REVOLVEDSURFACE', 'SWEPTSURFACE', 'MESH', 'HELIX', 'POLYLINE_3D',
  'POLYFACE', 'POLYGONMESH'
]);

function parsePairs(text: string): DxfPair[] {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const pairs: DxfPair[] = [];
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const codeLine = lines[index];
    const code = Number.parseInt(codeLine.trim(), 10);
    if (!Number.isFinite(code)) continue;
    pairs.push({ code, value: lines[index + 1], codeLine });
  }
  return pairs;
}

function renderPairs(pairs: DxfPair[]): string {
  return `${pairs.map((pair) => `${pair.codeLine}\n${pair.value}`).join('\n')}\n`;
}

function first(pairs: DxfPair[], code: number): string | undefined {
  return pairs.find((pair) => pair.code === code)?.value;
}

function firstNumber(pairs: DxfPair[], code: number): number | null {
  const value = first(pairs, code);
  if (value == null) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function entityChunks(pairs: DxfPair[]): EntityChunk[] {
  const chunks: EntityChunk[] = [];
  let current: EntityChunk | null = null;
  for (const pair of pairs) {
    if (pair.code === 0) {
      if (current) chunks.push(current);
      current = { type: pair.value.trim().toUpperCase(), pairs: [pair] };
    } else if (current) {
      current.pairs.push(pair);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function logicalEntities(chunks: EntityChunk[]): LogicalEntity[] {
  const entities: LogicalEntity[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const root = chunks[index];
    const group: EntityChunk[] = [root];
    const hasFollowers = root.type === 'POLYLINE' ||
      (root.type === 'INSERT' && (firstNumber(root.pairs, 66) ?? 0) === 1);
    if (hasFollowers) {
      for (let cursor = index + 1; cursor < chunks.length; cursor += 1) {
        const next = chunks[cursor];
        group.push(next);
        index = cursor;
        if (next.type === 'SEQEND') break;
        if (root.type === 'POLYLINE' && next.type !== 'VERTEX') break;
        if (root.type === 'INSERT' && next.type !== 'ATTRIB') break;
      }
    }
    entities.push({ type: root.type, chunks: group });
  }
  return entities;
}

function entityPairs(entity: LogicalEntity): DxfPair[] {
  return entity.chunks.flatMap((chunk) => chunk.pairs);
}

function entityView(entity: LogicalEntity): { kind: CadDocumentViewKind; name: string } {
  const pairs = entity.chunks[0]?.pairs ?? [];
  const layout = first(pairs, 410)?.trim();
  const paperFlag = firstNumber(pairs, 67) === 1;
  if (paperFlag || (layout && layout.toUpperCase() !== 'MODEL')) {
    return { kind: 'layout', name: layout && layout.toUpperCase() !== 'MODEL' ? layout : 'Paper Space' };
  }
  return { kind: 'model', name: 'Model' };
}

function polylineIsSpatial(entity: LogicalEntity): boolean {
  if (entity.type !== 'POLYLINE') return false;
  const flags = firstNumber(entity.chunks[0]?.pairs ?? [], 70) ?? 0;
  // DXF POLYLINE flags: 8 = 3D polyline, 16 = polygon mesh, 64 = polyface mesh.
  return (flags & 8) !== 0 || (flags & 16) !== 0 || (flags & 64) !== 0;
}

function hasNonZeroZ(entity: LogicalEntity): boolean {
  for (const pair of entityPairs(entity)) {
    if (pair.code < 30 || pair.code > 39) continue;
    const value = Number(pair.value.trim());
    if (Number.isFinite(value) && Math.abs(value) > 1e-9) return true;
  }
  return false;
}

function spatialTypes(entity: LogicalEntity): string[] {
  const types = new Set<string>();
  if (SPATIAL_TYPES.has(entity.type)) types.add(entity.type);
  if (polylineIsSpatial(entity)) {
    const flags = firstNumber(entity.chunks[0]?.pairs ?? [], 70) ?? 0;
    if ((flags & 64) !== 0) types.add('POLYFACE');
    else if ((flags & 16) !== 0) types.add('POLYGONMESH');
    else types.add('POLYLINE_3D');
  }
  if (hasNonZeroZ(entity)) types.add(entity.type === 'LINE' ? '3D_LINE' : 'Z_GEOMETRY');
  return [...types];
}

function stableLayoutId(name: string, ordinal: number): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || `paper-${ordinal}`;
  return `layout:${slug}`;
}

function findEntitiesSection(pairs: DxfPair[]): { contentStart: number; end: number } | null {
  for (let index = 0; index + 1 < pairs.length; index += 1) {
    if (pairs[index].code !== 0 || pairs[index].value.trim().toUpperCase() !== 'SECTION') continue;
    if (pairs[index + 1].code !== 2 || pairs[index + 1].value.trim().toUpperCase() !== 'ENTITIES') continue;
    for (let cursor = index + 2; cursor < pairs.length; cursor += 1) {
      if (pairs[cursor].code === 0 && pairs[cursor].value.trim().toUpperCase() === 'ENDSEC') {
        return { contentStart: index + 2, end: cursor };
      }
    }
  }
  return null;
}

/**
 * Split an ASCII DXF into the document views AutoCAD users actually work with:
 * Model Space plus each named Paper Space layout. Each slice remains a complete
 * DXF document so Wabi can reuse its existing, battle-tested 2D viewer.
 *
 * The inspection also calls out spatial model content (non-zero Z, 3DFACE,
 * 3DSOLID, 3D/polyface POLYLINE, surfaces, meshes, etc.) so the UI never
 * mistakes a 2D projection for the whole CAD model.
 */
export function inspectCadDocumentViews(text: string): CadDocumentViews {
  if (typeof text !== 'string' || !text.trim()) throw new Error('CAD document is empty.');
  if (/AutoCAD Binary DXF/i.test(text.slice(0, 128))) throw new Error('Binary DXF cannot be split into document views yet.');
  const pairs = parsePairs(text);
  if (pairs.length < 2) throw new Error('This does not look like an ASCII DXF document.');
  const range = findEntitiesSection(pairs);
  if (!range) throw new Error('DXF has no readable ENTITIES section.');

  const prefix = pairs.slice(0, range.contentStart);
  const suffix = pairs.slice(range.end);
  const entities = logicalEntities(entityChunks(pairs.slice(range.contentStart, range.end)));
  if (entities.length === 0) throw new Error('DXF has no entities to display.');

  const groups = new Map<string, { kind: CadDocumentViewKind; name: string; entities: LogicalEntity[] }>();
  for (const entity of entities) {
    const view = entityView(entity);
    const key = view.kind === 'model' ? 'model' : `layout:${view.name}`;
    const group = groups.get(key) ?? { ...view, entities: [] };
    group.entities.push(entity);
    groups.set(key, group);
  }

  const model = groups.get('model');
  const ordered = [
    ...(model ? [model] : []),
    ...[...groups.entries()].filter(([key]) => key !== 'model').map(([, value]) => value)
  ];

  const usedIds = new Set<string>();
  let layoutOrdinal = 0;
  const views: CadDocumentViewSlice[] = ordered.map((group) => {
    if (group.kind === 'layout') layoutOrdinal += 1;
    let id = group.kind === 'model' ? 'model' : stableLayoutId(group.name, layoutOrdinal);
    if (usedIds.has(id)) {
      let duplicate = 2;
      while (usedIds.has(`${id}-${duplicate}`)) duplicate += 1;
      id = `${id}-${duplicate}`;
    }
    usedIds.add(id);

    const spatial = new Set<string>();
    for (const entity of group.entities) for (const type of spatialTypes(entity)) spatial.add(type);
    const previewable2d = group.entities.some((entity) => TWO_D_PREVIEW_TYPES.has(entity.type));
    const selectedPairs = group.entities.flatMap(entityPairs);
    return {
      id,
      name: group.name,
      kind: group.kind,
      entityCount: group.entities.length,
      previewable2d,
      hasSpatialEntities: spatial.size > 0,
      spatialEntityTypes: [...spatial].sort(),
      text: renderPairs([...prefix, ...selectedPairs, ...suffix])
    };
  });

  const modelView = views.find((view) => view.kind === 'model');
  const hasSpatialModel = !!modelView?.hasSpatialEntities;
  const modelDimensionality: CadModelDimensionality = !modelView
    ? 'unknown'
    : hasSpatialModel && modelView.previewable2d
      ? 'mixed'
      : hasSpatialModel
        ? '3d'
        : '2d';

  return {
    views,
    modelDimensionality,
    hasSpatialModel,
    spatialEntityTypes: modelView?.spatialEntityTypes ?? []
  };
}
