import type { SvelteComponent } from 'svelte';
import ScreenSharePanel from './ScreenSharePanel.svelte';

export const screenSharePlugin = {
    id: 'screen-share',
    workspacePanels: ['screen-share-panel'],
    components: {
        'screen-share-panel': ScreenSharePanel,
    },
};

export default screenSharePlugin;