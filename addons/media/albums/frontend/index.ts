import type { SvelteComponent } from 'svelte';
import AlbumsPanel from './AlbumsPanel.svelte';

export const albumsPlugin = {
    id: 'albums',
    workspacePanels: ['albums-panel'],
    components: {
        'albums-panel': AlbumsPanel,
    },
};

export default albumsPlugin;