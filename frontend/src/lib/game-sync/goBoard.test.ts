import { describe, it, expect } from 'vitest';
import { pointIndex, indexPoint, inBounds, starPoints, formatCoord } from './goBoard';

describe('goBoard helpers', () => {
  it('pointIndex/indexPoint round-trip', () => {
    for (const size of [9, 13, 19]) {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = pointIndex(size, x, y);
          const p = indexPoint(size, i);
          expect(p).toEqual({ x, y });
        }
      }
    }
  });
  it('inBounds', () => {
    expect(inBounds(9, 0, 0)).toBe(true);
    expect(inBounds(9, 9, 0)).toBe(false);
    expect(inBounds(9, 0, 9)).toBe(false);
  });
  it('starPoints count', () => {
    expect(starPoints(9).length).toBe(5);
    expect(starPoints(13).length).toBe(5);
    expect(starPoints(19).length).toBe(9);
  });
  it('formatCoord', () => {
    expect(formatCoord(0, 0)).toBe('A1');
    expect(formatCoord(2, 2)).toBe('C3');
  });
});