export const livePollsPlugin = {
	id: 'live-polls',
	commands: ['/poll'],
	supportedScopes: ['channel', 'dm', 'group'],
	notes: 'MVP sockets are live; UI panel can subscribe to poll:state events.'
};

export default livePollsPlugin;
