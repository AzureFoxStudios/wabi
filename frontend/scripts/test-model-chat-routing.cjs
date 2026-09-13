/* Isolated model/CAD recognition and route-order checks. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const file = path.join(__dirname, '../src/lib/modelAttachmentPolicy.ts');
const source = fs.readFileSync(file, 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const box = { exports: {}, require, console, Math, Number, Object, Set, URL, Error };
vm.runInNewContext(output, box, { filename: 'modelAttachmentPolicy.ts' });
const policy = box.exports;

for (const ext of ['glb','gltf','obj','stl']) test(`mesh ${ext}`, () => assert.equal(policy.modelFamily(`x.${ext}`), 'mesh'));
for (const ext of ['step','stp','iges','igs','3mf']) test(`3D CAD ${ext}`, () => { assert.equal(policy.modelFamily(`x.${ext}`), 'cad'); assert.equal(policy.cadDimension(`x.${ext}`), '3d'); });
for (const ext of ['pmx','pmd','vmd','vpd']) test(`MMD ${ext}`, () => assert.equal(policy.modelFamily(`x.${ext}`), 'mmd'));

test('DXF is built-in 2D CAD while DWG remains gated', () => {
  assert.equal(policy.cadDimension('drawing.dxf'), '2d');
  assert.equal(policy.modelPreviewKind('drawing.dxf'), 'cad-2d');
  assert.equal(policy.missingModelSupport('drawing.dxf'), null);
  assert.match(policy.missingModelSupport('drawing.dwg'), /DWG/);
});

test('3MF is CAD but has a dedicated built-in browser preview', () => {
  assert.equal(policy.modelFamily('part.3mf'), 'cad');
  assert.equal(policy.cadDimension('part.3mf'), '3d');
  assert.equal(policy.modelPreviewKind('part.3mf'), 'cad-3d');
  assert.equal(policy.missingModelSupport('part.3mf'), null);
  assert.match(policy.missingModelSupport('part.step'), /OpenCascade/);
});

test('signed URLs are preserved and unsafe protocols rejected', () => {
  const signed = 'https://files.example/model.stl?token=secret';
  assert.equal(policy.safeModelSource(signed), signed);
  assert.equal(policy.safeModelSource('javascript:alert(1)'), null);
  assert.equal(policy.safeModelSource('https://user:pass@example.test/model.stl'), null);
});

test('workspace route stops inline preview before switching', () => {
  const calls = [];
  policy.routeModelAsset({ src: 'https://files.example/x.stl', fileName: 'x.stl' }, { kind: 'workspace' }, {
    isMobile: () => false,
    stopInline: () => calls.push('stop'),
    select: () => calls.push('select'),
    showWorkspace: () => calls.push('workspace'),
    showDock: () => calls.push('dock')
  });
  assert.deepEqual(calls, ['stop', 'select', 'workspace']);
});

test('dock is rejected on mobile before any mutation', () => {
  const calls = [];
  assert.throws(() => policy.routeModelAsset({ src: 'https://files.example/x.stl', fileName: 'x.stl' }, { kind: 'dock' }, {
    isMobile: () => true,
    stopInline: () => calls.push('stop'),
    select: () => calls.push('select'),
    showWorkspace: () => calls.push('workspace'),
    showDock: () => calls.push('dock')
  }), /unavailable/);
  assert.deepEqual(calls, []);
});
