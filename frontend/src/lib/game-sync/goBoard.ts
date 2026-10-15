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
export function territoryColor(board: (number | null)[], size: number, idx: number): number | null {
  if (board[idx] !== null && board[idx] !== -1) return null;
  return null; // placeholder: scoring is server-side; kept for display hooks
}
export function formatCoord(x: number, y: number): string {
  const letters = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';
  return (letters[x] ?? '?') + (y + 1);
}