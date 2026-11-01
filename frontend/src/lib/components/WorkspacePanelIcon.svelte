<script lang="ts">
	// Thin wrapper over the one icon registry (design contract §6). The public prop is unchanged,
	// so the rail, the companion tabs and AdminCenterStage keep passing their panel icon names;
	// a registry name is accepted too, for callers that move to the contract vocabulary.
	import type { WorkspacePanelIcon as WorkspacePanelIconType } from '$lib/workspacePanels';
	import Icon from './ui/Icon.svelte';
	import { isIconName, type IconName } from './ui/icons';

	export let icon: WorkspacePanelIconType | IconName = 'box';

	// Panel vocabulary → registry glyph. One meaning per glyph: DMs is the round bubble (not the
	// forum's two bubbles), Wiki the closed book, Notes the note page, My Planner's Tasks the
	// calendar-check, Admin the key (as in Settings; the shield means Privacy & security and the
	// gear means Settings), Media the picture, CAD and add-on panels a box, and the admin health
	// sections a pulse line (the bell is reserved for the Activity workspace).
	const PANEL_GLYPHS: Record<WorkspacePanelIconType, IconName> = {
		users: 'users',
		messages: 'dm',
		notes: 'note',
		wiki: 'book',
		forum: 'forum',
		layers: 'layers',
		map: 'map',
		media: 'image',
		admin: 'key',
		settings: 'gear',
		box: 'box',
		activity: 'pulse',
		tasks: 'calendarCheck',
		transfers: 'transfers',
		headphones: 'headphones'
	};

	function glyphFor(name: WorkspacePanelIconType | IconName): IconName {
		if (Object.prototype.hasOwnProperty.call(PANEL_GLYPHS, name)) return PANEL_GLYPHS[name as WorkspacePanelIconType];
		return isIconName(name) ? name : 'box';
	}

	$: glyph = glyphFor(icon);
</script>

<!-- The host (.stub-icon, .panel-tab-icon, .admin-nav-icon) sets the box; the glyph fills it. -->
<Icon name={glyph} size="100%" style="display: block" />
