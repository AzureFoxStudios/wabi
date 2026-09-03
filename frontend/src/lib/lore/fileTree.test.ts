import { expect, test } from 'bun:test';
import { buildLoreFileTree } from './fileTree';

test('builds nested hierarchy from flat paths', () => {
	const tree = buildLoreFileTree([
		{ path: 'README.md' },
		{ path: 'src/deep/nested/main.rs' },
		{ path: 'src/lib.ts' }
	]);
	expect(tree.map((n) => n.path)).toEqual(['src', 'README.md']);
	const src = tree[0];
	expect(src.isFolder).toBe(true);
	expect(src.children.map((n) => n.name)).toEqual(['deep', 'lib.ts']);
	expect(src.children[0].children[0].path).toBe('src/deep/nested'); // deep -> nested
	expect(src.children[0].children[0].children[0].path).toBe('src/deep/nested/main.rs');
});

test('folders group first at every level, then files alphabetically', () => {
	const tree = buildLoreFileTree([
		{ path: 'zeta.txt' },
		{ path: 'alpha/b.txt' },
		{ path: 'zed.txt' },
		{ path: 'alpha/a.txt' },
		{ path: 'mid/c.txt' }
	]);
	expect(tree.map((n) => n.name)).toEqual(['alpha', 'mid', 'zed.txt', 'zeta.txt']);
	expect(tree[0].children.map((n) => n.name)).toEqual(['a.txt', 'b.txt']);
});

test('numeric-aware sibling ordering (texture2 before texture10)', () => {
	const tree = buildLoreFileTree([{ path: 'tex/texture10.png' }, { path: 'tex/texture2.png' }]);
	expect(tree[0].children.map((n) => n.name)).toEqual(['texture2.png', 'texture10.png']);
});

test('folder names dedupe across many files in the same folder', () => {
	const tree = buildLoreFileTree([
		{ path: 'assets/x.png' },
		{ path: 'assets/y.png' },
		{ path: 'assets/sub/z.png' }
	]);
	const foldersAtRoot = tree.filter((n) => n.isFolder);
	expect(foldersAtRoot).toHaveLength(1);
	expect(foldersAtRoot[0].children.filter((n) => n.isFolder)).toHaveLength(1);
	expect(tree[0].children).toHaveLength(3); // sub, x.png, y.png
});

test('empty input yields empty tree', () => {
	expect(buildLoreFileTree([])).toEqual([]);
});
