import { writable } from 'svelte/store';
import { layoutStore } from './layoutStore';
import type { AdminSection } from './adminNavigation';

/** One selected Admin destination shared by its entry points; not a saved layout. */
export const adminSection = writable<AdminSection>('overview');

export function openAdminSection(section: AdminSection = 'overview'): void {
	adminSection.set(section);
	layoutStore.showAdminCenterStage();
}
