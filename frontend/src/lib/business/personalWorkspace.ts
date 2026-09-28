import { derived, writable } from 'svelte/store';
import { currentUser } from '$lib/presenceIdentity';
import { isDesktopTauri } from '$lib/tauri-platform';
import type { PlannerOwner } from './session';

/** Explicit app-level entry; independent of any selected community/account. */
export function isPersonalWorkspace(): boolean {
    return typeof window !== 'undefined' && window.location.pathname.replace(/\/$/, '') === '/personal';
}
export const personalWorkspace = writable(isPersonalWorkspace());
/** Local attribution never borrows the previously selected community identity. */
export const plannerActor = derived([personalWorkspace, currentUser], ([$personal, $user]) =>
    $personal ? { id: 'personal', username: 'Me', dbUserId: undefined } : $user);
export function personalPlannerOwner(): PlannerOwner {
    if (!isPersonalWorkspace()) throw new Error('Open your personal workspace first.');
    if (isDesktopTauri()) return { scopeId: 'planner:personal-desktop:v1', isCurrent: isPersonalWorkspace };
    const key = 'wabi:personal-planner:identity:v1';
    let id = localStorage.getItem(key);
    if (id && !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Personal workspace identity is damaged. Existing records have not been changed.');
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(key, id); }
    const scopeId = `planner:personal-browser:v1:${id}`;
    return { scopeId, isCurrent: () => isPersonalWorkspace() && localStorage.getItem(key) === id };
}
