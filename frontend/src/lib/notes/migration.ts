export interface LegacyNoteRow {
	title: string;
	text: string;
	createdAt?: number;
	updatedAt?: number;
	pinned?: boolean;
	color?: string;
}
export interface LegacyNotePreview {
	key: string;
	raw: string;
	kind: 'notebook' | 'conversation' | 'scratchpad' | 'profile';
	rows: LegacyNoteRow[];
	issues: string[];
}

function titleFromText(text: string): string {
	return (text.split(/\r?\n/).find(line => line.trim()) || 'Recovered note')
		.replace(/^#+\s*/, '').replace(/[\[\]|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || 'Recovered note';
}

/** Never infer owner or conversation identity from a legacy key. */
export function previewLegacyNotes(key: string, raw: string): LegacyNotePreview {
	const kind = key.startsWith('wabi:keep-notes:v1:') ? 'notebook'
		: key.startsWith('wabi:dm-notes:v1:') ? 'conversation'
			: key.startsWith('wabi:quick-scratchpad:v1:') ? 'scratchpad'
				: key === 'wabi.userNotes.byUserId' ? 'profile' : null;
	if (!kind) throw new Error('This is not a recognized legacy Notes source.');
	const preview: LegacyNotePreview = { key, raw, kind, rows: [], issues: [] };
	if (raw.length > 10_000_000) { preview.issues.push('This source is larger than 10 million characters. Download it before recovering it separately.'); return preview; }
	let value: unknown;
	try { value = JSON.parse(raw); } catch { preview.issues.push('The original value is not valid JSON. Its exact bytes must be kept for recovery.'); return preview; }
	if (kind === 'profile') {
		preview.issues.push('Profile annotations need an explicit owner and person mapping. Keep this source separate from notebook imports.');
		return preview;
	}
	if (kind === 'scratchpad') {
		if (typeof value !== 'string' || value.length > 2_000_000) preview.issues.push('The scratchpad value must be text no larger than two million characters.');
		else if (value.length) preview.rows.push({ title: 'Recovered scratchpad', text: value });
		return preview;
	}
	if (!Array.isArray(value)) { preview.issues.push('Expected a list of notes. The original value has been kept intact.'); return preview; }
	value.forEach((row, index) => {
		if (!row || typeof row !== 'object' || typeof row.text !== 'string' || row.text.length > 2_000_000) {
			preview.issues.push(`Note ${index + 1} is malformed and needs recovery from the original source.`);
			return;
		}
		const validTime = (time: unknown): time is number => typeof time === 'number' && Number.isFinite(time) && time >= 0;
		preview.rows.push({ title: titleFromText(row.text), text: row.text,
			...(validTime(row.createdAt) ? { createdAt: row.createdAt } : {}),
			...(validTime(row.updatedAt) ? { updatedAt: row.updatedAt } : {}),
			...(typeof row.pinned === 'boolean' ? { pinned: row.pinned } : {}),
			...(typeof row.color === 'string' && row.color.length <= 200 ? { color: row.color } : {}) });
	});
	return preview;
}

export function discoverLegacyNotes(storage: Storage): LegacyNotePreview[] {
	const results: LegacyNotePreview[] = [];
	for (let i = 0; i < storage.length; i++) {
		const key = storage.key(i);
		if (!key || !/^(?:wabi:(?:keep-notes|dm-notes|quick-scratchpad):v1:|wabi\.userNotes\.byUserId$)/.test(key)) continue;
		const raw = storage.getItem(key);
		if (raw !== null) results.push(previewLegacyNotes(key, raw));
	}
	return results;
}

export async function legacyNotesFingerprint(key: string, raw: string): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify({ schema: 1, key, raw }));
	return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}
