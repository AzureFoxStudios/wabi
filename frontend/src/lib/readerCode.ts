const LANGUAGE_ALIASES: Record<string, string> = {
	js: 'javascript',
	jsx: 'javascript',
	mjs: 'javascript',
	cjs: 'javascript',
	ts: 'typescript',
	tsx: 'typescript',
	py: 'python',
	rb: 'ruby',
	sh: 'bash',
	shell: 'bash',
	zsh: 'bash',
	yml: 'yaml',
	md: 'markdown',
	'c++': 'cpp',
	cc: 'cpp',
	cxx: 'cpp',
	'c#': 'csharp',
	cs: 'csharp',
	golang: 'go',
	rs: 'rust',
	html: 'markup',
	xml: 'markup',
	svg: 'markup',
	text: 'plain',
	plaintext: 'plain',
	txt: 'plain'
};

const LANGUAGE_LABELS: Record<string, string> = {
	javascript: 'JavaScript',
	typescript: 'TypeScript',
	python: 'Python',
	java: 'Java',
	c: 'C',
	cpp: 'C++',
	csharp: 'C#',
	go: 'Go',
	rust: 'Rust',
	ruby: 'Ruby',
	bash: 'Shell',
	json: 'JSON',
	css: 'CSS',
	markup: 'Markup',
	markdown: 'Markdown',
	yaml: 'YAML',
	toml: 'TOML',
	sql: 'SQL',
	svelte: 'Svelte',
	vue: 'Vue',
	kotlin: 'Kotlin',
	swift: 'Swift',
	lua: 'Lua',
	php: 'PHP',
	dart: 'Dart',
	r: 'R',
	plain: 'Plain text'
};

const CODE_EXTENSIONS = new Set([
	'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'java', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp',
	'cs', 'go', 'rs', 'rb', 'sh', 'bash', 'zsh', 'json', 'css', 'scss', 'sass', 'less', 'xml', 'svg',
	'sql', 'yaml', 'yml', 'toml', 'ini', 'conf', 'env', 'svelte', 'vue', 'kt', 'kts', 'swift', 'lua', 'php',
	'dart', 'r', 'gradle', 'gitignore'
]);

const FILE_LANGUAGE_OVERRIDES: Record<string, string> = {
	dockerfile: 'docker',
	makefile: 'makefile',
	'cargo.toml': 'toml',
	'package.json': 'json',
	'tsconfig.json': 'json',
	'.gitignore': 'plain',
	'.env': 'plain'
};

export function normalizeReaderCodeLanguage(value: string | null | undefined): string {
	const cleaned = (value || '').trim().toLowerCase().replace(/^language-/, '');
	if (!cleaned) return 'plain';
	return LANGUAGE_ALIASES[cleaned] || cleaned.replace(/[^a-z0-9_+#.-]/g, '') || 'plain';
}

export function readerCodeLanguageLabel(language: string): string {
	const normalized = normalizeReaderCodeLanguage(language);
	return LANGUAGE_LABELS[normalized] || normalized.toUpperCase();
}

export function inferReaderCodeLanguage(fileName: string): string {
	const base = fileName.trim().split(/[\\/]/).pop()?.toLowerCase() || '';
	if (FILE_LANGUAGE_OVERRIDES[base]) return FILE_LANGUAGE_OVERRIDES[base];
	const dot = base.lastIndexOf('.');
	if (dot < 0 || dot === base.length - 1) return 'plain';
	const extension = base.slice(dot + 1);
	if (extension === 'h') return 'c';
	if (extension === 'hpp') return 'cpp';
	if (extension === 'kt' || extension === 'kts') return 'kotlin';
	return normalizeReaderCodeLanguage(extension);
}

export function isReaderCodeFile(fileName: string): boolean {
	const base = fileName.trim().split(/[\\/]/).pop()?.toLowerCase() || '';
	if (FILE_LANGUAGE_OVERRIDES[base]) return true;
	const dot = base.lastIndexOf('.');
	if (dot < 0 || dot === base.length - 1) return false;
	return CODE_EXTENSIONS.has(base.slice(dot + 1));
}

/** Languages declared by Markdown fenced code blocks, in rendered block order. */
export function extractReaderFenceLanguages(source: string): string[] {
	const languages: string[] = [];
	const expression = /^ {0,3}(`{3,}|~{3,})[\t ]*([^\s`~{]+)?[^\n]*$/gm;
	for (const match of source.matchAll(expression)) {
		languages.push(normalizeReaderCodeLanguage(match[2]));
	}
	return languages;
}

export function countReaderCodeLines(value: string): number {
	if (!value) return 0;
	return value.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').length;
}

export function readerCodePreview(value: string, maxLength = 88): string {
	const first = value.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).find(Boolean) || 'Empty code block';
	return first.length > maxLength ? `${first.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…` : first;
}
