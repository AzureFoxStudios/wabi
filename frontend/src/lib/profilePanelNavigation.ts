import { layoutStore } from './layoutStore';
import { profilePanel } from './profilePanelState';
import type { User } from './socket-types';

export function openProfilePanel(user: User): boolean {
	if (!profilePanel.select(user)) return false;
	layoutStore.openRightPanel('profile');
	return true;
}
