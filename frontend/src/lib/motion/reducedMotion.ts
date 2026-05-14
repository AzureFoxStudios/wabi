/**
 * Reduced motion preference detection.
 * Returns true if the user has requested minimal animation.
 */

let cached: boolean | null = null;

export function prefersReducedMotion(): boolean {
  if (cached !== null) return cached;

  if (typeof window === 'undefined') {
    cached = false;
    return false;
  }

  cached = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return cached;
}

/**
 * Returns a motion-safe duration in ms.
 * Zero if reduced motion is preferred, otherwise the provided value.
 */
export function safeDuration(ms: number): number {
  return prefersReducedMotion() ? Math.min(ms, 50) : ms;
}
