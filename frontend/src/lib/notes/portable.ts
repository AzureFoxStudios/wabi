import { serializeNotebookBackup, type NotebookBackup } from './backup';
import { parseNoteLinks } from './links';

const utf8 = new TextEncoder();
const escapeLabel = (value: string) => value.replace(/([\\`*_[\]<>])/g, '\\$1');
/** Predictable, ASCII-safe paths; UUID suffixes keep equal slugs distinct. */
export function portableNotePath(title: string, id: string, trashed: boolean): string {
	const slug = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'note';
	return `${trashed ? 'trash' : 'notes'}/${slug}-${id}.md`;
}
export function portableNotebookFiles(backup: NotebookBackup): Map<string, string> {
	const json = serializeNotebookBackup(backup); // Validate identities, graph and supported size first.
	const paths = new Map(backup.notes.map(note => [note.id, portableNotePath(note.title, note.id, note.trashedAt !== null)]));
	const graph = new Map(backup.links.map(link => [`${link.sourceId}:${link.normalizedTitle}`, link.targetId]));
	const files = new Map<string, string>([
		['README.txt', 'Wabi local notebook export\n\nnotes/ contains active notes; trash/ contains deleted notes kept for recovery.\nMarkdown links point to exported files. Unresolved links stay as [[Title]].\nExtract the archive before opening files. notebook.json preserves Wabi metadata and can be imported in Notes.\nThis export contains saved notes only; unsaved drafts and profile annotations are separate.\n'],
		['notebook.json', json]
	]);
	for (const note of backup.notes) {
		let text = note.text;
		for (const link of parseNoteLinks(note.text).reverse()) {
			const target = graph.get(`${note.id}:${link.normalizedTitle}`);
			const destination = target ? paths.get(target) : undefined;
			if (!destination) continue;
			text = text.slice(0, link.from) + `[${escapeLabel(link.label ?? link.title)}](../${destination})` + text.slice(link.to);
		}
		files.set(paths.get(note.id)!, text);
	}
	return files;
}
/** Small POSIX ustar writer. Only validated short ASCII file paths are accepted. */
export function packNotebookFiles(files: ReadonlyMap<string, string>): Uint8Array<ArrayBuffer> {
	const entries = [...files].map(([name, content]) => {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,98}$/.test(name) || name.split('/').includes('..')) throw new Error('Unsupported notebook export path.');
		return { name, bytes: utf8.encode(content) };
	});
	const size = entries.reduce((total, entry) => total + 512 + Math.ceil(entry.bytes.length / 512) * 512, 1024);
	const archive = new Uint8Array(size);
	let offset = 0;
	for (const { name, bytes } of entries) {
		const header = archive.subarray(offset, offset + 512);
		const write = (start: number, text: string) => header.set(utf8.encode(text), start);
		const octal = (value: number, width: number) => value.toString(8).padStart(width - 1, '0') + '\0';
		write(0, name); write(100, octal(0o600, 8)); write(108, octal(0, 8)); write(116, octal(0, 8));
		write(124, octal(bytes.length, 12)); write(136, octal(0, 12));
		header.fill(32, 148, 156); write(156, '0'); write(257, 'ustar\0'); write(263, '00');
		write(148, header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ');
		archive.set(bytes, offset + 512);
		offset += 512 + Math.ceil(bytes.length / 512) * 512;
	}
	return archive;
}
export function exportPortableNotebook(backup: NotebookBackup): Uint8Array<ArrayBuffer> {
	return packNotebookFiles(portableNotebookFiles(backup));
}
