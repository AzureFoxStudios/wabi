/**
 * Non-spring easing curves as CSS cubic-bezier strings.
 * Use for simple tweens where spring physics are overkill.
 */

export const EASE_OUT = 'cubic-bezier(0, 0, 0.58, 1)';
export const EASE_IN_OUT = 'cubic-bezier(0.42, 0, 0.58, 1)';
export const EASE_DECELERATE = 'cubic-bezier(0, 0, 0.58, 1)'; // Signal feel
export const EASE_SHARP = 'cubic-bezier(0.4, 0, 0.6, 1)'; // Crisp — resize handles
export const EASE_SNAPPY = 'cubic-bezier(0.32, 0, 0.67, 0)'; // Quick, no overshoot
export const EASE_BACK = 'cubic-bezier(0.34, 1.56, 0.64, 1)'; // Subtle overshoot

// Durations (ms) — these are ceilings, spring animations end when restSpeed is met
export const DURATION_FAST = 120;
export const DURATION_NORMAL = 200;
export const DURATION_SLOW = 300;
export const DURATION_SCALE = 250;
