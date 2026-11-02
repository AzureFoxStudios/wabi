import { test, expect } from 'bun:test';
import {
  boardGridPaths,
  boardStarPoints,
  formatCoord,
  inBounds,
  indexPoint,
  nextPointIndex,
  pointIndex,
  starPoints
} from './goBoard';

test('pointIndex/indexPoint round-trip for all board sizes', () => {
  for (const size of [9, 13, 19]) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        expect(indexPoint(size, pointIndex(size, x, y))).toEqual({ x, y });
      }
    }
  }
});

test('inBounds rejects off-board coordinates', () => {
  expect(inBounds(9, 0, 0)).toBe(true);
  expect(inBounds(9, 9, 0)).toBe(false);
  expect(inBounds(9, 0, 9)).toBe(false);
  expect(inBounds(9, -1, 0)).toBe(false);
});

test('star points match standard layouts', () => {
  expect(starPoints(9).length).toBe(5);
  expect(starPoints(13).length).toBe(5);
  expect(starPoints(19).length).toBe(9);
});

test('formatCoord skips I like Go conventions', () => {
  expect(formatCoord(0, 0)).toBe('A1');
  expect(formatCoord(2, 2)).toBe('C3');
});

test('boardGridPaths draws one rule per row and column, half a cell in', () => {
  const d = boardGridPaths(9);
  expect(d.startsWith('M0.5 0.5H8.5')).toBe(true);
  expect(d.includes('M0.5 8.5H8.5')).toBe(true);
  expect(d.includes('M8.5 0.5V8.5')).toBe(true);
  // 9 rows + 9 columns, each one move.
  expect(d.match(/M/g)?.length).toBe(18);
  expect(boardGridPaths(0)).toBe('');
});

test('boardStarPoints shift standard points into cell centres', () => {
  expect(boardStarPoints(9)).toContainEqual({ x: 4.5, y: 4.5 });
  expect(boardStarPoints(19)[0]).toEqual({ x: 3.5, y: 3.5 });
  expect(boardStarPoints(13).length).toBe(starPoints(13).length);
});

test('nextPointIndex clamps at the edge and keeps Home/End on the row', () => {
  // 0,0: left and up stop at the corner.
  expect(nextPointIndex(9, 0, 'ArrowLeft')).toBe(0);
  expect(nextPointIndex(9, 0, 'ArrowUp')).toBe(0);
  expect(nextPointIndex(9, 0, 'ArrowRight')).toBe(1);
  expect(nextPointIndex(9, 0, 'ArrowDown')).toBe(9);
  // Row 1, column 1: Home/End stay on x = 0 / 8.
  expect(nextPointIndex(9, 10, 'Home')).toBe(9);
  expect(nextPointIndex(9, 10, 'End')).toBe(17);
  // Bottom-right corner stops both ways.
  expect(nextPointIndex(9, 80, 'ArrowRight')).toBe(80);
  expect(nextPointIndex(9, 80, 'ArrowDown')).toBe(80);
});

test('nextPointIndex leaves keys it does not own alone', () => {
  expect(nextPointIndex(9, 0, 'Enter')).toBeNull();
  expect(nextPointIndex(9, 0, 'Tab')).toBeNull();
  expect(nextPointIndex(9, -1, 'ArrowRight')).toBeNull();
  expect(nextPointIndex(9, 81, 'ArrowRight')).toBeNull();
  expect(nextPointIndex(0, 0, 'ArrowRight')).toBeNull();
});
