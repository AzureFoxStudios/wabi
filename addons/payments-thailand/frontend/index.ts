import type { SvelteComponent } from 'svelte';
import ThailandSettings from './ThailandSettings.svelte';

export const thailandPaymentsPlugin = {
    id: 'payments-thailand',
    settings: {
        'thailand-settings': ThailandSettings,
    },
};

export default thailandPaymentsPlugin;