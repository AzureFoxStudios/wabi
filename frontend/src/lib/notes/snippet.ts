import { stripHtmlTags } from '../stripHtmlTags';

/** Plain text snippets keep Markdown syntax out of the note list. */
export function noteSnippet(source: string): string {
 const text = source.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '')
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, title, label) => label || title);
 return stripHtmlTags(text).replace(/^\s{0,3}(?:#{1,6} |>|[-*+] |\d+\. )/gm, '')
  .replace(/[`*_~]/g, '').replace(/\s+/g, ' ').trim().slice(0, 90);
}
