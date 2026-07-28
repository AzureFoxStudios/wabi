import { mobileTabQueue } from '$lib/mobileTabQueue';

export const PLANNER_ADDON_ID = 'planner';

function openPlannerSurface(): void {
	mobileTabQueue.openAddonTab(PLANNER_ADDON_ID);
}

export { openPlannerSurface };
