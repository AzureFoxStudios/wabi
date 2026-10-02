import { writable } from 'svelte/store';
import { getAddonConfig } from '$lib/addons/settings';
import { enableAddon, disableAddon, saveEnabledAddonIds, getAddon } from '$lib/addons/loader';
export const workspaceAddonEnabled = writable({ sheets: false, present: false });
export type OfficeAddon = 'sheets' | 'present';
export async function hydrateWorkspaceAddons() {
    const config = await getAddonConfig('_user_enabled');
    const enabled = new Set<string>(Array.isArray(config?.addonIds) ? config.addonIds : []);
    workspaceAddonEnabled.set({ sheets: getAddon('sheets')?.enabled || enabled.has('sheets'), present: getAddon('present')?.enabled || enabled.has('present') });
}
export async function setWorkspaceAddonEnabled(id: OfficeAddon, enabled: boolean) {
    if (enabled) await enableAddon(id); else await disableAddon(id);
    const config = await getAddonConfig('_user_enabled');
    const ids = new Set<string>(Array.isArray(config?.addonIds) ? config.addonIds : []);
    if (enabled) ids.add(id); else ids.delete(id);
    await saveEnabledAddonIds([...ids]);
    workspaceAddonEnabled.update(value => ({ ...value, [id]: enabled }));
}
