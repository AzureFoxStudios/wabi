export const musicSyncPlugin = {
	id: 'music-sync',
	commands: ['/music'],
	providers: ['spotify', 'youtube-music', 'local-link'],
	notes: 'Shared queue + playback sync scaffold.'
};

export default musicSyncPlugin;
