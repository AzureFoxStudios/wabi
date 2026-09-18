import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

/** Poll the resolved value of an asynchronous page predicate, not its Promise.
 * Reads only: never open/sync an editor to make a persistence assertion pass.
 * Synchronous DOM conditions can still use Playwright's waitForFunction.
 */
export async function waitForState(page, predicate, arg, { timeout = 20000, interval = 50 } = {}) {
    assert(Number.isFinite(timeout) && timeout > 0);
    assert(Number.isFinite(interval) && interval > 0);
    const deadline = performance.now() + timeout;
    let value;
    do {
        // page.evaluate explicitly awaits a returned Promise before serializing.
        value = await page.evaluate(predicate, arg);
        if (value === true) return;
        if (performance.now() >= deadline) break;
        await delay(Math.min(interval, deadline - performance.now()));
    } while (performance.now() < deadline);
    assert.fail(`Async workspace condition did not become true within ${timeout} ms; last value: ${JSON.stringify(value)}; predicate: ${String(predicate)}`);
}

/** Run before browser acceptance so a broken wait cannot create false passes. */
export async function verifyStateWaiter() {
    let attempts = 0;
    await waitForState({ evaluate: async () => ++attempts >= 3 }, () => true, null, { timeout: 1000, interval: 1 });
    assert.equal(attempts, 3);
    await assert.rejects(waitForState({ evaluate: async () => false }, () => false, null, { timeout: 10, interval: 1 }), /did not become true/);
    await assert.rejects(waitForState({ evaluate: async () => { throw new Error('storage read failed'); } }, () => true), /storage read failed/);
}
