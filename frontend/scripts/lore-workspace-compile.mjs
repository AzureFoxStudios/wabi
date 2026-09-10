/** Compile the real Svelte markup, not only its TypeScript script block. */
import { compile } from 'svelte/compiler';
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
