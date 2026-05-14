<script lang="ts">
	import { onMount } from 'svelte';
	import { authStore } from '$lib/authStore';
	import type { AuthError } from '$lib/authStore';

	let error: AuthError | null = null;
	let showBanner = false;

	onMount(() => {
		const unsubscribe = authStore.subscribe(state => {
			error = state.error;
			showBanner = state.isAuthError;

			// Auto-dismiss after 8 seconds
			if (showBanner) {
				const timeout = setTimeout(() => {
					authStore.clearAuthError();
				}, 8000);
				return () => clearTimeout(timeout);
			}
		});

		return unsubscribe;
	});

	function handleDismiss() {
		authStore.clearAuthError();
	}
</script>

{#if showBanner && error}
	<div class="auth-error-banner" class:session-expired={error.type === 'session_expired'}>
		<div class="banner-content">
			<div class="banner-icon">
				{#if error.type === 'session_expired' || error.type === 'invalid_token'}
					⚠️
				{:else if error.type === 'connection_lost'}
					🌐
				{:else}
					❌
				{/if}
			</div>
			<div class="banner-text">
				<div class="banner-title">
					{#if error.type === 'session_expired' || error.type === 'invalid_token'}
						Session Expired
					{:else if error.type === 'connection_lost'}
						Connection Lost
					{:else}
						Authentication Error
					{/if}
				</div>
				<div class="banner-message">{error.message}</div>
			</div>
			<button class="banner-close" on:click={handleDismiss}>✕</button>
		</div>
	</div>
{/if}

<style>
	.auth-error-banner {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		z-index: 9000;
		background: linear-gradient(135deg, rgba(var(--color-danger-rgb, 239, 68, 68), 0.95), rgba(var(--color-danger-rgb, 220, 38, 38), 0.95));
		border-bottom: 2px solid rgba(var(--color-danger-rgb, 239, 68, 68), 1);
		backdrop-filter: blur(8px);
		animation: slideDown 0.3s ease-out;
	}

	.auth-error-banner.session-expired {
		background: linear-gradient(135deg, rgba(217, 119, 6, 0.95), rgba(180, 83, 9, 0.95));
		border-bottom-color: var(--color-warning, rgba(251, 146, 60, 1));
	}

	@keyframes slideDown {
		from {
			transform: translateY(-100%);
		}
		to {
			transform: translateY(0);
		}
	}

	.banner-content {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 20px;
		max-width: 1200px;
		margin: 0 auto;
	}

	.banner-icon {
		font-size: 1.5rem;
		flex-shrink: 0;
	}

	.banner-text {
		flex: 1;
		min-width: 0;
	}

	.banner-title {
		font-weight: 600;
		color: white;
		font-size: 0.9rem;
		margin-bottom: 2px;
	}

	.banner-message {
		color: rgba(var(--text-inverse-rgb, 255, 255, 255), 0.9);
		font-size: 0.85rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.banner-close {
		background: none;
		border: none;
		color: white;
		font-size: 1.2rem;
		cursor: pointer;
		padding: 4px 8px;
		flex-shrink: 0;
		opacity: 0.8;
		transition: opacity 0.2s;
	}

	.banner-close:hover {
		opacity: 1;
	}
</style>
