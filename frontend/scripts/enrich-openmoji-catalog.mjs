// OpenMoji 15.1.0 metadata, CC BY-SA 4.0. See static/openmoji/README.md.
// This maintenance command enriches the committed catalog; it does not fetch or
// replace image assets. IDs, shortcodes, URLs and ordering must remain stable.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const source = 'https://raw.githubusercontent.com/hfg-gmuend/openmoji/15.1.0/data/openmoji.json';
const expectedHash = '04d3915370f10f7e9094747bc1be0402973eeb5f2486df727630e494519dd218';
const response = await fetch(source);
if (!response.ok) throw new Error(`OpenMoji metadata unavailable: HTTP ${response.status}`);
const raw = await response.text();
if (createHash('sha256').update(raw).digest('hex') !== expectedHash) {
  throw new Error('OpenMoji metadata checksum mismatch; catalog was not changed.');
}
const metadata = new Map(JSON.parse(raw).map((entry) => [entry.hexcode, entry]));
const catalogPath = new URL('../static/openmoji/emojis.json', import.meta.url);
const original = await readFile(catalogPath, 'utf8');
const catalog = JSON.parse(original);
const enriched = catalog.map((emoji) => {
  const entry = metadata.get(emoji.id);
  if (!entry?.annotation || !entry.openmoji_author) {
    throw new Error(`No matching OpenMoji 15.1.0 metadata for ${emoji.id}; catalog was not changed.`);
  }
  return { ...emoji, displayName: entry.annotation, artist: entry.openmoji_author };
});
const result = `${JSON.stringify(enriched)}\n`;
if (process.argv.includes('--check')) {
  if (original !== result) throw new Error('OpenMoji display metadata needs regeneration.');
  console.log(`Verified ${catalog.length} OpenMoji display names against pinned metadata.`);
} else {
  await writeFile(catalogPath, result);
  console.log(`Enriched ${catalog.length} OpenMoji entries without changing identifiers.`);
}
