import { compile, VERSION } from 'svelte/compiler';
import { readFileSync } from 'node:fs';
const files = ['PeoplePicker','DmHub','DMTab','DmConversationHeader','DmConversationView','lore/LoreCodePanel','lore/LoreFileViewer'];
console.log(`Svelte compiler ${VERSION}`);
for (const file of files) {
  const url = new URL(`../src/lib/components/${file}.svelte`, import.meta.url);
  const source = readFileSync(url, 'utf8');
  for (const generate of ['client','server']) {
    const result = compile(source, { filename: url.pathname, generate, dev: true });
    for (const warning of result.warnings) console.warn(`${file}: ${warning.code}: ${warning.message}`);
    console.log(`PASS ${generate}: ${file}`);
  }
}
