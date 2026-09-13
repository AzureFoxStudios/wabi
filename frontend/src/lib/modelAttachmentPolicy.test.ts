import { describe, expect, test } from 'bun:test';
import {
	cadDimension,
	cadImportPlan,
	missingModelSupport,
	modelFamily,
	modelPreviewKind,
	routeModelAsset,
	safeModelSource
} from './modelAttachmentPolicy';

describe('model and CAD format routing', () => {
	test('recognizes mesh, CAD and MMD families', () => {
		for (const ext of ['glb', 'gltf', 'obj', 'stl']) expect(modelFamily(`x.${ext}`)).toBe('mesh');
		for (const ext of ['dxf', 'dwg', 'step', 'stp', 'iges', 'igs', '3mf']) expect(modelFamily(`x.${ext}`)).toBe('cad');
		for (const ext of ['pmx', 'pmd', 'vmd', 'vpd']) expect(modelFamily(`x.${ext}`)).toBe('mmd');
	});

	test('DXF and DWG converge on the 2D review workspace through distinct importers', () => {
		expect(cadDimension('drawing.dxf')).toBe('2d');
		expect(modelPreviewKind('drawing.dxf')).toBe('cad-2d');
		expect(cadImportPlan('drawing.dxf')).toMatchObject({ preferred: 'builtin-dxf', canonicalPreview: 'dxf', availableNow: true });
		expect(missingModelSupport('drawing.dxf')).toBeNull();

		expect(cadDimension('drawing.dwg')).toBe('2d');
		expect(modelPreviewKind('drawing.dwg')).toBe('cad-2d');
		expect(cadImportPlan('drawing.dwg')).toMatchObject({ preferred: 'server-convert', canonicalPreview: 'dxf', availableNow: true });
		expect(missingModelSupport('drawing.dwg')).toBeNull();
	});

	test('3MF, STEP and IGES converge on Wabi 3D previews', () => {
		expect(modelPreviewKind('part.3mf')).toBe('cad-3d');
		expect(cadImportPlan('part.3mf')).toMatchObject({ preferred: 'browser-3mf', canonicalPreview: 'glb', availableNow: true });
		for (const ext of ['step', 'stp', 'iges', 'igs']) {
			const name = `part.${ext}`;
			expect(cadDimension(name)).toBe('3d');
			expect(modelPreviewKind(name)).toBe('cad-3d');
			expect(cadImportPlan(name)).toMatchObject({ preferred: 'occt-wasm', canonicalPreview: 'glb', availableNow: true });
			expect(missingModelSupport(name)).toBeNull();
		}
	});
});

describe('model attachment safety and navigation', () => {
	test('preserves signed sources while rejecting credentialed or unsafe URLs', () => {
		const signed = 'https://files.example/model.stl?token=secret';
		expect(safeModelSource(signed)).toBe(signed);
		expect(safeModelSource('javascript:alert(1)')).toBeNull();
		expect(safeModelSource('https://user:pass@example.test/model.stl')).toBeNull();
	});

	test('workspace navigation retires inline preview before selecting the workspace', () => {
		const calls: string[] = [];
		routeModelAsset({ src: 'https://files.example/x.stl', fileName: 'x.stl' }, { kind: 'workspace' }, {
			isMobile: () => false,
			stopInline: () => calls.push('stop'),
			select: () => calls.push('select'),
			showWorkspace: () => calls.push('workspace'),
			showDock: () => calls.push('dock')
		});
		expect(calls).toEqual(['stop', 'select', 'workspace']);
	});

	test('mobile dock rejection happens before any mutation', () => {
		const calls: string[] = [];
		expect(() => routeModelAsset({ src: 'https://files.example/x.stl', fileName: 'x.stl' }, { kind: 'dock' }, {
			isMobile: () => true,
			stopInline: () => calls.push('stop'),
			select: () => calls.push('select'),
			showWorkspace: () => calls.push('workspace'),
			showDock: () => calls.push('dock')
		})).toThrow(/unavailable/);
		expect(calls).toEqual([]);
	});
});
