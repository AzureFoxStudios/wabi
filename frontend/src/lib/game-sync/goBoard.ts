// Frontend helpers for the Go board. Rule application lives on the server
// (server-authoritative); this module only provides display coordinates and
// star-point layout so the board can render without recomputing geometry.
export function pointIndex(size: number, x: number, y: number): number {
  return y * size + x;
}
export function indexPoint(size: number, i: number): { x: number; y: number } {
  return { x: i % size, y: Math.floor(i / size) };
}
export function inBounds(size: number, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < size && y < size;
}
export function starPoints(size: number): { x: number; y: number }[] {
  // Standard handicap/ha points. Kept simple for 9/13/19.
  if (size === 9) {
    return coords([[2, 2], [6, 2], [6, 6], [2, 6], [4, 4]]);
  }
  if (size === 13) {
    return coords([[3, 3], [9, 3], [9, 9], [3, 9], [6, 6]]);
  }
  // 19
  return coords([
    [3, 3], [9, 3], [15, 3],
    [3, 9], [9, 9], [15, 9],
    [3, 15], [9, 15], [15, 15]
  ]);
}
function coords(list: number[][]): { x: number; y: number }[] {
  return list.map(([x, y]) => ({ x, y }));
}
export function formatCoord(x: number, y: number): string {
  const letters = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';
  return (letters[x] ?? '?') + (y + 1);
}

/**
 * Grid lines for the board's SVG layer, in a size×size viewBox. Intersections
 * sit at half-integer coordinates (x + 0.5, y + 0.5), so the outermost lines
 * keep half a cell of paper around them. One path, so the browser draws every
 * rule in a single stroke (grid lines are hairlines, not boxes).
 */
export function boardGridPaths(size: number): string {
  if (size < 1) return '';
  const first = 0.5;
  const last = size - 0.5;
  const parts: string[] = [];
  for (let i = 0; i < size; i++) {
    const at = i + 0.5;
    parts.push(`M${first} ${at}H${last}`, `M${at} ${first}V${last}`);
  }
  return parts.join(' ');
}

/** Star-point centres in the grid's half-integer coordinate space. */
export function boardStarPoints(size: number): { x: number; y: number }[] {
  return starPoints(size).map(({ x, y }) => ({ x: x + 0.5, y: y + 0.5 }));
}

/**
 * The next point for a roving-tabindex board. Arrows move one intersection and
 * stop at the edge; Home/End jump to the ends of the current row. Returns null
 * for any key the board does not own, so the caller can leave it alone.
 */
export function nextPointIndex(size: number, index: number, key: string): number | null {
  if (size < 1 || index < 0 || index >= size * size) return null;
  const { x, y } = indexPoint(size, index);
  switch (key) {
    case 'ArrowLeft':
      return pointIndex(size, Math.max(0, x - 1), y);
    case 'ArrowRight':
      return pointIndex(size, Math.min(size - 1, x + 1), y);
    case 'ArrowUp':
      return pointIndex(size, x, Math.max(0, y - 1));
    case 'ArrowDown':
      return pointIndex(size, x, Math.min(size - 1, y + 1));
    case 'Home':
      return pointIndex(size, 0, y);
    case 'End':
      return pointIndex(size, size - 1, y);
    default:
      return null;
  }
}
