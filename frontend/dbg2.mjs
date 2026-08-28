import { compile } from 'svelte/compiler';
import { readFileSync } from 'node:fs';
const src = readFileSync('./src/lib/components/sidebar/VoiceChannelList.svelte', 'utf8');
const out = compile(src, { generate: 'client' });
const js = out.js.code;
// The @const row derivation: does the each-block re-key when voiceRowsById changes?
const i = js.indexOf('$.each(node');
console.log(js.slice(i, i + 500).replace(/\t/g,''));
