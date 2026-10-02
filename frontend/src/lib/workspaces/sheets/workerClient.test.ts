import { describe, expect, test } from 'bun:test';
import { SheetWorker, SpreadsheetSupersededError } from './workerClient';

type Sent = { id: number; type: string; payload: unknown };
class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessageerror: (() => void) | null = null;
    messages: Sent[] = [];
    terminated = 0;
    failPost = false;
    postMessage(message: Sent) { if (this.failPost) throw new Error('Cannot clone input'); this.messages.push(message); }
    terminate() { this.terminated++; }
    reply(result: unknown, id = this.messages.at(-1)!.id) { this.onmessage?.({ data: { id, result } }); }
}
function setup(timeoutMs = 1000) {
    const workers: FakeWorker[] = [];
    const bridge = new SheetWorker({ timeoutMs, createWorker: () => {
        const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker;
    } });
    return { bridge, workers };
}
const outcome = <T>(promise: Promise<T>) => promise.then(value => ({ value, error: null }), error => ({ value: undefined, error }));

describe('bounded spreadsheet worker lifecycle', () => {
    test('is lazy and close is idempotent; next use starts a fresh worker', async () => {
        const { bridge, workers } = setup();
        expect(workers.length).toBe(0); bridge.close(); bridge.close(); expect(workers.length).toBe(0);
        const result = bridge.run<number>('calculate', {});
        expect(workers.length).toBe(1); workers[0].reply(42); expect(await result).toBe(42);
        bridge.close(); bridge.close(); expect(workers[0].terminated).toBe(1);
        expect(workers[0].onmessage).toBe(null); expect(workers[0].onerror).toBe(null); expect(workers[0].onmessageerror).toBe(null);
        const second = bridge.run<string>('calculate', {}); workers[1].reply('new'); expect(await second).toBe('new'); bridge.close();
    });

    test('a burst retains only the running calculation and the latest queued input', async () => {
        const { bridge, workers } = setup();
        try {
            const first = bridge.run<number>('calculate', 'first');
            const pending = Array.from({ length: 500 }, (_, i) => outcome(bridge.run<number>('calculate', i)));
            expect(workers[0].messages.length).toBe(1);
            workers[0].reply(1);
            expect(await first).toBe(1);
            expect(workers[0].messages.length).toBe(2);
            expect(workers[0].messages[1].payload).toBe(499);
            workers[0].reply(500);
            const results = await Promise.all(pending);
            expect(results.filter(item => item.error instanceof SpreadsheetSupersededError).length).toBe(499);
            expect(results[499].value).toBe(500);
        } finally { bridge.close(); }
    });

    test('does not supersede a file import/export or detach its source buffer', async () => {
        const { bridge, workers } = setup();
        try {
            const source = new Uint8Array([1, 2, 3]).buffer;
            const imported = bridge.run<string>('import', { buffer: source });
            await expect(bridge.run('export', {})).rejects.toThrow('already running');
            await expect(bridge.run('calculate', {})).rejects.toThrow('already running');
            expect(source.byteLength).toBe(3);
            workers[0].reply('imported'); expect(await imported).toBe('imported');
            const exported = bridge.run<string>('export', {}); workers[0].reply('exported'); expect(await exported).toBe('exported');
        } finally { bridge.close(); }
    });

    test('closing cancels both active and queued jobs and clears callbacks', async () => {
        const { bridge, workers } = setup();
        const active = outcome(bridge.run('calculate', 'active')), queued = outcome(bridge.run('calculate', 'queued'));
        bridge.close('disabled');
        expect((await active).error.message).toBe('disabled'); expect((await queued).error.message).toBe('disabled');
        expect(workers[0].messages.length).toBe(1); expect(workers[0].terminated).toBe(1);
        expect(workers[0].onmessage).toBe(null);
    });

    test('old generation messages and errors cannot complete or kill a replacement worker', async () => {
        const { bridge, workers } = setup();
        const old = outcome(bridge.run('calculate', {}));
        const oldMessage = workers[0].onmessage!, oldError = workers[0].onerror!, oldDecodeError = workers[0].onmessageerror!;
        bridge.close(); await old;
        const current = bridge.run<number>('calculate', {});
        oldMessage({ data: { id: workers[1].messages[0].id, result: 999 } }); oldError(); oldDecodeError();
        expect(workers[1].terminated).toBe(0);
        workers[1].reply(7); expect(await current).toBe(7); bridge.close();
    });

    test('ignores duplicate/stale response IDs within a generation', async () => {
        const { bridge, workers } = setup();
        const first = bridge.run('calculate', {}), second = bridge.run('calculate', {});
        const id = workers[0].messages[0].id;
        workers[0].reply('first', id); await first;
        workers[0].reply('duplicate', id);
        workers[0].reply('second'); expect(await second).toBe('second'); bridge.close();
    });

    test('worker errors and decode failures reject pending work and allow explicit retry', async () => {
        for (const event of ['onerror', 'onmessageerror'] as const) {
            const { bridge, workers } = setup();
            const active = outcome(bridge.run('calculate', {})), queued = outcome(bridge.run('calculate', {}));
            workers[0][event]!();
            expect((await active).error).toBeInstanceOf(Error); expect((await queued).error).toBeInstanceOf(Error);
            expect(workers[0].terminated).toBe(1);
            const retry = bridge.run('calculate', {}); workers[1].reply('retried'); expect(await retry).toBe('retried'); bridge.close();
        }
    });

    test('invalid matching response fails visibly instead of resolving undefined', async () => {
        const { bridge, workers } = setup();
        const result = outcome(bridge.run('calculate', {}));
        workers[0].onmessage!({ data: { id: workers[0].messages[0].id } });
        expect((await result).error.message).toContain('invalid response'); expect(workers[0].terminated).toBe(1);
    });

    test('operation errors do not discard the latest valid queued calculation', async () => {
        const { bridge, workers } = setup();
        const first = outcome(bridge.run('calculate', {})), next = bridge.run('calculate', {});
        workers[0].onmessage!({ data: { id: workers[0].messages[0].id, error: 'Invalid workbook' } });
        expect((await first).error.message).toBe('Invalid workbook'); expect(workers[0].messages.length).toBe(2);
        workers[0].reply('valid'); expect(await next).toBe('valid'); bridge.close();
    });

    test('construction and postMessage failures release their timers and work', async () => {
        const missing = new SheetWorker({ createWorker: () => { throw new Error('Unavailable worker'); } });
        await expect(missing.run('calculate', {})).rejects.toThrow('Unavailable worker'); missing.close();
        const fake = new FakeWorker(); fake.failPost = true;
        const broken = new SheetWorker({ createWorker: () => fake as unknown as Worker });
        await expect(broken.run('calculate', {})).rejects.toThrow('Cannot clone input');
        expect(fake.terminated).toBe(1); expect(fake.onerror).toBe(null); broken.close();
    });

    test('timeout terminates active work and cancels the queued snapshot', async () => {
        const { bridge, workers } = setup(15);
        const active = outcome(bridge.run('calculate', {})), queued = outcome(bridge.run('calculate', {}));
        expect((await active).error.message).toContain('time limit');
        expect((await queued).error.message).toContain('time limit');
        expect(workers[0].terminated).toBe(1); expect(workers[0].messages.length).toBe(1); bridge.close();
    });

    test('repeated enable/use/disable releases every owned worker', async () => {
        const { bridge, workers } = setup();
        for (let i = 0; i < 40; i++) {
            const result = bridge.run<number>('calculate', i); workers[i].reply(i); expect(await result).toBe(i); bridge.close();
        }
        expect(workers.length).toBe(40);
        expect(workers.every(worker => worker.terminated === 1 && worker.onmessage === null && worker.onerror === null && worker.onmessageerror === null)).toBe(true);
    });
});
