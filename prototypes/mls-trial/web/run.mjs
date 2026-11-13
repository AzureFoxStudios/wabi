// Drives harness.html in headless Chromium. Usage: node run.mjs <dir with harness.html and build dirs> [sizes...]
// Uses the preinstalled Playwright/Chromium; does not run `playwright install`.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let pw;
try { pw = require("playwright"); } catch { pw = require("/opt/node22/lib/node_modules/playwright"); }

const root = process.argv[2];
const sizes = process.argv.slice(3).map(Number);
const SIZES = sizes.length ? sizes : [2, 10, 100];
const types = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
}).listen(0);
const port = server.address().port;

const browser = await pw.chromium.launch();
console.log("browser", browser.version());
const variants = [
  { v: "openmls_opt", suites: [1, 2] },
  { v: "mlsrs_rustcrypto_opt", suites: [1, 2] },
  { v: "mlsrs_webcrypto_opt", suites: [2] }, // mls-rs WebCrypto offers P-curve suites only
];
async function fresh(v) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/harness.html?v=${v}`);
  await page.waitForFunction(() => window.trial, null, { timeout: 60000 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  return { page, cdp, errors };
}
async function jsHeap(cdp) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return metrics.find((m) => m.name === "JSHeapUsedSize").value;
}
for (const { v, suites } of variants) {
  for (const cs of suites) {
    const { page, errors } = await fresh(v);
    const loadMs = await page.evaluate(() => window.trial.loadMs);
    const out = await page.evaluate((cs) => window.trial.scenario(cs), cs);
    console.log(`\n### ${v} suite ${cs} (module load+instantiate ${loadMs.toFixed(1)} ms)\n${out}`);
    if (errors.length) console.log("page errors:", errors);
    await page.close();
    for (const n of SIZES) {
      const { page, cdp, errors } = await fresh(v);
      const before = await page.evaluate(() => window.trial.wasmBytes());
      for (let i = 0; i < 3; i++) {
        const r = await page.evaluate(([n, cs]) => window.trial.bench(n, cs), [n, cs]);
        console.log(`BENCH ${v} browser cs=${cs} ${JSON.stringify(r)}`);
      }
      const after = await page.evaluate(() => window.trial.wasmBytes());
      console.log(`MEM ${v} cs=${cs} n=${n} wasm_memory_before=${before} wasm_memory_peak=${after} js_heap_used=${await jsHeap(cdp)}`);
      if (errors.length) console.log("page errors:", errors);
      await page.close();
    }
  }
}
await browser.close();
server.close();
