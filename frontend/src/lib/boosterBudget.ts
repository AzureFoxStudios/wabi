export interface BoostFile { path: string; hash: string; size: number }
export const MAX_BOOST_FILE = 8 * 1024 * 1024;
export const CACHE_TTL_MS = 5 * 60 * 1000;
export class BoosterCache {
    private entries = new Map<string, { file: BoostFile; bytes: ArrayBuffer; expires: number }>();
    constructor(readonly limitBytes: number, private clock = Date.now) {}
    prune() { for (const [path, entry] of this.entries) if (entry.expires <= this.clock()) this.entries.delete(path); }
    put(file: BoostFile, bytes: ArrayBuffer) {
        this.prune();
        if (bytes.byteLength !== file.size || file.size > MAX_BOOST_FILE || file.size > this.limitBytes) return false;
        this.entries.delete(file.path);
        while (this.entries.size && (this.size + file.size > this.limitBytes || this.entries.size >= 16)) this.entries.delete(this.entries.keys().next().value!);
        this.entries.set(file.path, { file: { ...file }, bytes: bytes.slice(0), expires: this.clock() + CACHE_TTL_MS });
        return true;
    }
    get(file: BoostFile) { this.prune(); const e = this.entries.get(file.path); return e?.file.hash === file.hash && e.file.size === file.size ? e.bytes : null; }
    retain(paths: string[]) { const allowed = new Set(paths); for (const path of this.entries.keys()) if (!allowed.has(path)) this.entries.delete(path); }
    get files() { this.prune(); return [...this.entries.values()].map(e => e.file); }
    get size() { this.prune(); return [...this.entries.values()].reduce((n, e) => n + e.bytes.byteLength, 0); }
    clear() { this.entries.clear(); }
}
export async function contentHash(bytes: ArrayBuffer): Promise<string> {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
}
export function boosterPath(raw: string, server: string): string | null {
    try {
        const target = new URL(raw, server);
        if (target.origin !== new URL(server).origin || target.search || target.hash || !/^\/uploads\/[a-zA-Z0-9_.-]+$/.test(target.pathname)) return null;
        return target.pathname;
    } catch { return null; }
}
