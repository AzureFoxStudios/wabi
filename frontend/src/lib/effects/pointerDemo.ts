export interface PointerDemoBounds { left: number; top: number; width: number; height: number; }
type DemoFeed = (x: number, y: number, now: number) => void;
/** A visual demonstration only: never moves the OS pointer or dispatches input events. */
export const POINTER_DEMO_REQUEST = 'wabi:pointer-demo-request';
export const POINTER_DEMO_STOP = 'wabi:pointer-demo-stop';
export const POINTER_DEMO_STATE = 'wabi:pointer-demo-state';
/** Clip a settings preview area to the visible viewport before choosing a path. */
export function visibleDemoBounds(input: unknown, width: number, height: number): PointerDemoBounds | null {
    if (!input || typeof input !== 'object' || !Number.isFinite(width) || !Number.isFinite(height))
        return null;
    const b = input as PointerDemoBounds;
    if (![b.left, b.top, b.width, b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0)
        return null;
    const left = Math.max(8, b.left), top = Math.max(8, b.top);
    const right = Math.min(width - 8, b.left + b.width), bottom = Math.min(height - 8, b.top + b.height);
    return right - left >= 64 && bottom - top >= 64
        ? { left, top, width: right - left, height: bottom - top } : null;
}
export function pointerDemoPoint(progress: number, bounds: PointerDemoBounds): { x: number; y: number } {
    const t = Math.max(0, Math.min(1, progress));
    const inset = Math.min(32, bounds.width * 0.1);
    return {
        x: bounds.left + inset + (bounds.width - 2 * inset) * t,
        y: bounds.top + bounds.height * 0.5 + Math.sin(t * Math.PI * 2) * Math.min(75, bounds.height * 0.3)
    };
}
/** The sample and physical pointer share the caller's feed function and performance.now clock.
 * RAF is only a scheduler: its older frame timestamp must not timestamp new input samples. */
export class PointerDemoSweep {
    frame: number | null = null;
    startedAt = 0;
    bounds: PointerDemoBounds | null = null;
    active = false;
    feed: DemoFeed;
    onState: (running: boolean) => void;
    durationMs: number;
    constructor(feed: DemoFeed, onState: (running: boolean) => void = () => { }, durationMs = 1100) {
        this.feed = feed;
        this.onState = onState;
        this.durationMs = durationMs;
    }
    get running() { return this.active; }
    start(bounds: PointerDemoBounds) {
        this.cancel();
        this.bounds = { ...bounds };
        this.startedAt = performance.now();
        this.active = true;
        this.onState(true);
        this.frame = requestAnimationFrame(this.step);
    }
    step = () => {
        this.frame = null;
        if (!this.active || !this.bounds)
            return;
        const now = performance.now();
        const t = Math.min(1, Math.max(0, now - this.startedAt) / Math.max(1, this.durationMs));
        const point = pointerDemoPoint(t, this.bounds);
        this.feed(point.x, point.y, now);
        if (!this.active)
            return;
        if (t >= 1)
            this.cancel();
        else
            this.frame = requestAnimationFrame(this.step);
    };
    cancel() {
        if (this.frame !== null)
            cancelAnimationFrame(this.frame);
        this.frame = null;
        this.bounds = null;
        if (!this.active)
            return;
        this.active = false;
        this.onState(false);
    }
}
