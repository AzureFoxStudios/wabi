<script lang="ts">
	export interface CallerInfo {
		username: string;
		isVideoCall: boolean;
		channelId?: string;
		channelName?: string;
	}

	export let caller: CallerInfo;
	export let groupCallRingingTargets: Array<{ stableUserId: string; username: string }>;
	export let scope: 'group' | 'direct';
	export let onAnswer: () => void;
	export let onReject: () => void;
	export let onOpenRingingMenu: (event: MouseEvent, target: { stableUserId: string; username: string }) => void;
</script>

<div class="call-modal-overlay">
	<div class="incoming-call-modal">
		<div class="caller-info">
			<div class="caller-avatar">{caller.username.charAt(0).toUpperCase()}</div>
			<h2>{caller.username}</h2>
			<p class="call-type">{caller.isVideoCall ? 'Video' : 'Voice'} {caller.channelId ? 'Group Call' : 'Call'}</p>
			{#if caller.channelName}
				<p class="call-subtitle">{caller.channelName}</p>
			{/if}
			{#if scope === 'group' && groupCallRingingTargets.length > 0}
				<div class="ringing-targets-panel outgoing">
					<div class="ringing-targets-label">Right-click or tap a name to stop ringing that person.</div>
					<div class="ringing-targets-list">
						{#each groupCallRingingTargets as target (target.stableUserId)}
							<button
								type="button"
								class="ringing-target-chip"
								title={`Manage ringing for ${target.username}`}
								on:click={(event) => onOpenRingingMenu(event, target)}
								on:contextmenu={(event) => onOpenRingingMenu(event, target)}
							>
								<span class="ringing-target-name">{target.username}</span>
								<span class="ringing-target-state">Ringing</span>
							</button>
						{/each}
					</div>
				</div>
			{/if}
		</div>
		<div class="call-actions">
			<button class="answer-btn" on:click={onAnswer}>Answer</button>
			<button class="reject-btn" on:click={onReject}>Decline</button>
		</div>
	</div>
</div>
