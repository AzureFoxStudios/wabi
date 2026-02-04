<script lang="ts">
	import { users, currentUser, type User } from '$lib/socket';
	import UserPopout from './UserPopout.svelte';

	const dispatch = (event: string) => {};

	// User popout state
	let showUserPopout = false;
	let popoutUser: User | null = null;
	let popoutAnchorElement: HTMLElement | null = null;

	$: onlineUsers = $users.filter(u => u.id !== $currentUser?.id);

	function getStatusColor(status: string): string {
		switch (status) {
			case 'active': return 'var(--status-online)';
			case 'away': return 'var(--status-away)';
			case 'busy': return 'var(--status-busy)';
			default: return 'var(--status-offline)';
		}
	}

	function showUserPopoutHandler(user: User, anchorEl: HTMLElement) {
		popoutUser = user;
		popoutAnchorElement = anchorEl;
		showUserPopout = true;
	}
</script>

<aside class="right-panel">
	<header class="panel-header">
		<h2>Users Online</h2>
	</header>

	<div class="panel-content">
		{#if onlineUsers.length === 0}
			<div class="empty-state">
				<div class="empty-icon">👥</div>
				<p>No users online</p>
			</div>
		{:else}
			<div class="list">
				{#each onlineUsers as user (user.id)}
					<button
						class="list-item user-item"
						on:click={(e) => showUserPopoutHandler(user, e.currentTarget)}
					>
						<div class="avatar-wrapper">
							{#if user.profilePicture}
								<img src={user.profilePicture} alt={user.username} class="avatar" />
							{:else}
								<div class="avatar-placeholder" style="background-color: {user.color}">
									{user.username.charAt(0).toUpperCase()}
								</div>
							{/if}
							<span class="status-dot" style="background-color: {getStatusColor(user.status)}"></span>
						</div>
						<div class="item-info">
							<span class="item-name">{user.username}</span>
							<span class="item-status">{user.status}</span>
						</div>
					</button>
				{/each}
			</div>
		{/if}
	</div>

	<footer class="panel-footer" style="border-top: 1px solid var(--border-color);">
		<button class="profile-button">
			<div class="avatar-wrapper">
				{#if $currentUser?.profilePicture}
					<img src={$currentUser.profilePicture} alt={$currentUser?.username} class="avatar" />
				{:else}
					<div class="avatar-placeholder" style="background-color: {$currentUser?.color}">
						{$currentUser?.username.charAt(0).toUpperCase()}
					</div>
				{/if}
				<span class="status-dot status-dot-sm" style="background-color: {getStatusColor($currentUser?.status)}"></span>
			</div>
			<div class="footer-info">
				<span class="footer-name">{$currentUser?.username} <span class="you-badge">(you)</span></span>
				<span class="footer-status">{$currentUser?.status}</span>
			</div>
		</button>
	</footer>
</aside>

<UserPopout
	bind:isOpen={showUserPopout}
	bind:user={popoutUser}
	anchorElement={popoutAnchorElement}
	isOwnProfile={popoutUser?.id === $currentUser?.id}
	on:close={() => (showUserPopout = false)}
/>

<style>
	.right-panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--bg-primary);
		border-left: 1px solid var(--border-color);
		overflow: hidden;
	}

	.panel-header {
		padding: 1rem;
		border-bottom: 1px solid var(--border-color);
		background: var(--bg-secondary);
	}

	.panel-header h2 {
		margin: 0;
		font-size: var(--text-lg);
		font-weight: 600;
		color: var(--text-primary);
	}

	.panel-content {
		flex: 1;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 3rem 1.5rem;
		text-align: center;
		color: var(--text-secondary);
	}

	.empty-icon {
		font-size: 2.5rem;
		margin-bottom: 1rem;
		opacity: 0.5;
	}

	.empty-state p {
		margin: 0.25rem 0;
		font-size: var(--text-base);
	}

	.list {
		display: flex;
		flex-direction: column;
	}

	.list-item {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 1rem;
		border: none;
		background: none;
		color: inherit;
		cursor: pointer;
		transition: background 0.2s;
		border-bottom: 1px solid var(--border-color);
	}

	.list-item:hover {
		background: var(--bg-hover);
	}

	.avatar-wrapper {
		position: relative;
		flex-shrink: 0;
	}

	.avatar {
		width: 48px;
		height: 48px;
		border-radius: 50%;
		object-fit: cover;
	}

	.avatar-placeholder {
		width: 48px;
		height: 48px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 600;
		color: white;
		font-size: var(--text-lg);
	}

	.status-dot {
		position: absolute;
		bottom: 0;
		right: 0;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 3px solid var(--bg-primary);
	}

	.status-dot-sm {
		width: 12px;
		height: 12px;
		border-width: 2px;
	}

	.item-info {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}

	.item-name {
		font-size: var(--text-base);
		font-weight: 500;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.item-status {
		font-size: var(--text-sm);
		color: var(--text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		text-transform: capitalize;
	}

	.panel-footer {
		padding: 1rem;
		background: var(--bg-secondary);
	}

	.profile-button {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		padding: 0.5rem;
		border: none;
		background: none;
		color: inherit;
		cursor: pointer;
		border-radius: var(--radius-md);
		transition: background 0.2s;
	}

	.profile-button:hover {
		background: var(--bg-hover);
	}

	.footer-info {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}

	.footer-name {
		font-size: var(--text-base);
		font-weight: 500;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.you-badge {
		font-size: var(--text-xs);
		color: var(--text-secondary);
		font-weight: 400;
	}

	.footer-status {
		font-size: var(--text-sm);
		color: var(--text-secondary);
		text-transform: capitalize;
	}

	@media (max-width: 768px) {
		.right-panel {
			display: none;
		}
	}
</style>
