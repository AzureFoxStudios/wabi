/**
 * Enabled-state registry for the Add-ons tab.
 *
 * The Blender-style "Enabled Only" filter needs to know whether each add-on is
 * on, but the switches themselves live inside nine section components that read
 * their own stores. Every rendered row reports its state here instead, so the
 * shell can filter one flat list without reaching into section internals.
 */
export const addonEnabledState = $state<Record<string, boolean>>({});

export function reportAddonEnabled(id: string, enabled: boolean): void {
	if (addonEnabledState[id] === enabled) return;
	addonEnabledState[id] = enabled;
}
