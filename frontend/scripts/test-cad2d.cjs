/* Isolated DXF parser checks. Does not boot Svelte or fetch remote files. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/lib/cad2d.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const box = { exports: {}, require, console, Math, Number, Set, Error };
vm.runInNewContext(compiled, box, { filename: 'cad2d.ts' });
const cad = box.exports;

const DXF = `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n8\nOUTLINE\n10\n0\n20\n0\n11\n100\n21\n0\n0\nLWPOLYLINE\n8\nDETAIL\n70\n1\n10\n10\n20\n10\n10\n30\n20\n10\n10\n30\n20\n30\n0\nCIRCLE\n8\nHOLES\n10\n50\n20\n25\n40\n5\n0\nARC\n8\nDETAIL\n10\n50\n20\n25\n40\n20\n50\n0\n51\n90\n0\nPOINT\n8\nMARKERS\n10\n5\n20\n5\n0\nTEXT\n8\nNOTES\n10\n20\n20\n20\n40\n2.5\n1\nMOUNT HERE\n0\nENDSEC\n0\nEOF\n`;

test('parses common 2D geometry, units, layers and text', () => {
  const drawing = cad.parseAsciiDxf(DXF);
  assert.equal(drawing.unit, 'mm');
  assert.equal(drawing.entities.length, 6);
  assert.deepEqual(Array.from(drawing.layers), ['DETAIL','HOLES','MARKERS','NOTES','OUTLINE']);
  assert.equal(drawing.bounds.minX, 0);
  assert.equal(drawing.bounds.maxX, 100);
  assert.ok(drawing.bounds.maxY >= 45);
  assert.equal(drawing.entities.find((entity) => entity.type === 'TEXT').text, 'MOUNT HERE');
});

test('arc endpoints and snap points are stable', () => {
  const drawing = cad.parseAsciiDxf(DXF);
  const arc = drawing.entities.find((entity) => entity.type === 'ARC');
  const points = cad.cadArcPoints(arc);
  assert.ok(Math.abs(points[0].x - 70) < 1e-6);
  assert.ok(Math.abs(points.at(-1).y - 45) < 1e-6);
  const snap = cad.nearestCadSnap(drawing.entities, {x:0.2,y:0.1}, 1);
  assert.equal(snap.x, 0); assert.equal(snap.y, 0);
});

test('MTEXT formatting controls are stripped without eating content', () => {
  const textDxf = `0\nSECTION\n2\nENTITIES\n0\nMTEXT\n8\nNOTES\n10\n1\n20\n2\n40\n2.5\n1\n{\\A1;FIRST\\PSECOND}\n0\nENDSEC\n0\nEOF\n`;
  const drawing = cad.parseAsciiDxf(textDxf);
  assert.equal(drawing.entities[0].text, 'FIRST · SECOND');
});

test('screen mapping honors SVG aspect-preserving letterbox', () => {
  const viewBox = { x: 0, y: -50, width: 100, height: 50 };
  assert.equal(cad.cadScreenToDrawingPoint(100, 25, 200, 200, viewBox), null);
  const center = cad.cadScreenToDrawingPoint(100, 100, 200, 200, viewBox);
  assert.ok(Math.abs(center.x - 50) < 1e-9);
  assert.ok(Math.abs(center.y - 25) < 1e-9);
  assert.equal(cad.cadViewportScale(200, 200, viewBox), 2);
});

test('binary and unsupported-only DXF fail honestly', () => {
  assert.throws(() => cad.parseAsciiDxf('AutoCAD Binary DXF\r\n'), /Binary DXF/);
  assert.throws(() => cad.parseAsciiDxf('0\nSECTION\n2\nENTITIES\n0\nHATCH\n0\nENDSEC\n0\nEOF\n'), /no supported 2D entities/);
});

test('DIMENSION expands its anonymous block, with def-point fallback', () => {
  const blockDxf = `0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n2\n*D1\n0\nLINE\n8\n0\n10\n0\n20\n0\n11\n22\n21\n0\n0\nTEXT\n8\n0\n10\n10\n20\n5\n40\n2.5\n1\n22\n0\nENDBLK\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nDIMENSION\n8\n0\n2\n*D1\n10\n11\n20\n0\n11\n10\n21\n2\n13\n0\n23\n0\n14\n22\n24\n0\n0\nDIMENSION\n8\n0\n10\n31\n20\n0\n11\n30\n21\n2\n13\n20\n23\n0\n14\n42\n24\n0\n0\nENDSEC\n0\nEOF\n`;
  const drawing = cad.parseAsciiDxf(blockDxf);
  const texts = drawing.entities.filter((e) => e.type === 'TEXT').map((e) => e.text);
  assert.ok(texts.includes('22'), 'block label inlined, got ' + JSON.stringify(texts));
  assert.ok(texts.includes('22.00') || texts.includes('22'), 'fallback measurement synthesized, got ' + JSON.stringify(texts));
  assert.ok(drawing.entities.some((e) => e.type === 'LINE'), 'dimension graphics present');
});
