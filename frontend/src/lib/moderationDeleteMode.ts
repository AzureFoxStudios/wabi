import { writable } from 'svelte/store';

/**
 * Shared moderation deletion-mode store.
 *
 * Deletion mode is a mod/admin power toggle activated by `/delete` in the
 * composer (and exited with Escape or `/delete` again). Keeping it in a store
 * lets the composer command and the message list agree without threading
 * callbacks through the component tree.
 */
export const deletionModeEnabled = writable<boolean>(false);
