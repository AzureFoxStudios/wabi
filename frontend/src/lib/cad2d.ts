export type Cad2DUnit = 'unitless' | 'in' | 'ft' | 'mm' | 'cm' | 'm' | 'km' | 'yd' | 'unknown';

export interface CadPoint { x: number; y: number }
export interface CadBounds { minX: number; minY: number; maxX: number; maxY: number }
export interface CadBaseEntity { layer: string }
export interface CadLineEntity extends CadBaseEntity { type: 'LINE'; a: CadPoint; b: CadPoint }
export interface CadPolylineEntity extends CadBaseEntity { type: 'LWPOLYLINE' | 'POLYLINE'; points: CadPoint[]; closed: boolean }
export interface CadCircleEntity extends CadBaseEntity { type: 'CIRCLE'; center: CadPoint; radius: number }
export interface CadArcEntity extends CadBaseEntity { type: 'ARC'; center: CadPoint; radius: number; startDeg: number; endDeg: number }
export interface CadPointEntity extends CadBaseEntity { type: 'POINT'; point: CadPoint }
export interface CadTextEntity extends CadBaseEntity { type: 'TEXT' | 'MTEXT'; point: CadPoint; text: string; height: number; rotationDeg: number }
export type Cad2DEntity = CadLineEntity | CadPolylineEntity | CadCircleEntity | CadArcEntity | CadPointEntity | CadTextEntity;


export interface CadViewBox { x: number; y: number; width: number; height: number }

export function cadViewportScale(viewportWidth: number, viewportHeight: number, viewBox: CadViewBox): number | null {
  if (![viewportWidth, viewportHeight, viewBox.width, viewBox.height].every(Number.isFinite) || viewportWidth <= 0 || viewportHeight <= 0 || viewBox.width <= 0 || viewBox.height <= 0) return null;
  const scale = Math.min(viewportWidth / viewBox.width, viewportHeight / viewBox.height);
  return Number.isFinite(scale) && scale > 0 ? scale : null;
}

/** Map a pixel position inside an SVG viewport to CAD coordinates while honoring xMidYMid/meet letterboxing. */
export function cadScreenToDrawingPoint(localX: number, localY: number, viewportWidth: number, viewportHeight: number, viewBox: CadViewBox): CadPoint | null {
  const scale = cadViewportScale(viewportWidth, viewportHeight, viewBox);
  if (scale == null || !Number.isFinite(localX) || !Number.isFinite(localY)) return null;
  const offsetX = (viewportWidth - viewBox.width * scale) / 2;
  const offsetY = (viewportHeight - viewBox.height * scale) / 2;
  const x = localX - offsetX, y = localY - offsetY;
  if (x < 0 || y < 0 || x > viewBox.width * scale || y > viewBox.height * scale) return null;
  return { x: viewBox.x + x / scale, y: -(viewBox.y + y / scale) };
}
export interface Cad2DDrawing {
  format: 'dxf-ascii';
  unit: Cad2DUnit;
  unitCode: number | null;
  entities: Cad2DEntity[];
  layers: string[];
  bounds: CadBounds;
  ignoredEntityTypes: Record<string, number>;
}

interface DxfPair { code: number; value: string }
interface EntityChunk { type: string; pairs: DxfPair[] }

const DEFAULT_BOUNDS: CadBounds = { minX: -1, minY: -1, maxX: 1, maxY: 1 };
const MAX_ENTITIES = 100_000;

function finite(value: string | undefined): number | null {
  if (value == null) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function first(pairs: DxfPair[], code: number): string | undefined {
  return pairs.find((pair) => pair.code === code)?.value;
}

function firstNumber(pairs: DxfPair[], code: number): number | null {
  return finite(first(pairs, code));
}


function cleanDxfText(raw: string): string {
  return raw
    .replace(/\\P/gi, ' · ')
    .replace(/\\~/g, ' ')
    .replace(/\\[A-Za-z][^;]*;/g, '')
    .replace(/[{}]/g, '')
    .trim();
}

function layerName(pairs: DxfPair[]): string {
  const layer = first(pairs, 8)?.trim();
  return layer || '0';
}

function dxfUnit(code: number | null): Cad2DUnit {
  switch (code) {
    case 0: return 'unitless';
    case 1: return 'in';
    case 2: return 'ft';
    case 4: return 'mm';
    case 5: return 'cm';
    case 6: return 'm';
    case 7: return 'km';
    case 10: return 'yd';
    default: return code == null ? 'unknown' : 'unknown';
  }
}

function parsePairs(text: string): DxfPair[] {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const pairs: DxfPair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i].trim(), 10);
    if (!Number.isFinite(code)) continue;
    pairs.push({ code, value: lines[i + 1] });
  }
  return pairs;
}

function sectionPairs(pairs: DxfPair[], sectionName: string): DxfPair[] {
  for (let i = 0; i + 1 < pairs.length; i += 1) {
    if (pairs[i].code === 0 && pairs[i].value.trim().toUpperCase() === 'SECTION' &&
        pairs[i + 1].code === 2 && pairs[i + 1].value.trim().toUpperCase() === sectionName) {
      const out: DxfPair[] = [];
      for (let j = i + 2; j < pairs.length; j += 1) {
        if (pairs[j].code === 0 && pairs[j].value.trim().toUpperCase() === 'ENDSEC') return out;
        out.push(pairs[j]);
      }
      return out;
    }
  }
  return [];
}

function parseUnitCode(header: DxfPair[]): number | null {
  for (let i = 0; i + 1 < header.length; i += 1) {
    if (header[i].code === 9 && header[i].value.trim().toUpperCase() === '$INSUNITS') {
      for (let j = i + 1; j < Math.min(header.length, i + 6); j += 1) {
        if (header[j].code === 70) return finite(header[j].value);
        if (header[j].code === 9) break;
      }
    }
  }
  return null;
}

function chunkEntities(entityPairs: DxfPair[]): EntityChunk[] {
  const chunks: EntityChunk[] = [];
  let current: EntityChunk | null = null;
  for (const pair of entityPairs) {
    if (pair.code === 0) {
      if (current) chunks.push(current);
      current = { type: pair.value.trim().toUpperCase(), pairs: [] };
    } else if (current) {
      current.pairs.push(pair);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function polylinePoints(pairs: DxfPair[]): CadPoint[] {
  const points: CadPoint[] = [];
  let pendingX: number | null = null;
  for (const pair of pairs) {
    if (pair.code === 10) {
      pendingX = finite(pair.value);
    } else if (pair.code === 20 && pendingX != null) {
      const y = finite(pair.value);
      if (y != null) points.push({ x: pendingX, y });
      pendingX = null;
    }
  }
  return points;
}

function parseChunk(chunk: EntityChunk, following: EntityChunk[], ignored: Record<string, number>): { entity: Cad2DEntity | null; consumed: number } {
  const layer = layerName(chunk.pairs);
  if (chunk.type === 'LINE') {
    const x1 = firstNumber(chunk.pairs, 10), y1 = firstNumber(chunk.pairs, 20);
    const x2 = firstNumber(chunk.pairs, 11), y2 = firstNumber(chunk.pairs, 21);
    if ([x1, y1, x2, y2].every((value) => value != null)) {
      return { entity: { type: 'LINE', layer, a: { x: x1!, y: y1! }, b: { x: x2!, y: y2! } }, consumed: 0 };
    }
  } else if (chunk.type === 'LWPOLYLINE') {
    if (chunk.pairs.some((pair) => pair.code === 42 && Math.abs(finite(pair.value) ?? 0) > 1e-12)) ignored.LWPOLYLINE_BULGE = (ignored.LWPOLYLINE_BULGE || 0) + 1;
    const points = polylinePoints(chunk.pairs);
    const flags = firstNumber(chunk.pairs, 70) ?? 0;
    if (points.length >= 2) return { entity: { type: 'LWPOLYLINE', layer, points, closed: (flags & 1) === 1 }, consumed: 0 };
  } else if (chunk.type === 'POLYLINE') {
    const points: CadPoint[] = [];
    let consumed = 0;
    for (const next of following) {
      consumed += 1;
      if (next.type === 'SEQEND') break;
      if (next.type !== 'VERTEX') continue;
      if (next.pairs.some((pair) => pair.code === 42 && Math.abs(finite(pair.value) ?? 0) > 1e-12)) ignored.POLYLINE_BULGE = (ignored.POLYLINE_BULGE || 0) + 1;
      const x = firstNumber(next.pairs, 10), y = firstNumber(next.pairs, 20);
      if (x != null && y != null) points.push({ x, y });
    }
    const flags = firstNumber(chunk.pairs, 70) ?? 0;
    if (points.length >= 2) return { entity: { type: 'POLYLINE', layer, points, closed: (flags & 1) === 1 }, consumed };
    return { entity: null, consumed };
  } else if (chunk.type === 'CIRCLE') {
    const x = firstNumber(chunk.pairs, 10), y = firstNumber(chunk.pairs, 20), radius = firstNumber(chunk.pairs, 40);
    if (x != null && y != null && radius != null && radius > 0) return { entity: { type: 'CIRCLE', layer, center: { x, y }, radius }, consumed: 0 };
  } else if (chunk.type === 'ARC') {
    const x = firstNumber(chunk.pairs, 10), y = firstNumber(chunk.pairs, 20), radius = firstNumber(chunk.pairs, 40);
    const startDeg = firstNumber(chunk.pairs, 50), endDeg = firstNumber(chunk.pairs, 51);
    if (x != null && y != null && radius != null && radius > 0 && startDeg != null && endDeg != null) {
      return { entity: { type: 'ARC', layer, center: { x, y }, radius, startDeg, endDeg }, consumed: 0 };
    }
  } else if (chunk.type === 'POINT') {
    const x = firstNumber(chunk.pairs, 10), y = firstNumber(chunk.pairs, 20);
    if (x != null && y != null) return { entity: { type: 'POINT', layer, point: { x, y } }, consumed: 0 };
  } else if (chunk.type === 'TEXT' || chunk.type === 'MTEXT') {
    const x = firstNumber(chunk.pairs, 10), y = firstNumber(chunk.pairs, 20);
    const height = Math.abs(firstNumber(chunk.pairs, 40) ?? 2.5) || 2.5;
    const rotationDeg = firstNumber(chunk.pairs, 50) ?? 0;
    const rawText = chunk.pairs.filter((pair) => pair.code === 3 || pair.code === 1).map((pair) => pair.value).join('');
    const text = cleanDxfText(rawText);
    if (x != null && y != null && text) return { entity: { type: chunk.type, layer, point: { x, y }, text, height, rotationDeg }, consumed: 0 };
  }
  if (!['VERTEX', 'SEQEND'].includes(chunk.type)) ignored[chunk.type] = (ignored[chunk.type] || 0) + 1;
  return { entity: null, consumed: 0 };
}

function includePoint(bounds: CadBounds | null, point: CadPoint): CadBounds {
  if (!bounds) return { minX: point.x, minY: point.y, maxX: point.x, maxY: point.y };
  return {
    minX: Math.min(bounds.minX, point.x), minY: Math.min(bounds.minY, point.y),
    maxX: Math.max(bounds.maxX, point.x), maxY: Math.max(bounds.maxY, point.y)
  };
}

function angleOnArc(angle: number, start: number, end: number): boolean {
  const norm = (value: number) => ((value % 360) + 360) % 360;
  const a = norm(angle), s = norm(start), e = norm(end);
  const sweep = (e - s + 360) % 360 || 360;
  const offset = (a - s + 360) % 360;
  return offset <= sweep + 1e-9;
}

function entityBounds(entity: Cad2DEntity): CadBounds {
  let bounds: CadBounds | null = null;
  if (entity.type === 'LINE') {
    bounds = includePoint(bounds, entity.a); bounds = includePoint(bounds, entity.b);
  } else if (entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') {
    for (const point of entity.points) bounds = includePoint(bounds, point);
  } else if (entity.type === 'CIRCLE') {
    bounds = { minX: entity.center.x - entity.radius, minY: entity.center.y - entity.radius, maxX: entity.center.x + entity.radius, maxY: entity.center.y + entity.radius };
  } else if (entity.type === 'ARC') {
    const angles = [entity.startDeg, entity.endDeg, 0, 90, 180, 270].filter((angle, index) => index < 2 || angleOnArc(angle, entity.startDeg, entity.endDeg));
    for (const angle of angles) {
      const rad = angle * Math.PI / 180;
      bounds = includePoint(bounds, { x: entity.center.x + Math.cos(rad) * entity.radius, y: entity.center.y + Math.sin(rad) * entity.radius });
    }
  } else if ('point' in entity) {
    bounds = includePoint(bounds, entity.point);
    if (entity.type === 'TEXT' || entity.type === 'MTEXT') {
      const approximateWidth = Math.max(entity.height, entity.text.length * entity.height * 0.58);
      bounds = includePoint(bounds, { x: entity.point.x + approximateWidth, y: entity.point.y + entity.height });
    }
  }
  return bounds || DEFAULT_BOUNDS;
}

export function boundsForCadEntities(entities: Cad2DEntity[]): CadBounds {
  let bounds: CadBounds | null = null;
  for (const entity of entities) {
    const current = entityBounds(entity);
    bounds = includePoint(bounds, { x: current.minX, y: current.minY });
    bounds = includePoint(bounds, { x: current.maxX, y: current.maxY });
  }
  if (!bounds) return { ...DEFAULT_BOUNDS };
  if (Math.abs(bounds.maxX - bounds.minX) < 1e-9) { bounds.minX -= 0.5; bounds.maxX += 0.5; }
  if (Math.abs(bounds.maxY - bounds.minY) < 1e-9) { bounds.minY -= 0.5; bounds.maxY += 0.5; }
  return bounds;
}

export function parseAsciiDxf(text: string): Cad2DDrawing {
  if (typeof text !== 'string' || !text.trim()) throw new Error('DXF file is empty.');
  if (/AutoCAD Binary DXF/i.test(text.slice(0, 128))) throw new Error('Binary DXF is not supported by the built-in 2D reader.');
  const pairs = parsePairs(text);
  if (pairs.length < 2) throw new Error('This does not look like an ASCII DXF file.');
  const entitiesSection = sectionPairs(pairs, 'ENTITIES');
  if (entitiesSection.length === 0) throw new Error('DXF has no readable ENTITIES section.');
  const unitCode = parseUnitCode(sectionPairs(pairs, 'HEADER'));
  const chunks = chunkEntities(entitiesSection);
  const entities: Cad2DEntity[] = [];
  const ignoredEntityTypes: Record<string, number> = {};
  for (let i = 0; i < chunks.length; i += 1) {
    if (entities.length >= MAX_ENTITIES) throw new Error(`DXF exceeds the built-in ${MAX_ENTITIES.toLocaleString()} entity safety limit.`);
    const result = parseChunk(chunks[i], chunks.slice(i + 1), ignoredEntityTypes);
    if (result.entity) entities.push(result.entity);
    i += result.consumed;
  }
  if (entities.length === 0) throw new Error('DXF contains no supported 2D entities. Supported: LINE, POLYLINE/LWPOLYLINE, CIRCLE, ARC, POINT, TEXT and MTEXT.');
  const layers = [...new Set(entities.map((entity) => entity.layer))].sort((a, b) => a.localeCompare(b));
  return { format: 'dxf-ascii', unit: dxfUnit(unitCode), unitCode, entities, layers, bounds: boundsForCadEntities(entities), ignoredEntityTypes };
}

export function cadArcPoints(entity: CadArcEntity, maxSegments = 96): CadPoint[] {
  const start = ((entity.startDeg % 360) + 360) % 360;
  const end = ((entity.endDeg % 360) + 360) % 360;
  const sweep = (end - start + 360) % 360 || 360;
  const segments = Math.max(4, Math.min(maxSegments, Math.ceil(sweep / 6)));
  const points: CadPoint[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const angle = (start + sweep * i / segments) * Math.PI / 180;
    points.push({ x: entity.center.x + Math.cos(angle) * entity.radius, y: entity.center.y + Math.sin(angle) * entity.radius });
  }
  return points;
}

export function cadSnapPoints(entity: Cad2DEntity): CadPoint[] {
  if (entity.type === 'LINE') return [entity.a, entity.b];
  if (entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') return entity.points;
  if (entity.type === 'CIRCLE') return [entity.center];
  if (entity.type === 'ARC') {
    const arc = cadArcPoints(entity, 12);
    return [entity.center, arc[0], arc[arc.length - 1]];
  }
  return 'point' in entity ? [entity.point] : [];
}

export function nearestCadSnap(entities: Cad2DEntity[], target: CadPoint, tolerance: number): CadPoint | null {
  let best: CadPoint | null = null;
  let bestDistance = Math.max(0, tolerance);
  for (const entity of entities) {
    for (const point of cadSnapPoints(entity)) {
      const distance = Math.hypot(point.x - target.x, point.y - target.y);
      if (distance <= bestDistance) { bestDistance = distance; best = point; }
    }
  }
  return best;
}

export function formatCadNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toFixed(1);
  if (abs >= 10) return value.toFixed(2).replace(/\.00$/, '');
  return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}
