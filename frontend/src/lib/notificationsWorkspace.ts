import { mobileTabQueue } from './mobileTabQueue';

export const NOTIFICATIONS_ADDON_ID = 'notifications';

export function openNotificationsSurface(): void {
	mobileTabQueue.openAddonTab(NOTIFICATIONS_ADDON_ID);
}
