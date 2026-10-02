/** One device-local sketch sheet travels with the note, its drafts and backups. */
export interface InkStroke { color: string; width: number; points: [number, number][] }
export interface NoteInk { version: 1; paper: 'white' | 'gray' | 'dark'; guide: 'none' | 'lines' | 'dots'; strokes: InkStroke[] }
export const emptyInk = (): NoteInk => ({version:1,paper:'white',guide:'lines',strokes:[]});
const sheet = /!\[Handwritten note\]\(data:image\/png;base64,[A-Za-z0-9+/=]+\)\s*<!--wabi-note-ink:v1:([A-Za-z0-9+/=]+)-->/g;
export function checkedInk(value: unknown): NoteInk {
 const ink = value as NoteInk;
 if (!ink || ink.version !== 1 || !['white','gray','dark'].includes(ink.paper) || !['none','lines','dots'].includes(ink.guide) || !Array.isArray(ink.strokes) || ink.strokes.length > 1000) throw new Error('Invalid sketch sheet.');
 let points = 0;
 for (const stroke of ink.strokes) {
  if (!stroke || !/^#[a-f0-9]{6}$/i.test(stroke.color) || !Number.isFinite(stroke.width) || stroke.width < 1 || stroke.width > 20 || !Array.isArray(stroke.points) || !stroke.points.length) throw new Error('Invalid ink stroke.');
  points += stroke.points.length;
  if (points > 60000 || stroke.points.some(point => !Array.isArray(point) || point.length !== 2 || point.some(coordinate => !Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1000))) throw new Error('This sketch exceeds the supported sheet size.');
 }
 return ink;
}
export function readNoteInk(text: string): NoteInk | null {
 const match = [...text.matchAll(sheet)].at(-1);
 if (!match) return null;
 try { return checkedInk(JSON.parse(atob(match[1]))); } catch { return null; }
}
export function saveNoteInk(text: string, ink: NoteInk, png: string): string {
 checkedInk(ink);
 if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(png)) throw new Error('Could not create the drawing preview.');
 const block = `![Handwritten note](${png})\n<!--wabi-note-ink:v1:${btoa(JSON.stringify(ink))}-->`;
 const matches = [...text.matchAll(sheet)], last = matches.at(-1);
 const result = last ? text.slice(0,last.index) + block + text.slice(last.index! + last[0].length) : `${text.trimEnd()}\n\n${block}`.trimStart();
 if (result.length > 2_000_000) throw new Error('This note is too large to add the drawing. Simplify the sketch or save it in a new note.');
 return result;
}
export function inkPreview(href: string): boolean { return href.length <= 2_000_000 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(href); }

/** Hit-test complete segments, including sparse mouse/stylus samples. */
export function strokeTouches(stroke: InkStroke, at: [number, number], radius = 18): boolean {
 for (let i = 0; i < stroke.points.length; i++) {
  const a = stroke.points[i], b = stroke.points[i + 1] || a;
  const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((at[0] - a[0]) * dx + (at[1] - a[1]) * dy) / length)) : 0;
  if (Math.hypot(at[0] - a[0] - t * dx, at[1] - a[1] - t * dy) <= radius + stroke.width / 2) return true;
 }
 return false;
}

/** The editor shows prose; portable image/ink blocks stay out of the typing surface. */
export function noteWritingText(text: string): string { return text.replace(sheet, '').trimEnd(); }
export function replaceNoteWriting(text: string, writing: string): string {
 const blocks = [...text.matchAll(sheet)].map(match => match[0]);
 return blocks.length ? `${writing.trimEnd()}\n\n${blocks.join('\n\n')}`.trimStart() : writing;
}
