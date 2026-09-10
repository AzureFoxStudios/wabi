/** Compile the real Svelte markup, not only its TypeScript script block. */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
// CI can validate markup with the repository-pinned compiler in an isolated tool
// directory, while the full frontend job continues to enforce its own lockfile.
const require = createRequire(process.env.LORE_VALIDATOR_DIR
  ? resolve(process.env.LORE_VALIDATOR_DIR, 'package.json') : import.meta.url);
const { compile } = require('svelte/compiler');
console.log(`Svelte compiler ${require('svelte/package.json').version}`);
import { readFileSync } from 'node:fs';
const files = [
  'LoreWorkspace.svelte', 'LoreRepositoryWorkspace.svelte',
  ...['LoreChannelShell','LoreProjectWorkspace','LoreFileViewer','LoreHistoryBrowser','LoreRolesAdmin','LoreDialog','LoreIcon'].map(name => `lore/${name}.svelte`)
];
let errors = 0, warnings = 0;
for (const file of files) {
  const filename = new URL(`../src/lib/components/${file}`, import.meta.url);
  const source = readFileSync(filename, 'utf8');
  for (const generate of ['client', 'server']) {
    try {
      const result = compile(source, { filename: filename.pathname, generate, dev: true });
      for (const warning of result.warnings) {
        warnings++;
        console.warn(`${file} (${generate}): ${warning.code}: ${warning.message}`);
      }
      console.log(`Compiled ${file} (${generate})`);
    } catch (error) {
      errors++;
      console.error(`${file} (${generate}): ${error.message}\n${error.frame ?? ''}`);
    }
  }
}
console.log(`${files.length * 2} Svelte compilation targets; ${errors} errors; ${warnings} warnings.`);
process.exitCode = errors ? 1 : 0;
