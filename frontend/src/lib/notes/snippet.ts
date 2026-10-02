/** Plain text snippets keep Markdown syntax out of the note list. */
export function noteSnippet(source: string): string {
 return source.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '')
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, title, label) => label || title)
  .replace(/<[^>]*>/g, '').replace(/^\s{0,3}(?:#{1,6} |>|[-*+] |\d+\. )/gm, '')
  .replace(/[`*_~]/g, '').replace(/\s+/g, ' ').trim().slice(0, 90);
}
