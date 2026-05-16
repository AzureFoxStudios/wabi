<script lang="ts">
	import { _ } from '$lib/i18n';

	export let persistenceState: string;
	export let persistenceError: string | undefined;
	export let currentChannel: string;
	export let messageId: string;
	export let onRetry: (channelId: string, messageId: string) => void;
</script>

<div class="message-persistence-row">
	<span
		class="message-persistence-badge"
		class:is-failed={persistenceState === 'failed'}
		class:is-retrying={persistenceState === 'retrying'}
		title={persistenceError || ''}
	>
		{persistenceState === 'retrying'
			? $_('messages.persistence.retrying')
			: $_('messages.persistence.failed')}
	</span>
	{#if persistenceState === 'failed'}
		<button
			class="message-persistence-retry"
			type="button"
			on:click={() => onRetry(currentChannel, messageId)}
		>
			{$_('messages.persistence.retry')}
		</button>
	{/if}
</div>
