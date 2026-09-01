/**
 * Clipboard → board paste planning. Pure logic (no DOM) so it stays unit-testable:
 * decides whether pasted text is code, guesses the language, enforces size caps,
 * and names the per-paste layer. The element builders live in textMetrics.ts.
 */

/** Cap per pasted code block: doc cap is 2MB, live patch cap is 128KB. */
export const MAX_CODE_PASTE_CHARS = 64 * 1024;
export const MAX_TEXT_PASTE_CHARS = 64 * 1024;

export type PasteKind = 'code' | 'text';

export type PastePlan =
	| { kind: 'code'; language: string }
	| { kind: 'text' };

interface LanguageProfile {
	name: string;
	keywords: RegExp[];
}

const LANGUAGE_PROFILES: LanguageProfile[] = [
	{
		name: 'rust',
		keywords: [/\bfn\b/, /\blet\b\s+(mut\s+)?/, /\bimpl\b/, /\bpub\b/, /\bmatch\b\s+\w+\s*\{/, /\buse\b\s+\w+::/, /::</, /\bResult</, /\bOption</, /\benum\b\s+\w+/]
	},
	{
		name: 'typescript',
		keywords: [/\binterface\b\s+\w+/, /\btype\b\s+\w+\s*=/, /:\s*(string|number|boolean|void)\b/, /\bconst\b\s+\w+\s*(:|=)/, /\bimport\b\s+\{[^}]*\}\s+from\b/, /\bexport\b/, /=>\s*\{?/, /\bas\s+\w+/]
	},
	{
		name: 'javascript',
		keywords: [/\bfunction\b\s*\w*\s*\(/, /\bconst\b\s+\w+\s*=/, /\blet\b\s+\w+\s*=/, /\bvar\b\s+\w+\s*=/, /\brequire\(/, /=>\s*\{?/, /\basync\b\s+function\b/, /console\.log\(/, /\bexport\s+default\b/]
	},
	{
		name: 'python',
		keywords: [/\bdef\b\s+\w+\s*\(/, /\bimport\b\s+\w+/, /\bfrom\b\s+\w+\s+import\b/, /\bself\./, /\bprint\(/, /:\s*$/m, /\bif\s+__name__\s*==/, /\belif\b/, /\bNone\b/, /\bTrue\b|\bFalse\b(?![:;])/]
	},
	{
		name: 'go',
		keywords: [/\bfunc\b\s+(\(\w+\s+\*?\w+\)\s+)?\w+\s*\(/, /\bpackage\b\s+\w+/, /:=/, /\bfmt\./, /\bimport\b\s+\(/, /\bnil\b/, /\bstruct\s*\{/, /\berror\b/]
	},
	{
		name: 'java',
		keywords: [/\bpublic\s+(static\s+)?(void|class|final)\b/, /\bSystem\.out\.print/, /\bprivate\b\s+\w+\s+\w+\s*;/, /\bnew\s+\w+\(/, /\bpackage\b\s+[\w.]+;/]
	},
	{
		name: 'csharp',
		keywords: [/\busing\s+System/, /\bnamespace\b\s+[\w.]+/, /\bpublic\s+(partial\s+)?class\b/, /Console\.Write/, /\bstring\b\s+\w+\s*[=;]/]
	},
	{
		name: 'cpp',
		keywords: [/#include\s*[<"]/, /\bstd::/, /\bcout\s*<</, /\bint\s+main\s*\(/, /\btemplate\s*</]
	},
	{
		name: 'c',
		keywords: [/#include\s*[<"]/, /\bprintf\s*\(/, /\bint\s+main\s*\(/, /\bstruct\s+\w+\s*\{/, /\bmalloc\(/]
	},
	{
		name: 'ruby',
		keywords: [/\bdef\b\s+\w+/, /\bend\b/m, /\bputs\b/, /\brequire\b\s+['"]/, /@\w+/, /\bdo\s*\|/, /:\w+\s*=>/]
	},
	{
		name: 'bash',
		keywords: [/^#!.*\b(bash|sh|zsh)\b/, /\becho\s+/, /\bfi\b/, /\bdone\b/, /\bthen\b/, /\$\{?\w+\}?/, /\bif\s*\[\s*$/, /\bapt\b|\bdnf\b|\bbrew\b/]
	},
	{
		name: 'json',
		keywords: [/^\s*\{[\s\S]*\}\s*$/m, /"[\w.-]+"\s*:/]
	},
	{
		name: 'css',
		keywords: [/[.#@][\w-]+\s*\{[^}]*:[^}]*\}/, /\bcolor\s*:/, /\bmargin\s*:/, /\bfont-family\s*:/]
	},
	{
		name: 'markup',
		keywords: [/<\/?[\w-]+(\s+[\w-]+(="[^"]*")?)*\s*\/?>/, /<!DOCTYPE/i]
	}
];

export function detectLanguage(text: string): string {
	let best = '';
	let bestScore = 0;
	for (const profile of LANGUAGE_PROFILES) {
		let score = 0;
		for (const pattern of profile.keywords) {
			if (pattern.test(text)) score += 1;
		}
		if (score > bestScore) {
			bestScore = score;
			best = profile.name;
		}
	}
	return bestScore >= 2 ? best : '';
}

export function looksLikeCode(text: string): { isCode: boolean; language: string } {
	const trimmed = (text || '').trim();
	if (!trimmed) return { isCode: false, language: '' };

	const lines = trimmed.split('\n');
	const lineCount = lines.length;

	// Structural signals
	let braceLines = 0;
	let semicolonLines = 0;
	let indentedLines = 0;
	let commentLines = 0;
	for (const line of lines) {
		if (/[{}]/.test(line)) braceLines += 1;
		if (/;\s*$/.test(line)) semicolonLines += 1;
		if (/^\s{2,}\S/.test(line)) indentedLines += 1;
		if (/^\s*(\/\/|#|\*|\/\*)/.test(line)) commentLines += 1;
	}

	const language = detectLanguage(trimmed);
	let score = 0;
	if (braceLines >= Math.max(2, lineCount * 0.2)) score += 2;
	if (semicolonLines >= Math.max(2, lineCount * 0.25)) score += 1;
	if (indentedLines >= Math.max(2, lineCount * 0.3)) score += 1;
	if (commentLines >= 1) score += 1;
	if (language) score += 2;
	if (/^\s*[{[]/.test(trimmed) && /[\]}]\s*$/.test(trimmed)) score += 2; // raw JSON/array literal
	if (/=>|::|:=|<-\s|->\s/.test(trimmed)) score += 1;
	if (lines.filter((line) => /\b\w+\s*=\s*\S/.test(line)).length >= 2) score += 1; // assignments
	if (/^\s*(let|const|var|fn|def|func|class|import|export|return|pub|package|use|struct|enum|type)\b/m.test(trimmed)) score += 1;

	// Prose counter-signals: long lines of words with sentence punctuation.
	const wordyLines = lines.filter((line) => {
		const words = line.trim().split(/\s+/).filter(Boolean);
		return words.length >= 8 && /^[A-Za-z]/.test(line.trim()) && !/[{};<>=]/.test(line);
	}).length;
	if (wordyLines >= Math.max(2, lineCount * 0.6)) score -= 3;

	return { isCode: score >= 3, language };
}

export function planPaste(text: string): { plan: PastePlan | null; error?: string } {
	const trimmed = (text || '').replace(/\r\n/g, '\n');
	if (!trimmed.trim()) return { plan: null };
	if (trimmed.length > MAX_CODE_PASTE_CHARS) {
		return { plan: null, error: `Pasted text is too large (${Math.ceil(trimmed.length / 1024)} KB); the limit is ${MAX_CODE_PASTE_CHARS / 1024} KB.` };
	}
	const { isCode, language } = looksLikeCode(trimmed);
	return { plan: isCode ? { kind: 'code', language: language || 'markup' } : { kind: 'text' } };
}

export function suggestPasteLayerName(plan: PastePlan, fallbackIndex: number): string {
	if (plan.kind === 'code') {
		const label = plan.language && plan.language !== 'markup' ? plan.language : 'code';
		return `Code — ${label}`;
	}
	return `Text ${fallbackIndex}`;
}

export function stripDangerousClipboardText(text: string): string {
	// Remove control chars except \n and \t (zero-width/bidi tricks have no
	// business on the board and corrupt measurement).
	return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\uFEFF]/g, '');
}
