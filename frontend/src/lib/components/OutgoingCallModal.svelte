<script lang="ts">
	import { _ } from '$lib/i18n';
	type OutgoingCallerInfo = {
		username: string;
		isVideoCall: boolean;
		scope: 'group' | 'direct';
		channelName?: string;
		status?: 'connecting' | 'ringing';
	};

	export let caller: OutgoingCallerInfo;
	export let groupCallRingingTargets: Array<{ stableUserId: string; username: string }>;
	export let onCancel: () => void;
	export let onOpenRingingMenu: (event: MouseEvent, target: { stableUserId: string; username: string }) => void;
</script>

<div class="call-modal-overlay" role="dialog" aria-modal="true" tabindex="-1">
	<div class="incoming-call-modal">
		<div class="caller-info">
			<div class="caller-avatar">{caller.username.charAt(0).toUpperCase()}</div>
			<h2>{caller.username}</h2>
			<p class="call-type">{caller.status === 'ringing' ? $_('outgoing_call.ringing_waiting') : $_('outgoing_call.connecting')} · {caller.isVideoCall ? $_('gallery.filter_video') : $_('sidebar.voice')} {caller.scope === 'group' ? $_('outgoing_call.group_call') : $_('user.popout.call')}</p>
			{#if caller.channelName}
				<p class="call-subtitle">{$_('outgoing_call.ringing_in', { values: { channel: caller.channelName } })}</p>
			{/if}
			{#if caller.scope === 'group' && groupCallRingingTargets.length > 0}
				<div class="ringing-targets-panel outgoing">
					<div class="ringing-targets-label">{$_('outgoing_call.right_click_hint')}</div>
					<div class="ringing-targets-list">
						{#each groupCallRingingTargets as target (target.stableUserId)}
							<button
								type="button"
								class="ringing-target-chip"
								title={$_('outgoing_call.manage_ringing', { values: { name: target.username } })}
								on:click={(event) => onOpenRingingMenu(event, target)}
								on:contextmenu={(event) => onOpenRingingMenu(event, target)}
							>
								<span class="ringing-target-name">{target.username}</span>
								<span class="ringing-target-state">{$_('outgoing_call.ringing')}</span>
							</button>
						{/each}
					</div>
				</div>
			{/if}
		</div>
		<div class="call-actions">
			<button class="reject-btn" on:click={onCancel}>{$_('common.cancel')}</button>
		</div>
	</div>
</div>
