export interface PointerSample { x: number; y: number; t: number; speed: number; breakBefore: boolean; }
export interface PointerBounds { left: number; top: number; width: number; height: number; first: number; }
/** Small, screen-space motion history. No DOM, timers, or per-event allocations. */
export const POINTER_TRAIL_CAPACITY = 12;
export class PointerTrail {
    ring = Array.from({ length: POINTER_TRAIL_CAPACITY - 1 }, () => ({ x: 0, y: 0, t: 0, speed: 0, breakBefore: true }));
    head = 0;
    used = 0;
    committedAt = -Infinity;
    current = { x: 0, y: 0, t: -Infinity, speed: 0, breakBefore: true };
    vx = 0;
    vy = 0;
    clear() {
        this.head = this.used = 0;
        this.committedAt = this.current.t = -Infinity;
        this.vx = this.vy = this.current.speed = 0;
        this.current.breakBefore = true;
    }
    /** Keep the head exact, including subpixel movement. Identical coordinates are not activity. */
    push(x: number, y: number, now: number, lifetimeMs = 360): boolean {
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(now) || now < this.current.t)
            return false;
        const dx = x - this.current.x, dy = y - this.current.y;
        const distance = Math.hypot(dx, dy), elapsed = now - this.current.t;
        if (Number.isFinite(this.current.t) && distance === 0)
            return false;
        const cut = !Number.isFinite(this.current.t) || elapsed > lifetimeMs || distance > 480;
        if (cut) {
            this.head = this.used = 0;
            this.committedAt = -Infinity;
        }
        const dt = Math.max(4, elapsed);
        this.vx = cut ? 0 : Math.max(-5000, Math.min(5000, dx / dt * 1000));
        this.vy = cut ? 0 : Math.max(-5000, Math.min(5000, dy / dt * 1000));
        this.current.x = x;
        this.current.y = y;
        this.current.t = now;
        this.current.speed = Math.min(1, Math.hypot(this.vx, this.vy) / 1800);
        this.current.breakBefore = cut;
        // Keep time coverage at high mouse polling rates; the head remains exact between samples.
        if (now - this.committedAt >= Math.max(16, lifetimeMs / (POINTER_TRAIL_CAPACITY - 1))) {
            Object.assign(this.ring[this.head], this.current);
            this.head = (this.head + 1) % this.ring.length;
            this.used = Math.min(this.used + 1, this.ring.length);
            this.committedAt = now;
        }
        return true;
    }
    /** Caller owns/reuses the array. Returned objects belong to this trail; do not mutate them. */
    read(now: number, lifetimeMs: number, output: PointerSample[]): number {
        output.length = 0;
        if (!Number.isFinite(now) || !Number.isFinite(this.current.t) || !Number.isFinite(lifetimeMs) || lifetimeMs <= 0)
            return 0;
        // Input may arrive after the browser chose this frame's RAF timestamp.
        // It is fresh input, not an invalid future sample. Age it from zero.
        now = Math.max(now, this.current.t);
        if (now - this.current.t >= lifetimeMs)
            return 0;
        for (let i = 0; i < this.used; i++) {
            const item = this.ring[(this.head - this.used + i + this.ring.length) % this.ring.length];
            if (now >= item.t && now - item.t < lifetimeMs && item.t !== this.current.t)
                output.push(item);
        }
        output.push(this.current);
        return output.length;
    }
    writeUniforms(now: number, lifetimeMs: number, viewportHeight: number, output: Float32Array, scratch: PointerSample[]): number {
        const count = this.read(now, lifetimeMs, scratch);
        output.fill(0);
        for (let i = 0; i < count; i++) {
            const point = scratch[i];
            output[i * 4] = point.x;
            output[i * 4 + 1] = viewportHeight - point.y;
            output[i * 4 + 2] = Math.max(0, now - point.t) / 1000;
            output[i * 4 + 3] = point.breakBefore ? -(1 + point.speed) : point.speed;
        }
        return count;
    }
}
/** Keep the newest part of a long stroke, rather than allocating a screen-sized surface.
 * This is an explicit spatial budget: very long/fast sweeps may lose their oldest tail. */
export function pointerTrailBounds(points: readonly PointerSample[], radius: number, maxExtent = 1024): PointerBounds {
    if (!points.length)
        return { left: 0, top: 0, width: 0, height: 0, first: 0 };
    const padding = Math.min(Math.max(1, radius), maxExtent / 2);
    const last = points[points.length - 1];
    let minX = last.x - padding, minY = last.y - padding;
    let maxX = last.x + padding, maxY = last.y + padding, first = points.length - 1;
    for (let i = points.length - 2; i >= 0; i--) {
        const p = points[i];
        const x0 = Math.min(minX, p.x - padding), y0 = Math.min(minY, p.y - padding);
        const x1 = Math.max(maxX, p.x + padding), y1 = Math.max(maxY, p.y + padding);
        if (x1 - x0 > maxExtent || y1 - y0 > maxExtent)
            break;
        minX = x0;
        minY = y0;
        maxX = x1;
        maxY = y1;
        first = i;
    }
    const width = Math.min(maxExtent, Math.ceil((maxX - minX + 2) / 128) * 128);
    const height = Math.min(maxExtent, Math.ceil((maxY - minY + 2) / 128) * 128);
    return { left: Math.floor((minX + maxX - width) / 2), top: Math.floor((minY + maxY - height) / 2), width, height, first };
}
