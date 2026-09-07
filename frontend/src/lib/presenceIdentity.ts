import { writable } from 'svelte/store';
import type { User } from './socket-types';

// Leaf state: derived lookups must not import the SocketManager/command graph
// to obtain these stores. presenceStore re-exports these exact same instances.
export const users = writable<User[]>([]);
export const serverMembers = writable<User[]>([]);
export const currentUser = writable<User | null>(null);
