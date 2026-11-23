/**
 * Escapes the pipes in Markdown that is going into a table cell.
 *
 * The text is already Markdown, so a backslash and the character after it are
 * one unit: an escaped pipe stays as it is, and a pipe after an escaped
 * backslash is still escaped.
 */
export function escapeCellPipes(markdown: string): string {
	return markdown.replace(/\\[\s\S]|\|/g, (unit) => (unit === '|' ? '\\|' : unit));
}
