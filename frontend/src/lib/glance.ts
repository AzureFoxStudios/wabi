import { get, writable } from 'svelte/store';
import { channels } from './channelStore';
import { objectRefStore } from './objectRefRegistry';
import { resolveGlanceChannel, websiteGlanceUrl } from './glanceTarget';
import type { NavRef } from './pendingNav';

export type GlanceTarget = { ref: NavRef; channelId?: string } | { url: string; title?: string };
export const glance = writable<GlanceTarget | null>(null);
export function closeGlance() { glance.set(null); }
/** Resolve without changing the selected channel or consuming center-stage navigation. */
export function openGlance(ref: NavRef): boolean {
 if (ref.kind === 'place') { glance.set({ref}); return true; }
 const channelId = resolveGlanceChannel(ref, get(channels), [...get(objectRefStore).values()]);
 if (!channelId) return false;
 glance.set({ ref, channelId });
 return true;
}
export function openWebsiteGlance(href: string, title?: string): boolean {
 const url = websiteGlanceUrl(href);
 if (!url) return false;
 glance.set({url, title: title?.trim().slice(0, 120) || undefined}); return true;
}
