<script lang="ts">
	import MessageItemContent from './MessageItemContent.svelte';

	let { editText = '', ...rest } = $props<{ editText?: string; [key: string]: unknown }>();
</script>

<MessageItemContent {...rest} {editText} />
