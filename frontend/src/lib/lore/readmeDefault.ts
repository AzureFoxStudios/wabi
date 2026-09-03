/**
 * README auto-open helper for Lore asset repos.
 *
 * Convention (GitHub-familiar, Wabi-simple): a root-level `README.md` is the
 * repo's front page. The file browser auto-SELECTS it when nothing else is
 * selected — it is never forced: the moment the user picks another file (or
 * closes the viewer), the README is just a file again. It is NOT a special
 * object: rendered like any other markdown document, edited like any other
 * file, no dedicated storage or permissions.
 */

const README_RE = /^readme\.(md|markdown)$/i;

/**
 * Find the repo-root README among a file listing, or null.
 * Root-level only (folder READMEs don't fit the current selection model).
 * `README.md` wins if multiple case variants exist.
 */
export function findReadmePath(files: readonly { path: string }[]): string | null {
	let fallback: string | null = null;
	for (const f of files) {
		const path = f.path;
		if (path.includes('/')) continue;
		if (!README_RE.test(path)) continue;
		if (path === 'README.md') return path;
		// Among case variants, prefer .md over .markdown (GitHub-like).
		if (fallback === null || (!fallback.toLowerCase().endsWith('.md') && path.toLowerCase().endsWith('.md'))) {
			fallback = path;
		}
	}
	return fallback;
}

/** Markdown files get the rendered view (with a source toggle). */
export function isMarkdownPath(path: string): boolean {
	return /\.(md|markdown)$/i.test(path);
}
