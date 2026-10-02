import { mobileTabQueue } from '$lib/mobileTabQueue';
import { closeWorkspaceKind } from '../bridge';
import { workspaceAddonEnabled } from '../addonState';
export const available = true;
export function onInit() { workspaceAddonEnabled.update(v => ({ ...v, present: true })); }
export async function onDisable() {
    await closeWorkspaceKind('present');
    workspaceAddonEnabled.update(v => ({ ...v, present: false }));
    mobileTabQueue.unregisterAddonTab('workspace-present');
}
export const onUnload = onDisable;
export const loadWorkspace = () => import('./PresentWorkspace.svelte');
