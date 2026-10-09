import { writable } from 'svelte/store';
import type { WorkspaceViewKey } from '$lib/components/chat/types';

/**
 * The view switcher lives in the channel header, which is rendered deep inside Chat.
 * MainLayout owns what selecting a view does, so it publishes the handler here.
 */
export const workspaceViewSelect = writable<((view: WorkspaceViewKey) => void) | null>(null);
export const workspaceActivityBadge = writable<string>('');
