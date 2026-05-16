<script lang="ts">
	import MessageItemContent from './MessageItemContent.svelte';

	const forwardedProps = $$props as any;
</script>

<MessageItemContent {...forwardedProps} />
