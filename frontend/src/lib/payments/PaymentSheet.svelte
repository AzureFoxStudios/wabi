<script lang="ts">
	import PaymentSheetImpl from './PaymentSheetImpl.svelte';

	export let isOpen = false;
	export let onClose: () => void = () => {};
	export let onManageConnections: () => void = () => {};
	export let defaultChannelId: string | null = null;
	export let defaultTargetLabel: string | null = null;
	export let defaultTargetKind: 'channel' | 'dm' | 'group' | 'workspace' | null = null;
	export let openSeed = 0;
	export let initialAmountInput: string | null = null;
	export let initialCurrency: string | null = null;
	export let initialCountryCode: string | null = null;
	export let initialDescription: string | null = null;
	export let initialCustomerRef: string | null = null;
	export let initialProviderId: string | null = null;
	export let initialMethodId: string | null = null;
	export let initialMetadata: Record<string, unknown> | null = null;
	export let overlayZIndex: number | string | null = null;
</script>

<PaymentSheetImpl
	{isOpen}
	{onClose}
	{onManageConnections}
	{defaultChannelId}
	{defaultTargetLabel}
	{defaultTargetKind}
	{openSeed}
	{initialAmountInput}
	{initialCurrency}
	{initialCountryCode}
	{initialDescription}
	{initialCustomerRef}
	{initialProviderId}
	{initialMethodId}
	{initialMetadata}
	{overlayZIndex}
/>
