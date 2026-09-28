import { createServer } from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createEngine } from './engine.mjs';

export async function startDemo({ port = 47312, directory } = {}) {
  directory ??= await mkdtemp(join(tmpdir(), 'wabi-team-demo-'));
  const engine = await createEngine(directory);
  const token = randomBytes(24).toString('hex');
  const assets = new Map(await Promise.all(['index.html', 'app.js', 'style.css'].map(async name => [name, await readFile(new URL(name, import.meta.url))])));
  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.headers.host !== new URL(origin).host) return json(403, { error: 'Loopback host required.' });
    try {
      if (req.method === 'GET' && req.url === '/api/state') return json(200, { state: engine.snapshot(), token });
      if (req.method === 'POST' && req.url === '/api/action') {
        if (req.headers.origin !== origin || req.headers['x-demo-token'] !== token || !req.headers['content-type']?.startsWith('application/json')) return json(403, { error: 'Same-origin demo request required.' });
        const chunks = [];
        let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 8000) return json(413, { error: 'Request too large.' }); chunks.push(chunk); }
        const result = await engine.dispatch(JSON.parse(Buffer.concat(chunks).toString()));
        return json(result.outcome === 'conflict' ? 409 : 200, result);
      }
      const name = req.url === '/' ? 'index.html' : req.url.slice(1);
      if (req.method === 'GET' && assets.has(name)) {
        res.writeHead(200, { 'Content-Type': name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html' });
        return res.end(assets.get(name));
      }
      json(404, { error: 'Not found' });
    } catch (error) { json(error.status || 400, { error: error.message }); }
  });
  server.requestTimeout = 15000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, engine, directory, url: `http://127.0.0.1:${server.address().port}` };
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const demo = await startDemo({ port: Number(process.env.DEMO_PORT || 47312), directory: process.env.DEMO_STATE_DIR });
  console.log(JSON.stringify({ url: demo.url, stateDirectory: demo.directory, mode: 'local-prototype; recorded-model-proposals; live-tests' }));
}
