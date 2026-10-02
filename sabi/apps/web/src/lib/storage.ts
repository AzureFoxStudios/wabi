/**
 * Browser storage that never throws. Storage can be unavailable (cookies/site data blocked, sandboxed or
 * third-party frames, private modes); in that case values live only in memory for this page.
 */
const memory = new Map<string, string>();

function area(kind: 'local' | 'session'): Storage | null {
  try {
    const s = kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

function make(kind: 'local' | 'session') {
  return {
    get(key: string): string | null {
      try { const v = area(kind)?.getItem(key); if (v != null) return v; } catch { /* blocked */ }
      return memory.get(`${kind}:${key}`) ?? null;
    },
    set(key: string, value: string | null) {
      if (value == null) memory.delete(`${kind}:${key}`); else memory.set(`${kind}:${key}`, value);
      try { if (value == null) area(kind)?.removeItem(key); else area(kind)?.setItem(key, value); } catch { /* blocked */ }
    },
  };
}

export const local = make('local');
export const session = make('session');
