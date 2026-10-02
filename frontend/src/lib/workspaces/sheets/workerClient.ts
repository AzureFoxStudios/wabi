type Operation = 'calculate' | 'import' | 'export';
interface Job {
    id: number;
    type: Operation;
    payload: unknown;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
}
export interface SheetWorkerOptions {
    /** Dependency injection for lifecycle tests; never invoked until a job starts. */
    createWorker?: () => Worker;
    timeoutMs?: number;
}
export class SpreadsheetSupersededError extends Error {
    constructor() { super('Spreadsheet calculation superseded by newer input.'); this.name = 'SpreadsheetSupersededError'; }
}

/** One running operation and, for calculations only, one latest queued input.
 * A quick typist must not enqueue an unbounded number of cloned workbooks.
 * This object can be reused after close(), but old-worker callbacks cannot
 * complete or terminate a new generation. Closing never alters saved data.
 */
export class SheetWorker {
    private worker: Worker | null = null;
    private sequence = 0;
    private active: Job | null = null;
    private queued: Job | null = null;
    private readonly createWorker: () => Worker;
    private readonly timeoutMs: number;

    constructor(options: SheetWorkerOptions = {}) {
        this.createWorker = options.createWorker || (() => new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' }));
        this.timeoutMs = options.timeoutMs ?? 30000;
        if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30000) throw new Error('Invalid spreadsheet operation timeout.');
    }

    private get(): Worker {
        if (this.worker) return this.worker;
        const worker = this.createWorker();
        this.worker = worker;
        worker.onmessage = event => {
            if (this.worker !== worker) return;
            const data: unknown = event.data;
            if (!data || typeof data !== 'object' || !('id' in data) || !Number.isSafeInteger(data.id)) {
                this.close('Spreadsheet engine returned an invalid response; saved work is retained.');
                return;
            }
            const job = this.active;
            if (!job || data.id !== job.id) return;
            if ('error' in data && typeof data.error !== 'string' || !('error' in data) && !('result' in data)) {
                this.close('Spreadsheet engine returned an invalid response; saved work is retained.');
                return;
            }
            this.active = null;
            if (job.timer !== undefined) clearTimeout(job.timer);
            if ('error' in data) job.reject(new Error(String(data.error)));
            else job.resolve(data.result);
            this.pump();
        };
        worker.onerror = () => {
            if (this.worker === worker) this.close('Spreadsheet engine failed; the original and saved work are retained.');
        };
        worker.onmessageerror = () => {
            if (this.worker === worker) this.close('Spreadsheet response could not be decoded; saved work is retained.');
        };
        return worker;
    }

    private pump(): void {
        if (this.active || !this.queued) return;
        const job = this.queued;
        this.queued = null;
        this.active = job;
        try {
            const worker = this.get();
            job.timer = setTimeout(() => {
                if (this.active === job && this.worker === worker) this.close('Spreadsheet operation exceeded its time limit. Nothing was published.');
            }, this.timeoutMs);
            // Deliberately do not transfer the caller's input. Cancellation or
            // a clone failure must not detach the retained source file bytes.
            worker.postMessage({ id: job.id, type: job.type, payload: job.payload });
        } catch (error) {
            this.close(error instanceof Error ? error.message : 'Spreadsheet operation could not start.');
        }
    }

    run<T>(type: Operation, payload: unknown): Promise<T> {
        if (!['calculate', 'import', 'export'].includes(type)) return Promise.reject(new Error('Unknown spreadsheet operation.'));
        if (this.active && (type !== 'calculate' || this.active.type !== 'calculate')) {
            return Promise.reject(new Error('A spreadsheet file operation is already running. Cancel it before starting another.'));
        }
        return new Promise<T>((resolve, reject) => {
            const next: Job = { id: ++this.sequence, type, payload, resolve: resolve as (value: unknown) => void, reject };
            if (this.queued) this.queued.reject(new SpreadsheetSupersededError());
            this.queued = next;
            this.pump();
        });
    }

    close(reason = 'Spreadsheet operation cancelled'): void {
        const worker = this.worker, active = this.active, queued = this.queued;
        // Clear ownership before termination/rejection, so late events cannot
        // race a subsequent run() into the wrong generation.
        this.worker = null;
        this.active = this.queued = null;
        if (worker) {
            worker.onmessage = worker.onerror = worker.onmessageerror = null;
            worker.terminate();
        }
        for (const job of [active, queued]) if (job) {
            if (job.timer !== undefined) clearTimeout(job.timer);
            job.reject(new Error(reason));
        }
    }
}
