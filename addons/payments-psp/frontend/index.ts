import type { SvelteComponent } from 'svelte';
import PspSettings from './PspSettings.svelte';

export const pspPaymentsPlugin = {
    id: 'payments-psp',
    settings: {
        'psp-settings': PspSettings,
    },
};

export default pspPaymentsPlugin;