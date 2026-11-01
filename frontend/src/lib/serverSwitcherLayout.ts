/**
 * Where the desktop saved-servers switcher sits (design contract §8.1): over the sidebar, at the
 * sidebar's width, beside the server rail rather than on top of it, and never so narrow that it
 * stops being usable.
 *
 * The panel works this out for itself from the sidebar width (layoutStore) and the rail's
 * rendered width (written by ServerRail), so it does not depend on how MainLayout sizes the
 * overlay element it is mounted in. That overlay lets the pointer through wherever the panel
 * is not.
 */
import { writable } from 'svelte/store';

/**
 * The narrowest the switcher gets: a compact (60–160px) or collapsed sidebar still gets a
 * switcher whose names, hosts and "Add server" fit (the default sidebar is 280px too).
 */
export const SWITCHER_MIN_WIDTH = 280;

/** The desktop server rail's rendered width; 0 while it is not shown. ServerRail keeps it. */
export const desktopServerRailWidth = writable(0);

export interface SwitcherPanelGeometry {
	/** Distance from the shell's leading edge: the rail stays visible beside the switcher. */
	offset: number;
	/** The sidebar's own width, but never below SWITCHER_MIN_WIDTH. */
	width: number;
}

function clampWidth(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

export function switcherPanelGeometry(sidebarWidth: number, railWidth: number): SwitcherPanelGeometry {
	return {
		offset: clampWidth(railWidth),
		width: Math.max(clampWidth(sidebarWidth), SWITCHER_MIN_WIDTH)
	};
}
