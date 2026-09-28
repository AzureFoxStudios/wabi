/** Preserve pasted/imported code as text, including code containing Markdown fences. */
export function journalCodeBlock(code: string, language = ''): string {
 const runs = code.match(/`+/g) || [];
 const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
 const safeLanguage = /^[a-zA-Z0-9_+-]{0,30}$/.test(language) ? language : '';
 return `${fence}${safeLanguage}\n${code}\n${fence}`;
}
