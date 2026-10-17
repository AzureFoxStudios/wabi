import { test, expect } from 'bun:test';
import { pointIndex, indexPoint, inBounds, starPoints, formatCoord } from './goBoard';

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
