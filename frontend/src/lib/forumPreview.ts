/** Automatic file previews are deliberately small, text-only, and escaped by Svelte. */
export function canPreviewLoreText(path: string, bytes: number): boolean {
 return Number.isFinite(bytes) && bytes >= 0 && bytes <= 65536 && /\.(txt|md|rs|ts|tsx|js|jsx|json|toml|yaml|yml|py|css|html|svelte|sh|c|cpp|h|go|sql)$/i.test(path);
}
export function loreTextExcerpt(content: string): string {
 return content.split('\n').slice(0,12).join('\n').slice(0,1600);
}

/** Plain summary text excludes image destinations and Markdown formatting. */
export function wikiCardExcerpt(body: string): string {
 return body.replace(/!\[[^\]]*\]\([^)]*\)/g,'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/<[^>]*>/g,'').replace(/[#*`>]/g,'').replace(/\s+/g,' ').trim().slice(0,180);
}
