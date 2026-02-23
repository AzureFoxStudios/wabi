export const gitFeedPlugin = {
	id: 'git-feed',
	commands: ['/gitfeed'],
	routes: ['/api/plugins/runtime/git-feed/ingest'],
	notes: 'Pairs with existing webhook systems; focuses on cleaner feed formatting.'
};

export default gitFeedPlugin;
