#!/usr/bin/env node
// Produce a portable plugin with the operator's endpoint and no credentials.
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export async function packagePlugin(endpoint, outputDir) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/mcp') throw Error('Use the connector’s bare HTTPS /mcp URL.');
  const target = resolve(outputDir), source = fileURLToPath(new URL('../integrations/wabi-project-plugin/', import.meta.url));
  // Existing destinations are refused so packaging cannot overwrite user work.
  await mkdir(target, { recursive: false });
  try {
    await cp(`${source}/skills`, `${target}/skills`, { recursive: true, errorOnExist: true });
    await writeFile(`${target}/plugin.json`, await readFile(`${source}/plugin.json`), { flag: 'wx' });
    await writeFile(`${target}/mcp.json`, JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { wabi: { type: 'streamable-http', url: url.href } } }, null, 2) + '\n', { flag: 'wx' });
    return target;
  } catch (error) { await rm(target, { recursive: true, force: true }); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw Error();
    process.stdout.write(`${await packagePlugin(process.argv[2], process.argv[3])}\n`);
  } catch { process.stderr.write('Use package-wabi-project-plugin.mjs HTTPS_MCP_URL NEW_OUTPUT_DIRECTORY. Existing output directories are refused.\n'); process.exitCode = 1; }
}
