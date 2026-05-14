import type { SvelteComponent } from 'svelte';
import MapsPanel from './MapsPanel.svelte';

export const mapsPlugin = {
    id: 'maps',
    workspacePanels: ['maps-panel'],
    components: {
        'maps-panel': MapsPanel,
    },
};

export default mapsPlugin;