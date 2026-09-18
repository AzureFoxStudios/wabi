import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, firefox } from 'playwright';

// Actual module workers in both browser engines, not fake Worker objects.
// This isolates worker ownership/calculation; it is not full application,
// native-webview, file-import-capacity, or call-coexistence acceptance.
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await mkdtemp(path.join(frontend, '.office-worker-browser-'));
const output = process.env.WORKSPACE_RESOURCE_DIR || '/tmp/wabi-office-resources';
await mkdir(output, { recursive: true });
const modulePath = relative => JSON.stringify(path.join(frontend, relative));
let server, browser;
const results = [], failures = [];
try {
    await writeFile(path.join(fixture, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', skipLibCheck: true } }));
    await writeFile(path.join(fixture, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Wabi worker acceptance</title></head><body><main>Spreadsheet worker acceptance</main><script type="module" src="/main.js"></script></body></html>');
    await writeFile(path.join(fixture, 'main.js'), `
        import {SheetWorker,SpreadsheetSupersededError} from ${modulePath('src/lib/workspaces/sheets/workerClient.ts')};
        import {createScaleFixture} from ${modulePath('scripts/office-scale-fixture.ts')};
        const NativeWorker=window.Worker;
        const counts={created:0,terminated:0,live:0,peak:0};
        window.Worker=class extends NativeWorker{
            closed=false;
            constructor(...args){super(...args);counts.created++;counts.live++;counts.peak=Math.max(counts.peak,counts.live);}
            terminate(){if(!this.closed){this.closed=true;counts.live--;counts.terminated++;}super.terminate();}
        };
        window.workerAcceptance={
            counts,
            async cycle(){const runner=new SheetWorker();try{const result=await runner.run('calculate',createScaleFixture(10,2));if(result.values['data/r9|c1']!==20||Object.keys(result.errors).length)throw new Error('Incorrect worker result');}finally{runner.close();runner.close();}},
            async dense(){
                const runner=new SheetWorker(),book=createScaleFixture(),start=performance.now();
                let frames=0,frame;const heartbeat=()=>{frames++;frame=requestAnimationFrame(heartbeat);};frame=requestAnimationFrame(heartbeat);
                try{const result=await runner.run('calculate',book);const values=Object.values(result.values);return {elapsedMs:performance.now()-start,frames,outputCells:values.length,total:values.reduce((a,b)=>a+b,0),errors:Object.keys(result.errors).length};}
                finally{cancelAnimationFrame(frame);runner.close();}
            },
            async burst(){
                const runner=new SheetWorker(),book=createScaleFixture(10,2);
                const settle=p=>p.then(()=>({success:true}),e=>({success:false,superseded:e instanceof SpreadsheetSupersededError}));
                try{const first=settle(runner.run('calculate',book));const rest=Array.from({length:500},()=>settle(runner.run('calculate',book)));const values=await Promise.all([first,...rest]);return {successes:values.filter(v=>v.success).length,superseded:values.filter(v=>v.superseded).length};}
                finally{runner.close();}
            },
            async cancelImport(){
                const runner=new SheetWorker(),buffer=new TextEncoder().encode('00127,=literal\\n').buffer,size=buffer.byteLength;
                const pending=runner.run('import',{buffer,name:'private.csv'}).then(()=>false,()=>true);
                runner.close();return {cancelled:await pending,retainedBytes:buffer.byteLength,originalBytes:size};
            }
        };`);
    server = await createServer({ configFile: false, root: fixture, worker: { format: 'es' }, optimizeDeps: { rolldownOptions: { tsconfig: false } }, server: { host: '127.0.0.1', port: 0, fs: { allow: [frontend] } }, logLevel: 'warn' });
    await server.listen();
    const origin = server.resolvedUrls.local[0];
    for (const [name, engine] of [['chromium', chromium], ['firefox', firefox]]) {
        browser = await engine.launch({ headless: true, ...(name === 'chromium' ? { args: ['--no-sandbox'] } : {}) });
        const context = await browser.newContext(), page = await context.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.setDefaultTimeout(30000);
        const released = async () => {
            for (let attempt = 0; attempt < 100 && page.workers().length; attempt++) await delay(25);
            assert.equal(page.workers().length, 0, `${name}: browser still reports a live worker after close`);
            assert.equal(await page.evaluate(() => window.workerAcceptance.counts.live), 0);
        };
        try {
            await page.goto(origin);
            await page.waitForFunction(() => !!window.workerAcceptance);
            assert.deepEqual(await page.evaluate(() => window.workerAcceptance.counts), { created: 0, terminated: 0, live: 0, peak: 0 });
            assert.equal(page.workers().length, 0, 'Loading registration code must not start an engine');
            const dense = await page.evaluate(() => window.workerAcceptance.dense());
            assert.equal(dense.outputCells, 200000); assert.equal(dense.errors, 0); assert.equal(dense.total, 200000 * 200001 / 2);
            assert(dense.frames > 0, 'Main-thread animation must advance while the worker calculates');
            await released();
            const burst = await page.evaluate(() => window.workerAcceptance.burst());
            assert.deepEqual(burst, { successes: 2, superseded: 499 }); await released();
            const cancel = await page.evaluate(() => window.workerAcceptance.cancelImport());
            assert(cancel.cancelled); assert(cancel.retainedBytes > 0); assert.equal(cancel.retainedBytes, cancel.originalBytes); await released();
            // Warm the module/browser caches before any heap observation.
            for (let i = 0; i < 3; i++) { await page.evaluate(() => window.workerAcceptance.cycle()); await released(); }
            const cdp = name === 'chromium' ? await context.newCDPSession(page) : null;
            const heap = async () => { if (!cdp) return null; await cdp.send('HeapProfiler.collectGarbage'); return (await cdp.send('Runtime.getHeapUsage')).usedSize; };
            const beforeHeapBytes = await heap();
            for (let i = 0; i < 25; i++) { await page.evaluate(() => window.workerAcceptance.cycle()); await released(); }
            const afterHeapBytes = await heap();
            const counts = await page.evaluate(() => window.workerAcceptance.counts);
            assert.equal(counts.created, 31); assert.equal(counts.terminated, 31); assert.equal(counts.live, 0); assert.equal(counts.peak, 1);
            assert.deepEqual(errors, []);
            results.push({ browser: name, dense, burst, cancel, counts, browserWorkersAfterClose: page.workers().length,
                heap: { beforeHeapBytes, afterHeapBytes, deltaBytes: beforeHeapBytes === null ? null : afterHeapBytes - beforeHeapBytes, scope: 'Main-page JS heap after forced GC; observation only, not native RSS or a leak certificate' } });
            console.log(JSON.stringify(results.at(-1)));
            await cdp?.detach();
        } catch (error) { failures.push({ browser: name, error: error.stack || String(error), pageErrors: errors }); }
        finally { await browser.close(); browser = null; }
    }
} finally {
    await browser?.close(); await server?.close(); await rm(fixture, { recursive: true, force: true });
    await writeFile(path.join(output, 'worker-browser-results.json'), JSON.stringify({ scope: 'Isolated worker/calculation acceptance; import ceiling remains unchanged', results, failures }, null, 2));
}
assert.equal(results.length, 2, JSON.stringify(failures, null, 2));
assert.deepEqual(failures, []);
console.log('Spreadsheet real-browser worker lifecycle and 200,000-cell calculation: both engines passed.');
