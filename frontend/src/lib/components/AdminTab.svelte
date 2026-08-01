<script lang="ts">
	import { onMount } from 'svelte';
	import { layoutStore } from '$lib/layoutStore';
	import { getAuthToken } from '$lib/authSession';
	import { channels, currentChannel, currentUser, users, joinChannel } from '$lib/socket';
	import { getAdminPaymentAccessPolicy, getApiBase, type PaymentAccessPolicy } from '$lib/api';

	type ServerPulse = { onlineUsers: number; totalUsers: number };

	let serverPulse: ServerPulse | null = null;
	let serverPulseLoading = false;
	let channelPulseError = false;

	let paymentPolicy: PaymentAccessPolicy | null = null;
	let paymentPolicyLoading = false;
	let paymentForbidden = false;

	$: role = $currentUser?.highestRole || 'member';
	$: canManage = role === 'owner' || role === 'admin';
	$: canModerate = canManage || role === 'mod';

	$: activeChannel = $channels.find((ch) => ch.id === $currentChannel) || null;
	$: textChannels = $channels.filter(
		(ch) => ch.type === 'text' || ch.type === 'public' || ch.type === 'thread_public'
	);
	$: onlineCount = $users.filter((u) => u.status === 'active' || u.status === 'away' || u.status === 'busy').length;
	$: staffOnline = $users.filter(
		(u) =>
			(u.highestRole === 'owner' || u.highestRole === 'admin' || u.highestRole === 'mod') &&
			(u.status === 'active' || u.status === 'away' || u.status === 'busy')
	);

	async function loadServerPulse() {
		const token = getAuthToken();
		if (!token) return;
		serverPulseLoading = true;
		try {
			const res = await fetch(`${getApiBase()}/api/admin/stats`, {
				headers: { Authorization: `Bearer ${token}` }
			});
			if (res.ok) {
				const data = await res.json();
				serverPulse = {
					onlineUsers: data?.overview?.onlineUsers ?? 0,
					totalUsers: data?.overview?.totalUsers ?? 0
				};
				channelPulseError = false;
			} else {
				// Finding 27: distinguish "no data" from request failure
				channelPulseError = true;
				console.warn(`[Admin] stats failed: HTTP ${res.status}`);
			}
		} catch (err) {
			channelPulseError = true;
			console.warn('[Admin] stats network error:', err);
		} finally {
			serverPulseLoading = false;
		}
	}

	async function loadPaymentStatus() {
		if (!canManage) return;
		const token = getAuthToken();
		if (!token) return;
		paymentPolicyLoading = true;
		paymentForbidden = false;
		try {
			paymentPolicy = await getAdminPaymentAccessPolicy(token);
		} catch {
			paymentForbidden = true;
		} finally {
			paymentPolicyLoading = false;
		}
	}

	function openDashboard() {
		layoutStore.showAdminCenterStage();
	}

	function selectChannel(channelId: string) {
		joinChannel(channelId);
	}

	onMount(() => {
		void loadServerPulse();
		void loadPaymentStatus();
		const interval = setInterval(loadServerPulse, 30000);
		return () => clearInterval(interval);
	});
</script>

<div class="ops-rail">
	<header class="ops-rail-head">
		<div class="ops-role-badge" class:ops-role-owner={role === 'owner'} class:ops-role-admin={role === 'admin'} class:ops-role-mod={role === 'mod'}>
			{role}
		</div>
		<div class="ops-head-copy">
			<span class="ops-head-title">Staff Ops</span>
			<span class="ops-head-sub">ambient controls</span>
		</div>
	</header>

	<button class="ops-open-dashboard" on:click={openDashboard}>
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<rect x="3" y="3" width="7" height="7" rx="1" />
			<rect x="14" y="3" width="7" height="7" rx="1" />
			<rect x="14" y="14" width="7" height="7" rx="1" />
			<rect x="3" y="14" width="7" height="7" rx="1" />
		</svg>
		Open full dashboard
	</button>

	<div class="ops-cards">
		<div class="ops-card">
			<span class="ops-card-label">Server Pulse</span>
			{#if serverPulseLoading && !serverPulse}
				<span class="ops-card-value ops-muted">—</span>
			{:else if serverPulse}
				<span class="ops-card-value">
					<span class="ops-pulse-dot"></span>{serverPulse.onlineUsers}
					<span class="ops-card-unit">/ {serverPulse.totalUsers} online</span>
				</span>
			{:else}
				<span class="ops-card-value ops-muted">no data</span>
			{/if}
		</div>

		<div class="ops-card">
			<span class="ops-card-label">Channel Pulse</span>
			{#if activeChannel}
				<span class="ops-card-value ops-channel-name">#{activeChannel.name}</span>
				<span class="ops-card-unit">{activeChannel.type}</span>
			{:else}
				<span class="ops-card-value ops-muted">none active</span>
			{/if}
		</div>
	</div>

	<section class="ops-section">
		<div class="ops-section-head">
			<span class="ops-section-label">Text Channels</span>
			<span class="ops-section-count">{textChannels.length}</span>
		</div>
		<div class="ops-channel-list">
			{#each textChannels.slice(0, 8) as channel (channel.id)}
				<button
					class="ops-channel"
					class:ops-channel-active={channel.id === $currentChannel}
					on:click={() => selectChannel(channel.id)}
				>
					<span class="ops-channel-hash">#</span>
					<span class="ops-channel-name">{channel.name}</span>
				</button>
			{:else}
				<span class="ops-empty">No text channels</span>
			{/each}
		</div>
	</section>

	<section class="ops-section">
		<div class="ops-section-head">
			<span class="ops-section-label">Online</span>
			<span class="ops-section-count">{onlineCount}</span>
		</div>
		{#if staffOnline.length > 0}
			<div class="ops-staff-list">
				{#each staffOnline.slice(0, 5) as staff (staff.id)}
					<span class="ops-staff" class:ops-staff-owner={staff.highestRole === 'owner'} class:ops-staff-admin={staff.highestRole === 'admin'} class:ops-staff-mod={staff.highestRole === 'mod'}>
						<span class="ops-staff-dot"></span>
						<span class="ops-staff-name">{staff.username}</span>
						<span class="ops-staff-role">{staff.highestRole}</span>
					</span>
				{/each}
			</div>
		{:else}
			<span class="ops-empty">No staff online</span>
		{/if}
	</section>

	{#if canManage}
		<section class="ops-section">
			<div class="ops-section-head">
				<span class="ops-section-label">Payments</span>
			</div>
			{#if paymentPolicyLoading}
				<span class="ops-empty">loading…</span>
			{:else if paymentForbidden}
				<span class="ops-empty">restricted</span>
			{:else if paymentPolicy}
				<span class="ops-payment-status" class:ops-payment-on={paymentPolicy.enabled}>
					<span class="ops-payment-dot"></span>
					{paymentPolicy.enabled ? 'Enabled' : 'Disabled'}
					{#if paymentPolicy.allowGuest}<span class="ops-payment-tag">guest</span>{/if}
				</span>
				<span class="ops-card-unit">{paymentPolicy.allowedRoleNames.length} role(s) allowed</span>
			{:else}
				<span class="ops-empty">no data</span>
			{/if}
		</section>
	{:else}
		<section class="ops-section">
			<div class="ops-section-head">
				<span class="ops-section-label">Payments</span>
			</div>
			<span class="ops-empty">admin only</span>
		</section>
	{/if}
</div>

<style>
	.ops-rail {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
		height: 100%;
		min-height: 0;
		padding: 0.6rem;
		overflow-y: auto;
	}

	.ops-rail-head {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		padding-bottom: 0.5rem;
		border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
	}

	.ops-role-badge {
		font-size: 0.62rem;
		font-family: 'Space Mono', monospace;
		text-transform: uppercase;
		letter-spacing: 0.12em;
		padding: 0.22rem 0.5rem;
		border-radius: 5px;
		font-weight: 700;
		background: rgba(52, 152, 219, 0.15);
		color: #64b5f6;
		border: 1px solid rgba(52, 152, 219, 0.3);
	}
	.ops-role-owner {
		background: rgba(244, 67, 54, 0.15);
		color: #ff8a80;
		border-color: rgba(244, 67, 54, 0.3);
	}
	.ops-role-admin {
		background: rgba(255, 193, 7, 0.15);
		color: #ffd54f;
		border-color: rgba(255, 193, 7, 0.3);
	}
	.ops-role-mod {
		background: rgba(156, 39, 176, 0.15);
		color: #ce93d8;
		border-color: rgba(156, 39, 176, 0.3);
	}

	.ops-head-copy {
		display: flex;
		flex-direction: column;
		line-height: 1.1;
	}
	.ops-head-title {
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--text-heading, #e0e0ff);
	}
	.ops-head-sub {
		font-size: 0.62rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-muted, #9999ff);
	}

	.ops-open-dashboard {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		width: 100%;
		padding: 0.5rem;
		border-radius: 9px;
		border: 1px solid var(--accent-primary, #6366f1);
		background: color-mix(in srgb, var(--accent-primary, #6366f1) 14%, transparent);
		color: var(--text-heading, #e0e0ff);
		font-size: 0.78rem;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.15s, transform 0.1s;
	}
	.ops-open-dashboard:hover {
		background: color-mix(in srgb, var(--accent-primary, #6366f1) 24%, transparent);
	}
	.ops-open-dashboard:active {
		transform: translateY(1px);
	}

	.ops-cards {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.45rem;
	}
	.ops-card {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		padding: 0.5rem 0.55rem;
		border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
		border-radius: 10px;
		background: var(--surface-raised, #1a1a2e);
	}
	.ops-card-label {
		font-size: 0.6rem;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--text-muted, #9999ff);
	}
	.ops-card-value {
		font-size: 0.92rem;
		font-weight: 700;
		color: var(--text-heading, #e0e0ff);
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
	.ops-card-value.ops-muted,
	.ops-muted {
		color: var(--text-muted, #9999ff);
		font-weight: 500;
	}
	.ops-card-unit {
		font-size: 0.66rem;
		color: var(--text-secondary, #b3b3ff);
		font-weight: 500;
	}
	.ops-channel-name {
		font-size: 0.8rem;
	}
	.ops-pulse-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: #4a9e5c;
		animation: ops-pulse 2.4s cubic-bezier(0.4, 0, 0.2, 1) infinite;
	}

	.ops-section {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 0.55rem;
		border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
		border-radius: 10px;
		background: var(--surface-base, #24243e);
	}
	.ops-section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.ops-section-label {
		font-size: 0.64rem;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--text-secondary, #b3b3ff);
	}
	.ops-section-count {
		font-size: 0.64rem;
		font-family: 'Space Mono', monospace;
		color: var(--text-muted, #9999ff);
		background: var(--surface-raised, #1a1a2e);
		border-radius: 999px;
		padding: 0.05rem 0.4rem;
	}
	.ops-empty {
		font-size: 0.68rem;
		color: var(--text-muted, #9999ff);
	}

	.ops-channel-list {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.ops-channel {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		width: 100%;
		padding: 0.32rem 0.45rem;
		border: none;
		border-radius: 7px;
		background: transparent;
		color: var(--text-secondary, #b3b3ff);
		font-size: 0.76rem;
		text-align: left;
		cursor: pointer;
		transition: background 0.12s, color 0.12s;
	}
	.ops-channel:hover {
		background: var(--surface-hover, #2a2a4a);
		color: var(--text-heading, #e0e0ff);
	}
	.ops-channel-active {
		background: color-mix(in srgb, var(--accent-primary, #6366f1) 16%, transparent);
		color: var(--text-heading, #e0e0ff);
	}
	.ops-channel-hash {
		color: var(--text-muted, #9999ff);
	}
	.ops-channel-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ops-staff-list {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.ops-staff {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.74rem;
		color: var(--text-secondary, #b3b3ff);
	}
	.ops-staff-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: #4a9e5c;
		flex: none;
	}
	.ops-staff-name {
		color: var(--text-heading, #e0e0ff);
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
	}
	.ops-staff-role {
		font-size: 0.58rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-muted, #9999ff);
	}
	.ops-staff-owner .ops-staff-role {
		color: #ff8a80;
	}
	.ops-staff-admin .ops-staff-role {
		color: #ffd54f;
	}
	.ops-staff-mod .ops-staff-role {
		color: #ce93d8;
	}

	.ops-payment-status {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.76rem;
		color: var(--text-secondary, #b3b3ff);
	}
	.ops-payment-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--text-disabled, #666);
	}
	.ops-payment-on .ops-payment-dot {
		background: #4a9e5c;
		box-shadow: 0 0 6px rgba(74, 158, 92, 0.6);
	}
	.ops-payment-on {
		color: var(--text-heading, #e0e0ff);
	}
	.ops-payment-tag {
		font-size: 0.58rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		padding: 0.08rem 0.35rem;
		border-radius: 999px;
		background: rgba(255, 193, 7, 0.15);
		color: #ffd54f;
		border: 1px solid rgba(255, 193, 7, 0.3);
	}

	@keyframes ops-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}
</style>
