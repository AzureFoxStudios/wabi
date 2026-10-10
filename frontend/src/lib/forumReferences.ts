import type { MessageEntity } from './socket-types';
import type { NavRef } from './pendingNav';
import type { ObjectRefRecord } from './objectRefRegistry';

/** Resolve copied object tokens only when unambiguous; never interpret code as navigation. */
export function forumReferenceEntities(text: string, resolve: (token: string) => ObjectRefRecord | null): MessageEntity[] {
 const masked = text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|(`+)[\s\S]*?\1|!?\[[^\]\n]*\]\([^\)\n]*\)/g, code => ' '.repeat(code.length));
 const entities: MessageEntity[] = [];
 for (const match of masked.matchAll(/(?<![\\\w])\^([fwgm]\/[-a-zA-Z0-9_]+)/g)) {
  const record = resolve(match[1]);
  if (!record) continue;
  entities.push({ kind: record.kind, start: match.index!, end: match.index! + match[0].length, targetId: record.id, label: record.title, displayText: record.title });
 }
 return entities;
}
/** `lines=40-72` (or `lines=40`) names the part of a file a post wants people to look at. Capped so a link can't pull a whole file in. */
export const MAX_LINKED_LINES = 200;
export function loreLineRange(raw: string | null | undefined): { lines?: { start: number; end: number } } {
 const match = /^(\d{1,7})(?:-(\d{1,7}))?$/.exec((raw ?? '').trim());
 if (!match) return {};
 const start = Number(match[1]), end = Number(match[2] ?? match[1]);
 if (start < 1 || end < start) return {};
 return { lines: { start, end: Math.min(end, start + MAX_LINKED_LINES - 1) } };
}

export function forumShareNavigation(href: string, server: string): NavRef | null {
 try {
  const base = new URL(server), url = new URL(href, base);
  if (url.origin !== base.origin) return null;
  if (url.pathname === '/' && url.searchParams.get('wabiNav') === 'lore_file') { const channelId = url.searchParams.get('channelId'), filePath = url.searchParams.get('path'); return channelId && filePath && !filePath.split('/').includes('..') ? {kind: 'lore_file', channelId, filePath, ...loreLineRange(url.searchParams.get('lines'))} : null; }
  if (!url.pathname.startsWith('/c/')) return null;
  const ref = url.searchParams.get('ref'); if (!ref) return null;
  const split = ref.indexOf(':'); if (split < 1) return null;
  const kind = ref.slice(0, split), id = ref.slice(split + 1); if (!id) return null;
  const channelId = decodeURIComponent(url.pathname.slice(3));
  switch (kind) {
   case 'forum_post': return { kind, postId: id, channelId };
   case 'wiki_page': return { kind, pageId: id, channelId };
   case 'gallery_work': return { kind, workId: id, channelId };
   case 'place': return { kind, placeId: id };
   default: return null;
  }
 } catch { return null; }
}
