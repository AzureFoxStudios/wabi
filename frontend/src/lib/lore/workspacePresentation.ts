/** Presentation-only helpers. No staging, filesystem writes, or permission mutations. */
export const PROJECT_TABS = ['files', 'changes', 'history', 'review', 'settings'] as const;
export type ProjectTab = typeof PROJECT_TABS[number];

export interface RevisionLike { hash: string; message: string; timestamp: number; authorId: number }

/** Accept the timestamp units used by older Lore exports. Invalid dates sort last. */
export function revisionTime(value: number): number | null {
	if (!Number.isFinite(value) || value <= 0) return null;
	const millis = value < 100_000_000_000 ? value * 1000 : value < 100_000_000_000_000 ? value : value / 1000;
	return Number.isFinite(new Date(millis).getTime()) ? millis : null;
}

export function newestFirst<T extends RevisionLike>(revisions: readonly T[]): T[] {
	return revisions.map((revision, index) => ({ revision, index })).sort((a, b) =>
		(revisionTime(b.revision.timestamp) ?? -1) - (revisionTime(a.revision.timestamp) ?? -1) || a.index - b.index
	).map(({ revision }) => revision);
}

export function revisionSummary(message: string): { title: string; detail: string } {
	const [title, ...detail] = message.trim().split(/\r?\n/);
	return { title: title?.trim() || 'Revision without a summary', detail: detail.join('\n').trim() };
}

export function formatRevisionTime(value: number): string {
	const millis = revisionTime(value);
	return millis === null ? 'Date unavailable' : new Date(millis).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return 'Size unavailable';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
	if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
	return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

export function isMirror(repo: { class?: unknown } | null): boolean {
	const kind = repo?.class;
	return kind === 'mirror' || (!!kind && typeof kind === 'object' && 'mirror' in kind);
}

export type PreviewKind = 'image' | 'audio' | 'video' | 'text' | 'download';
const images = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico']);
const audio = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']);
const video = new Set(['mp4', 'webm', 'ogv', 'mov']);
const text = new Set(['md', 'markdown', 'txt', 'rs', 'ts', 'tsx', 'js', 'jsx', 'json', 'css', 'html', 'svelte', 'vue', 'py', 'c', 'h', 'cpp', 'hpp', 'go', 'java', 'toml', 'yaml', 'yml', 'xml', 'svg', 'sh', 'bash', 'sql', 'csv', 'ini', 'cfg', 'glsl', 'gd', 'gitignore', 'dockerignore', 'gitattributes', 'mjs', 'cjs', 'cc', 'rb', 'php', 'swift', 'kt', 'scss', 'bat', 'ps1']);
export function previewKind(path: string): PreviewKind {
	const name = path.split('/').pop()?.toLowerCase() ?? '';
	const ext = name.includes('.') ? name.split('.').pop()! : '';
	if (images.has(ext)) return 'image';
	if (audio.has(ext)) return 'audio';
	if (video.has(ext)) return 'video';
	// Render SVG as source, not an executable document. Unknown binaries are never fetched as text.
	if (text.has(ext) || ['readme', 'license', 'copying', 'dockerfile', 'makefile'].includes(name)) return 'text';
	return 'download';
}

/** Upload paths are relative, never OS paths. Directory uploads strip only the chosen root. */
export function uploadPath(name: string, relativePath = '', destination = 'uploads'): string {
	if (relativePath && (relativePath.startsWith('/') || !relativePath.includes('/'))) throw new Error('Invalid directory upload path.');
	const relative = relativePath ? relativePath.split('/').slice(1).join('/') : name;
	if (!relative) throw new Error('Select a file inside the directory.');
	const path = [destination.replace(/\/+$/, ''), relative].filter(Boolean).join('/');
	if (!path || /[\\:\u0000-\u001f\u007f]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) {
		throw new Error('Unsupported upload path. Choose a normal project file.');
	}
	return path;
}

export function sameRoleDraft(a: { name: string; description: string; capabilities: string[] }, b: { name: string; description: string; capabilities: string[] }): boolean {
	return a.name === b.name && a.description === b.description &&
		JSON.stringify([...new Set(a.capabilities)].sort()) === JSON.stringify([...new Set(b.capabilities)].sort());
}

/** Late requests cannot repaint another selection. A disposed component never accepts results. */
export class SelectionEpoch {
	private version = 0;
	private disposed = false;
	begin(): number { return ++this.version; }
	current(version: number): boolean { return !this.disposed && version === this.version; }
	dispose(): void { this.disposed = true; this.version++; }
}
