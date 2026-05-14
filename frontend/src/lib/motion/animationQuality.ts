/**
 * Animation quality settings store.
 * Initialized from device tier detection, user can override.
 *
 * cssOnly:        Use CSS ease-out transitions instead of spring physics
 * disableWindows: Block window.open() and Tauri window spawning
 */

import { writable, derived, get } from 'svelte/store';
import { browser } from '$app/environment';
import { detectTier, type DeviceTier } from './deviceTier';

export interface AnimationQualityState {
  cssOnly: boolean;
  disableWindows: boolean;
  userOverride: boolean;  // true once user touches either toggle
  tier?: DeviceTier;
}

const STORAGE_KEY = 'wabi_animation_quality';

function defaultFromTier(tier: DeviceTier): Pick<AnimationQualityState, 'cssOnly' | 'disableWindows'> {
  switch (tier) {
    case 'weak':
      return { cssOnly: true, disableWindows: true };
    case 'mid':
      return { cssOnly: false, disableWindows: false };
    case 'capable':
    default:
      return { cssOnly: false, disableWindows: false };
  }
}

function load(): AnimationQualityState {
  if (!browser) return { cssOnly: false, disableWindows: false, userOverride: false };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AnimationQualityState>;
      // If user has overridden, respect their choice exactly
      if (parsed.userOverride) {
        return {
          cssOnly: parsed.cssOnly ?? false,
          disableWindows: parsed.disableWindows ?? false,
          userOverride: true,
        };
      }
    }
  } catch {
    // ignore
  }
  // First run — use auto-detected tier defaults
  const tier = detectTier();
  return {
    ...defaultFromTier(tier),
    userOverride: false,
  };
}

function save(state: AnimationQualityState) {
  if (!browser) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

function createAnimationQualityStore() {
  const initial = load();
  const { subscribe, set, update } = writable<AnimationQualityState>(initial);

  function persist(state: AnimationQualityState): AnimationQualityState {
    save(state);
    set(state);
    return state;
  }

  return {
    subscribe,

    setCssOnly(value: boolean) {
      update(s => persist({ ...s, cssOnly: value, userOverride: true }));
    },

    setDisableWindows(value: boolean) {
      update(s => persist({ ...s, disableWindows: value, userOverride: true }));
    },

    resetToAuto() {
      const tier = detectTier();
      persist({ ...defaultFromTier(tier), userOverride: false });
    },

    get tier(): DeviceTier {
      return detectTier();
    },
  };
}

export const animationQuality = createAnimationQualityStore();

// Derived: true when spring physics are active (not cssOnly)
export const springsEnabled = derived(animationQuality, $aq => !$aq.cssOnly);

// Derived: true when windows are allowed
export const windowsEnabled = derived(animationQuality, $aq => !$aq.disableWindows);
