import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';

// Dead code removed in the redesign's wave 2, each with grep proof of no importer (static, dynamic
// or by string) anywhere in the frontend, scripts or add-ons at the time of deletion. A file
// coming back without a caller fails here; wire it up and remove it from this list instead.
const at = (path: string) => new URL(path, import.meta.url);
const REMOVED = [
	// The /business donor assets: /business redirects to Planner, nothing imported these.
	'./components/business/BusinessSurface.svelte',
	'./business/pageHelpers.ts',
	'../routes/business/businessPageHelpers.ts',
	'../routes/business/businessPage.css',
	'./business/theme.css',
	'./addons/server-map/MapTokenBoard.svelte',
	// Replaced in wave 1: DM retention menus, the profile card's presence menu, kit icons in
	// Settings, the unified channel list, the shared context menu.
	'./components/DmRetentionControl.svelte',
	'./components/StatusPopup.svelte',
	'./components/settings/SettingsTabIcon.svelte',
	'./components/sidebar/TextChannelList.svelte',
	'./components/sidebar/ForumChannelList.svelte',
	'./components/sidebar/GalleryChannelList.svelte',
	'./components/sidebar/WikiChannelList.svelte',
	// The last per-kind list: UnifiedChannelList is the only channel list the sidebar renders,
	// and the call-panel browser harness now mounts that instead.
	'./components/sidebar/VoiceChannelList.svelte',
	'./components/UserContextMenu.svelte',
	// Wave 2 legacy retirement: the desktop floating voice card's sheet (the strip is phone-only,
	// styled in styles/surfaces/mobile.css; its 1280px rule used Svelte-only :global() and never
	// applied).
	'../styles/components/main-layout-part2.css',
	// Its phone rules matched nothing the drawer still draws, but for the close key and the list's
	// hidden bar, which moved to styles/surfaces/mobile.css.
	'../styles/components/sidebar-mobile.css'
];

describe('removed dead code stays removed', () => {
	test.each(REMOVED)('%s is gone', (path) => {
		expect(existsSync(at(path))).toBe(false);
	});

	test('the /business route is only the redirect to Planner and imports nothing missing', () => {
		const page = readFileSync(at('../routes/business/+page.svelte'), 'utf8');
		expect(page).toContain('openPlannerSurface();');
		for (const match of page.matchAll(/import\s+['"](\.[^'"]+)['"]/g)) {
			expect(existsSync(new URL(match[1], at('../routes/business/+page.svelte')))).toBe(true);
		}
	});

	test('Lore UI is product UI and is not purged with the dead code (AGENTS.md rule 6)', () => {
		expect(existsSync(at('./components/LoreChannel.svelte'))).toBe(true);
		expect(existsSync(at('./components/sidebar/LoreChannelList.svelte'))).toBe(true);
	});
});
