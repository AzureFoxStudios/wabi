/** Start the Sabi server: `node apps/server/src/main.ts [--demo] [--port 8080] [--data ./data]`. */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, seedDemo } from './app.ts';
import { createHttpServer } from './http.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function serve(opts: { port?: number; host?: string; dataDir?: string; demo?: boolean } = {}) {
  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = resolve(opts.dataDir ?? process.env.SABI_DATA ?? join(here, '../../../data'));
  const app = createApp({ dataDir });
  if (opts.demo && !app.isSetUp()) {
    console.log('Seeding demo workspace…');
    seedDemo(app);
  }
  const staticDir = resolve(process.env.SABI_WEB ?? join(here, '../../web/build'));
  const server = createHttpServer(app, { staticDir: existsSync(staticDir) ? staticDir : undefined });
  const port = opts.port ?? Number(process.env.PORT ?? 8080);
  const host = opts.host ?? process.env.HOST ?? '0.0.0.0';
  server.listen(port, host, () => {
    console.log(`Sabi listening on http://${host}:${port}  (data: ${dataDir})`);
    if (!app.isSetUp()) console.log('First run: open the web app to create the owner account.');
  });
  const stop = () => {
    server.close();
    app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serve({ port: arg('port') ? Number(arg('port')) : undefined, dataDir: arg('data'), demo: process.argv.includes('--demo') || process.env.SABI_DEMO === '1' });
}
