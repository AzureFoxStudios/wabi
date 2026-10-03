import type { NavRef } from './pendingNav';

export function resolveGlanceChannel(ref: NavRef,
 channels: ReadonlyArray<{id: string; name?: string}>,
 records: ReadonlyArray<{kind: string; id: string; channelId?: string}>
): string | undefined {
 let id = 'channelId' in ref ? ref.channelId : undefined;
 if (ref.kind === 'channel') {
  const name = ref.channelId.replace(/^#/, '').trim().toLowerCase();
  id = channels.find(channel => channel.id === ref.channelId || channel.name?.toLowerCase() === name)?.id;
 } else if (!id) {
  const objectId = ref.kind === 'wiki_page' ? ref.pageId : ref.kind === 'forum_post' ? ref.postId : ref.kind === 'gallery_work' ? ref.workId : undefined;
  const matches = records.filter(record => record.kind === ref.kind && record.id === objectId);
  const owners = [...new Set(matches.map(record => record.channelId).filter(Boolean))];
  if (owners.length === 1) id = owners[0];
 }
 return channels.some(channel => channel.id === id) ? id : undefined;
}

export function websiteGlanceUrl(href: string): string | null {
 try { const url = new URL(href); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; }
 catch { return null; }
}

export function glanceMediaKind(href: string): 'image' | 'video' | 'audio' | null {
 try {
  const path = decodeURIComponent(new URL(href).pathname).toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif|svg)$/.test(path)) return 'image';
  if (/\.(mp4|webm|mov|m4v)$/.test(path)) return 'video';
  if (/\.(mp3|wav|ogg|m4a|flac)$/.test(path)) return 'audio';
 } catch { /* A malformed URL is not a media preview. */ }
 return null;
}
