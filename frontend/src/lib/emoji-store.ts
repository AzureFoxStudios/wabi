import { writable } from 'svelte/store';
import type { Emoji } from './socket-types';

export const emojis = writable<Emoji[]>([]);
