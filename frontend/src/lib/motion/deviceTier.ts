/**
 * Device GPU tier detection.
 * Runs once on first load, result cached in localStorage.
 * Used to auto-enable performance mode on known weak hardware.
 */

export type DeviceTier = 'weak' | 'mid' | 'capable';

const CACHE_KEY = 'wabi_device_tier';
const CACHE_VERSION = 1; // bump if detection logic changes

interface CachedTier {
  tier: DeviceTier;
  version: number;
  renderer: string;
}

const WEAK_GPU_PATTERNS = [
  // ARM Mali — weakest tier
  /mali-4/i,       // Mali-4xx series (Redmi A7 class)
  /mali-t[234]/i,  // Mali-T series
  /mali-3/i,       // Mali-3xx series
  // Imagination PowerVR
  /powervr sgx/i,
  /powervr g[0-9]/i,
  // Qualcomm Adreno 3xx
  /adreno \(tm\) 3/i,
  /adreno 3/i,
  // Older NVIDIA
  /tegra/i,
  // Intel GMA / HD Graphics (old)
  /intel\(r\) hd graphics [234]/i,
  /gma/i,
];

const MID_GPU_PATTERNS = [
  // Mali mid-range
  /mali-g5/i,
  /mali-g7[56]/i,
  /mali(-|_)?g(52|53|72|73)/i,
  /mali(-|_)?g76/i,
  // Qualcomm mid-range
  /adreno \(tm\) 4[0-5]/i,
  /adreno 4[0-5]/i,
  /adreno \(tm\) 5[0-5]/i,
  /adreno 5[0-5]/i,
  // Apple older
  /apple gpu/i,
  // Intel gen9-10
  /intel\(r\) hd graphics [5][0-9]{3}/i,
  /intel\(r\) (uhd|iris) graphics [56]/i,
  // AMD Vega 8/10 (laptop APUs)
  /amd vega/i,
];

const WEAK_MEMORY_THRESHOLD = 3; // GB — below this is Weak regardless of GPU
const MID_MEMORY_THRESHOLD = 5;  // GB — below this is Mid at minimum

function getWebGLRenderer(): string {
  if (typeof window === 'undefined') return '';
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return '';
    const debugInfo = (gl as WebGLRenderingContext).getExtension('WEBGL_debug_renderer_info');
    if (!debugInfo) return '';
    return (gl as WebGLRenderingContext).getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '';
  } catch {
    return '';
  }
}

function getDeviceMemory(): number {
  if (typeof navigator === 'undefined') return 8;
  // @ts-ignore — deviceMemory is not in all TS libs
  return navigator.deviceMemory ?? 8;
}

function getHardwareConcurrency(): number {
  if (typeof navigator === 'undefined') return 8;
  return navigator.hardwareConcurrency ?? 8;
}

export function detectTier(): DeviceTier {
  // Check cache first
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached) as CachedTier;
      if (parsed.version === CACHE_VERSION) {
        return parsed.tier;
      }
    }
  } catch {
    // localStorage unavailable or corrupt — proceed with detection
  }

  const renderer = getWebGLRenderer().toLowerCase();
  const memory = getDeviceMemory();
  const cores = getHardwareConcurrency();

  // Check GPU patterns
  const isWeakGpu = WEAK_GPU_PATTERNS.some(p => p.test(renderer));
  const isMidGpu = MID_GPU_PATTERNS.some(p => p.test(renderer));

  let tier: DeviceTier;

  if (isWeakGpu || memory < WEAK_MEMORY_THRESHOLD) {
    tier = 'weak';
  } else if (isMidGpu || memory < MID_MEMORY_THRESHOLD || cores <= 4) {
    tier = 'mid';
  } else {
    tier = 'capable';
  }

  // Cache result
  try {
    const cache: CachedTier = { tier, version: CACHE_VERSION, renderer };
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // ignore storage errors
  }

  return tier;
}

export function clearCachedTier(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // ignore
  }
}

export function getRendererLabel(): string {
  return getWebGLRenderer();
}
