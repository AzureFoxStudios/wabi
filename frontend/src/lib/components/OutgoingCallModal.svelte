<script lang="ts">
	type OutgoingCallerInfo = {
		username: string;
		isVideoCall: boolean;
		scope: 'group' | 'direct';
		channelName?: string;
	};

	export let caller: OutgoingCallerInfo;
	export let groupCallRingingTargets: Array<{ stableUserId: string; username: string }>;
	export let onCancel: () => void;
	export let onOpenRingingMenu: (event: MouseEvent, target: { stableUserId: string; username: string }) => void;
</script>

<div class="call-modal-overlay">
	<div class="incoming-call-modal">
		<div class="caller-info">
			<div class="caller-avatar">{caller.username.charAt(0).toUpperCase()}</div>
			<h2>{caller.username}</h2>
			<p class="call-type">Calling... {caller.isVideoCall ? 'Video' : 'Voice'} {caller.scope === 'group' ? 'Group Call' : 'Call'}</p>
			{#if caller.channelName}
				<p class="call-subtitle">Ringing {caller.channelName}</p>
			{/if}
			{#if caller.scope === 'group' && groupCallRingingTargets.length > 0}
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
			<button class="reject-btn" on:click={onCancel}>Cancel</button>
		</div>
	</div>
</div>
