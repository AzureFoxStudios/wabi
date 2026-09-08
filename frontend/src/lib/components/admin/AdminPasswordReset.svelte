<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import BaseModal from '../BaseModal.svelte';
	import { adminResetUserPassword } from '$lib/api';
	import { getAuthToken, authSessionGeneration, onAuthSessionCleared } from '$lib/authSession';
	import { activeServerUrl } from '$lib/serverUrl';
	import { currentUser, type User } from '$lib/socket';
	import { createAdminPasswordReset, type PasswordResetState } from '$lib/adminPasswordReset';

	let { user, canManageTargetUser, onClose }: {
		user: User;
		canManageTargetUser: (user: User) => boolean;
		onClose: () => void;
	} = $props();
	let password = $state('');
	let confirmation = $state('');
	let resetState = $state<PasswordResetState>({ pending: false, error: '', complete: false });
	const originServer = $activeServerUrl;
	const originActor = $currentUser?.dbUserId;
	// The dialog owns the target captured when opened, never a later row selection.
	const targetUserId = untrack(() => user.dbUserId ?? 0);
	const request = createAdminPasswordReset(targetUserId, {
		context: () => ({ server: $activeServerUrl, actorId: $currentUser?.dbUserId ?? null, generation: authSessionGeneration($activeServerUrl), token: getAuthToken($activeServerUrl), allowed: canManageTargetUser(user) }),
		reset: adminResetUserPassword,
		changed: (next) => { resetState = next; }
	});
	$effect(() => {
		if ($currentUser?.dbUserId !== originActor || !canManageTargetUser(user) || $activeServerUrl !== originServer) onClose();
	});
	onMount(() => onAuthSessionCleared((server) => {
		if (server !== originServer) return;
		request.dispose();
		password = '';
		confirmation = '';
		onClose();
	}));
	onDestroy(() => { request.dispose(); password = ''; confirmation = ''; });
	function close() { if (!resetState.pending) onClose(); }
	async function submit(event: SubmitEvent) {
		event.preventDefault();
		const outcome = request.submit(password, confirmation);
		if (resetState.pending) { password = ''; confirmation = ''; }
		await outcome;
	}
</script>

<BaseModal isOpen={true} onClose={close} showCloseButton={false} title={`Reset password for ${user.username}`} width="480px">
	<form class="password-reset-form" onsubmit={submit}>
		{#if resetState.complete}
			<p role="status" class="password-reset-success">Password reset for {user.username}. Their existing sessions will need to sign in again.</p>
			<p>Share the new password privately. They can change it in their profile settings.</p>
			<div class="password-reset-actions"><button type="button" class="reset-primary" onclick={close}>Done</button></div>
		{:else}
			<p>This replaces their current password and signs them out of existing sessions. Share the new password with them privately.</p>
			<label>New password<input type="password" name="admin-new-password" autocomplete="new-password" bind:value={password} disabled={resetState.pending} required minlength="8" /></label>
			<label>Confirm password<input type="password" name="admin-confirm-password" autocomplete="new-password" bind:value={confirmation} disabled={resetState.pending} required minlength="8" /></label>
			<p class="password-reset-hint">At least 8 characters. The new password stays valid until they change it.</p>
			{#if resetState.error}<p role="alert" class="password-reset-error">{resetState.error}</p>{/if}
			{#if resetState.pending}<p role="status">Resetting password…</p>{/if}
			<div class="password-reset-actions">
				<button type="button" onclick={close} disabled={resetState.pending}>Cancel</button>
				<button type="submit" class="reset-primary" disabled={resetState.pending}>{resetState.pending ? 'Resetting…' : 'Reset password'}</button>
			</div>
		{/if}
	</form>
</BaseModal>

<style>
	.password-reset-form { display: grid; gap: 1rem; padding: 0.75rem 1.5rem 1.5rem; }
	.password-reset-form p { margin: 0; color: var(--text-secondary); line-height: 1.6; overflow-wrap: anywhere; }
	.password-reset-form label { display: grid; gap: 0.5rem; color: var(--text-heading); font-size: 0.9rem; }
	.password-reset-form input { box-sizing: border-box; width: 100%; min-width: 0; min-height: 44px; padding: 0.65rem 0.75rem; border: 1px solid var(--border-default); border-radius: var(--radius-md); background: var(--surface-sunken); color: var(--text-primary); font: inherit; }
	.password-reset-hint { font-size: 0.8rem; }
	.password-reset-form .password-reset-error { color: var(--color-danger); }
	.password-reset-form .password-reset-success { color: var(--color-success); }
	.password-reset-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.75rem; margin-top: 0.25rem; }
	.password-reset-actions button { min-height: 44px; padding: 0.65rem 1rem; border: 1px solid var(--border-default); border-radius: var(--radius-md); background: var(--surface-raised); color: var(--text-primary); font: inherit; font-weight: 600; cursor: pointer; }
	.password-reset-actions .reset-primary { background: var(--accent-primary); color: var(--text-on-accent, white); border-color: var(--accent-primary); }
	.password-reset-actions button:not(:disabled):hover { background: var(--surface-hover); }
	.password-reset-actions .reset-primary:not(:disabled):hover { background: var(--accent-secondary); }
	.password-reset-actions button:disabled { opacity: 0.6; cursor: wait; }
	.password-reset-form :is(input, button):focus-visible { outline: 2px solid var(--accent-secondary); outline-offset: 2px; }
</style>
