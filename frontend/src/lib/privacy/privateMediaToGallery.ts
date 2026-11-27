/**
 * The person's standing choice to copy media out of private conversations into a gallery.
 *
 * A gallery is server-readable, so "Add to gallery" is off for a message whose content stays on
 * the device (privacy/contentEgress.ts) unless this is on. It is a per-device choice, off by
 * default, and it unlocks that one action only: albums, forwarding and Lore stay off.
 */
import { writable } from 'svelte/store';

const STORAGE_KEY = 'wabi.privacy.privateMediaToGallery';

function read(): boolean {
	try {
		return typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === '1';
	} catch {
		return false;
	}
}

export const privateMediaToGallery = writable<boolean>(read());

export function setPrivateMediaToGallery(allowed: boolean): void {
	try {
		if (allowed) localStorage.setItem(STORAGE_KEY, '1');
		else localStorage.removeItem(STORAGE_KEY);
	} catch {
		/* the choice then lasts for this session only */
	}
	privateMediaToGallery.set(allowed);
}
