/**
 * Lore file-tree construction (pure, testable).
 *
 * The lore API returns a FLAT list of file paths; folders exist only
 * implicitly inside path strings. This module derives the hierarchy:
 * each path segment becomes a node; intermediate segments are folders.
 *
 * Ordering convention (VSCode/GitHub-familiar): at every level, folders
 * group first, then files — each alphabetical (numeric-aware, so
 * texture2.png sorts before texture10.png).
 */

export interface FileTreeNode {
	name: string;
	path: string;
	isFolder: boolean;
	children: FileTreeNode[];
	file?: { path: string; size: number; [k: string]: unknown };
}

function compareNodes(a: FileTreeNode, b: FileTreeNode): number {
	if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
	return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

function sortLevel(nodes: FileTreeNode[]): void {
	nodes.sort(compareNodes);
	for (const n of nodes) sortLevel(n.children);
}

export function buildLoreFileTree(
	files: readonly { path: string; size?: number }[]
): FileTreeNode[] {
	const root: FileTreeNode[] = [];
	const pathMap: Record<string, FileTreeNode> = {};

	const sorted = [...files].sort((a, b) =>
		a.path.localeCompare(b.path, undefined, { numeric: true })
	);

	for (const file of sorted) {
		const parts = file.path.split('/');
		let currentPath = '';
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			currentPath = currentPath ? `${currentPath}/${part}` : part;

			if (i < parts.length - 1) {
				// Intermediate segment: a folder (created at most once —
				// parents always exist by this point because a file's own
				// walk creates them left-to-right).
				if (!pathMap[currentPath]) {
					const folder: FileTreeNode = {
						name: part,
						path: currentPath,
						isFolder: true,
						children: []
					};
					pathMap[currentPath] = folder;
					// NOTE: for root-level nodes lastIndexOf('/') is -1 and
					// slice(0, -1) silently drops a character ("src" ->
					// "sr"), orphaning the subtree. Derive '' explicitly.
					const parentPath = currentPath.includes('/')
						? currentPath.slice(0, currentPath.lastIndexOf('/'))
						: '';
					if (parentPath && pathMap[parentPath]) {
						pathMap[parentPath].children.push(folder);
					} else if (!parentPath) {
						root.push(folder);
					}
				}
			} else {
				const node: FileTreeNode = {
					name: part,
					path: file.path,
					isFolder: false,
					children: [],
					file: file as FileTreeNode['file']
				};
				const parentPath = currentPath.includes('/')
					? currentPath.slice(0, currentPath.lastIndexOf('/'))
					: '';
				if (parentPath && pathMap[parentPath]) {
					pathMap[parentPath].children.push(node);
				} else {
					root.push(node);
				}
			}
		}
	}

	sortLevel(root);
	return root;
}
