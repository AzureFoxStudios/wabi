import {
	ADDON_SECTION_IDS,
	LOCAL_ADDON_CONTROL_META,
	addonControlMatches,
	tokenizeAddonSearchQuery,
	type AddonSectionId
} from './addonSettingsRegistry';

/** Top-level filter for the Add-ons list (Blender's category dropdown). */
export type AddonCategoryFilter = 'all' | 'server' | 'bundled' | AddonSectionId;

/**
 * A render snapshot, not callbacks that read mutable component state. Section
 * children receive `localAddonControlMatches`; the query, the Enabled Only
 * filter and the category filter all narrow the same set of local controls.
 * Bundled client-side addons such as Translator Assist remain discoverable here
 * even while their runtime mode is disabled; turning the addon on is itself a
 * local setting.
 */
export function createAddonSettingsView(
	query: string,
	enabledOnly: boolean,
	enabledState: Record<string, boolean>,
	category: AddonCategoryFilter = 'all'
) {
	const tokens = tokenizeAddonSearchQuery(query);
	const isAvailable = (id: string) => Object.hasOwn(LOCAL_ADDON_CONTROL_META, id);
	const available = Object.keys(LOCAL_ADDON_CONTROL_META).filter(isAvailable);
	const inCategory = (id: string) => {
		// Server/bundled are inventory groups, not local sections: they render no
		// local controls at all, so the counts must agree with the shell.
		if (category === 'server' || category === 'bundled') return false;
		if (category === 'all') return true;
		return LOCAL_ADDON_CONTROL_META[id].section === category;
	};
	const matches = new Set(
		available.filter(
			(id) =>
				addonControlMatches(id, tokens, isAvailable) &&
				inCategory(id) &&
				// Rows that have not reported yet stay visible; the registry fills in as sections mount.
				(!enabledOnly || enabledState[id] !== false)
		)
	);
	const sectionCounts = new Map<AddonSectionId, number>(
		ADDON_SECTION_IDS.map((section) => [section, 0])
	);
	for (const id of matches) {
		const section = LOCAL_ADDON_CONTROL_META[id].section;
		sectionCounts.set(section, (sectionCounts.get(section) ?? 0) + 1);
	}
	return {
		inventoryAddonMatches: (addon: { id: string; name: string; enabled?: boolean }, group: 'server' | 'bundled') => {
			const haystack = `${addon.id} ${addon.name} ${group}`.toLowerCase();
			return (!enabledOnly || addon.enabled !== false) && tokens.every((token) => haystack.includes(token));
		},
		availableLocalAddonControlCount: available.length,
		visibleLocalAddonControlCount: matches.size,
		localAddonControlMatches: (id: string) => matches.has(id),
		addonSectionMatchCount: (section: AddonSectionId) => sectionCounts.get(section) ?? 0,
		showServerRows: category === 'all' || category === 'server',
		showBundledRows: category === 'all' || category === 'bundled',
		showLocalRows: category !== 'server' && category !== 'bundled'
	};
}
