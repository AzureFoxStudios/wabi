export const ffxivSuperAddonPlugin = {
	id: 'ffxiv-super-addon',
	commands: ['/ffxiv', '/xiv', '/raid', '/market'],
	workspacePanels: ['ffxiv-reference'],
	routes: [
		'/api/plugins/runtime/ffxiv-super-addon/state',
		'/api/plugins/runtime/ffxiv-super-addon/lookup',
		'/api/plugins/runtime/ffxiv-super-addon/pin',
		'/api/plugins/runtime/ffxiv-super-addon/unpin',
		'/api/plugins/runtime/ffxiv-super-addon/note',
		'/api/plugins/runtime/ffxiv-super-addon/wipe',
		'/api/plugins/runtime/ffxiv-super-addon/template'
	],
	notes:
		'Static XIVAPI cards, Universalis market lookups, and raid-planning state for channel-scoped planning boards.'
};

export default ffxivSuperAddonPlugin;
