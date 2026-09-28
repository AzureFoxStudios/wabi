import { writable } from 'svelte/store';

/** Incremented when the Authority changes channel access or community roles. */
export const channelAccessPolicyVersion = writable(0);
