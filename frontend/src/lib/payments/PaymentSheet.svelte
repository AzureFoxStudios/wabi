<script lang="ts">
	import PaymentSheetImpl from './PaymentSheetImpl.svelte';

	let {
		isOpen = false,
		onClose,
		onManageConnections,
		defaultChannelId = null,
		defaultTargetLabel = null,
		defaultTargetKind = null,
		openSeed = 0,
		initialAmountInput = null,
		initialCurrency = null,
		initialCountryCode = null,
		initialDescription = null,
		initialCustomerRef = null,
		initialProviderId = null,
		initialMethodId = null,
		initialMetadata = null,
		overlayZIndex = null
	}: {
		isOpen?: boolean;
		onClose?: () => void;
		onManageConnections?: () => void;
		defaultChannelId?: string | null;
		defaultTargetLabel?: string | null;
		defaultTargetKind?: 'channel' | 'dm' | 'group' | 'workspace' | null;
		openSeed?: number;
		initialAmountInput?: string | null;
		initialCurrency?: string | null;
		initialCountryCode?: string | null;
		initialDescription?: string | null;
		initialCustomerRef?: string | null;
		initialProviderId?: string | null;
		initialMethodId?: string | null;
		initialMetadata?: Record<string, unknown> | null;
		overlayZIndex?: number | string | null;
	} = $props();
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
