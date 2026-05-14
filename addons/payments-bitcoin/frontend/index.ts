import type { SvelteComponent } from 'svelte';
import BitcoinSettings from './BitcoinSettings.svelte';

export const bitcoinPaymentsPlugin = {
    id: 'payments-bitcoin',
    settings: {
        'bitcoin-settings': BitcoinSettings,
    },
};

export default bitcoinPaymentsPlugin;