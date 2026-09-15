/* Isolated inspection helper checks; WebGL integration is covered by the app build/smoke pass. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const file = path.join(__dirname, '../src/lib/components/plugins/modelInspector.ts');
const source = fs.readFileSync(file, 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, strict: true } }).outputText;
const box = { exports: {}, require, console, Math, Number, Object };
vm.runInNewContext(output, box, { filename: 'modelInspector.ts' });
const logic = box.exports;

test('physical units convert only when source scale is explicit', () => {
  assert.equal(logic.convertLength(25.4, 'mm', 'in'), 1);
  assert.equal(logic.convertLength(10, 'model', 'mm'), null);
  assert.equal(logic.formatLength(10, 'model', 'model'), '10 units');
});

test('camera framing stays finite across wide and narrow viewports', () => {
  for (const aspect of [0.32, 0.5, 1, 2, 4]) {
    const distance = logic.frameDistance({ x: 100, y: 20, z: 10 }, 55, aspect);
    assert.ok(Number.isFinite(distance) && distance > 0);
  }
});

test('section positions clamp safely', () => {
  assert.equal(logic.sectionCoordinate(-10, 10, 50), 0);
  assert.equal(logic.sectionCoordinate(-10, 10, -20), -10);
  assert.equal(logic.sectionCoordinate(-10, 10, 120), 10);
});

test('model format gate is honest about CAD and MMD', () => {
  for (const name of ['a.glb', 'a.gltf', 'a.obj', 'a.stl']) assert.equal(logic.modelFormatMessage(name), null);
  assert.match(logic.modelFormatMessage('a.step'), /CAD adapter/);
  assert.match(logic.modelFormatMessage('a.pmx'), /MMD adapter/);
});

test('visibility accounts for hidden parents', () => {
  const root = { visible: true, parent: null };
  const hidden = { visible: false, parent: root };
  const child = { visible: true, parent: hidden };
  assert.equal(logic.effectivelyVisible(child), false);
  hidden.visible = true;
  assert.equal(logic.effectivelyVisible(child), true);
});
