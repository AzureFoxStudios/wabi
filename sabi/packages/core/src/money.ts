import type { Minor } from './types.ts';

/** Round half away from zero to an integer (financial rounding). */
export function roundHalfUp(x: number): number {
  // Correct for binary float noise before rounding (e.g. 1.005 * 100).
  const r = Math.round(Math.abs(x) * 1e6) / 1e6;
  return Math.sign(x) * Math.floor(r + 0.5);
}

/** Major units (e.g. baht with decimals) → minor units (satang). */
export function toMinor(major: number): Minor {
  return roundHalfUp(major * 100);
}

export function fromMinor(minor: Minor): number {
  return minor / 100;
}

/** Quantities are kept to 3 decimals (metres, kg). */
export function roundQty(q: number): number {
  return roundHalfUp(q * 1000) / 1000;
}

export function sum(values: number[]): number {
  let s = 0;
  for (const v of values) s += v;
  return s;
}

/** Format minor units as `1,234.50` (no currency symbol). */
export function formatMinor(minor: Minor, opts: { symbol?: string; compact?: boolean } = {}): string {
  const neg = minor < 0;
  const abs = Math.abs(minor);
  let s: string;
  if (opts.compact && abs >= 100_000_00) {
    const m = abs / 100 / 1_000_000;
    s = (m >= 10 ? m.toFixed(1) : m.toFixed(2)).replace(/\.?0+$/, '') + 'M';
  } else if (opts.compact && abs >= 1_000_00) {
    const k = abs / 100 / 1000;
    s = (k >= 100 ? k.toFixed(0) : k.toFixed(1)).replace(/\.0$/, '') + 'k';
  } else {
    const baht = Math.floor(abs / 100);
    const satang = abs % 100;
    s = baht.toLocaleString('en-US') + '.' + String(satang).padStart(2, '0');
  }
  return (neg ? '−' : '') + (opts.symbol ?? '') + s;
}

export function formatQty(q: number): string {
  return roundQty(q).toLocaleString('en-US', { maximumFractionDigits: 3 });
}
