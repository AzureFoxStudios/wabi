import {
	ADDON_SECTION_IDS,
	LOCAL_ADDON_CONTROL_META,
	addonControlMatches,
	tokenizeAddonSearchQuery,
	type AddonSectionId
} from './addonSettingsRegistry';

/**
 * A render snapshot, not callbacks that read mutable component state. Section
 * children also include legacy Svelte components: their props must change when
 * the query, selected section, or asynchronously detected inventory changes.
 * Deriving this snapshot keeps those dependencies explicit without remounting
 * sections (and losing their unfinished local edits).
 */
export function createAddonSettingsView(
	query: string,
	activeSection: AddonSectionId | null,
	translatorDetected: boolean
) {
	const tokens = tokenizeAddonSearchQuery(query);
	const isAvailable = (id: string) =>
		Object.hasOwn(LOCAL_ADDON_CONTROL_META, id) &&
		(id !== 'translator_addon' || translatorDetected);
	const available = Object.keys(LOCAL_ADDON_CONTROL_META).filter(isAvailable);
	const matches = new Set(
		available.filter((id) => addonControlMatches(id, tokens, isAvailable))
	);
	const sectionCounts = new Map<AddonSectionId, number>(
		ADDON_SECTION_IDS.map((section) => [section, 0])
	);
	for (const id of matches) {
		const section = LOCAL_ADDON_CONTROL_META[id].section;
		sectionCounts.set(section, (sectionCounts.get(section) ?? 0) + 1);
	}
	return {
		availableLocalAddonControlCount: available.length,
		visibleLocalAddonControlCount: matches.size,
		localAddonControlMatches: (id: string) => matches.has(id),
		addonSectionMatchCount: (section: AddonSectionId) => sectionCounts.get(section) ?? 0,
		isAddonSectionOpen: (section: AddonSectionId) =>
			tokens.length > 0 ? (sectionCounts.get(section) ?? 0) > 0 : activeSection === section
	};
}
