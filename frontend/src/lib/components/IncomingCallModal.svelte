<script lang="ts">
	import { _ } from '$lib/i18n';
	type CallerInfo = {
		username: string;
		isVideoCall: boolean;
		channelId?: string;
		channelName?: string;
	};

	export let caller: CallerInfo;
	export let groupCallRingingTargets: Array<{ stableUserId: string; username: string }>;
	export let scope: 'group' | 'direct';
	export let onAnswer: () => void;
	export let onReject: () => void;
	export let onOpenRingingMenu: (event: MouseEvent, target: { stableUserId: string; username: string }) => void;
</script>

<div class="call-modal-overlay" role="dialog" aria-modal="true" tabindex="-1">
	<div class="incoming-call-modal">
		<div class="caller-info">
			<div class="caller-avatar">{caller.username.charAt(0).toUpperCase()}</div>
			<h2>{caller.username}</h2>
			<p class="call-type">{caller.isVideoCall ? $_('chat.dm.video') : $_('sidebar.voice')} {caller.channelId ? $_('incoming_call.group_call') : $_('chat.dm.call')}</p>
			{#if caller.channelName}
				<p class="call-subtitle">{caller.channelName}</p>
			{/if}
			{#if scope === 'group' && groupCallRingingTargets.length > 0}
				<div class="ringing-targets-panel outgoing">
					<div class="ringing-targets-label">{$_('incoming_call.ringing_hint')}</div>
					<div class="ringing-targets-list">
						{#each groupCallRingingTargets as target (target.stableUserId)}
							<button
								type="button"
								class="ringing-target-chip"
								title={$_('incoming_call.manage_ringing', { values: { name: target.username } })}
								on:click={(event) => onOpenRingingMenu(event, target)}
								on:contextmenu={(event) => onOpenRingingMenu(event, target)}
							>
								<span class="ringing-target-name">{target.username}</span>
								<span class="ringing-target-state">{$_('incoming_call.ringing')}</span>
							</button>
						{/each}
					</div>
				</div>
			{/if}
		</div>
		<div class="call-actions">
			<button class="answer-btn" on:click={onAnswer}>{$_('incoming_call.answer')}</button>
			<button class="reject-btn" on:click={onReject}>{$_('activity.decline')}</button>
		</div>
	</div>
</div>
