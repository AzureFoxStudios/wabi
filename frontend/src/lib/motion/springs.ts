/**
 * Spring physics presets for Wabi panel animations.
 * All springs use stiffness/damping/restSpeed — not duration.
 * Duration is emergent from physics, not a fixed ceiling.
 */

import type { Spring } from 'motion';

// Panel slide — Discord-style snappy with light overshoot
export const panelOpen: Spring = {
  stiffness: 400,
  damping: 35,
  restSpeed: 0.5,
};

// Panel settle — heavier, more deliberate (low velocity release)
export const panelSettle: Spring = {
  stiffness: 280,
  damping: 40,
  restSpeed: 2,
};

// Magnet snap — decisive lock-in at thresholds
export const magnetSnap: Spring = {
  stiffness: 500,
  damping: 30,
  restSpeed: 0.5,
};

// Instant — for reduced motion preference
export const instant: Spring = {
  stiffness: 1000,
  damping: 100,
  restSpeed: 999,
};
