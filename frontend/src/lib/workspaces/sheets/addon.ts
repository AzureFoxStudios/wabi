import { mobileTabQueue } from '$lib/mobileTabQueue';
import { closeWorkspaceKind } from '../bridge';
import { workspaceAddonEnabled } from '../addonState';
export const available = true;
export function onInit() { workspaceAddonEnabled.update(v => ({ ...v, sheets: true })); }
export async function onDisable() {
    await closeWorkspaceKind('sheets');
    workspaceAddonEnabled.update(v => ({ ...v, sheets: false }));
    mobileTabQueue.unregisterAddonTab('workspace-sheets');
}
export const onUnload = onDisable;
export const loadWorkspace = () => import('./SheetsWorkspace.svelte');
