export const youtubeWatchPlugin = {
  id: 'youtube-watch',
  providers: ['youtube'],
  commands: ['/watch'],
  modes: ['open', 'presenter', 'vote'],
  notes: 'Phase 1 scaffold only: wire this into channel UI panel/player in next step.'
};

export default youtubeWatchPlugin;
