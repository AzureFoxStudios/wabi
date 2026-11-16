<!--
	New group (design contract §7.13, §8.10): a BaseModal md. Name field, the people you picked as
	removable tags, a search over registered members, and a footer with the count, a quiet Cancel
	and one primary "Create group". New groups start encryption-pending; the dialog says so in the
	exact words of §9.2.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { users, serverMembers, currentUser, createGroup } from '$lib/socket';
	import type { Channel, User } from '$lib/socket';
	import { buildDmDirectoryUsers, getDmDirectoryKey } from '$lib/dmUserDirectory';
	import { overlayStyle } from '$lib/overlayStyle';
	import { mediaUrl } from '$lib/mediaUrl';
	import { inkFor } from '$lib/theme/identity';
	import { _ } from '$lib/i18n';
	import BaseModal from './BaseModal.svelte';
	import ProfileMedia from './ProfileMedia.svelte';
	import Icon from './ui/Icon.svelte';
	import { presenceLabelKey, presenceOf, stampInitial } from './userPopoutModel';

	let { isOpen = $bindable(false), onCreated }: { isOpen?: boolean; onCreated?: (channel: Channel) => void } = $props();

	const uid = `cg-${Math.random().toString(36).slice(2, 8)}`;
	let searchQuery = $state('');
	let groupName = $state('');
	let selectedUsers = $state<User[]>([]);
	let pending = $state(false);
	let operationError = $state('');

	// Mirrors the popout `disableAllBanners` profile-visibility kill switch
	// (localStorage `wabi:profile:visibility` -> disableAll).
	let disableAllBanners = $state(false);

	onMount(() => {
		try {
			const raw = localStorage.getItem('wabi:profile:visibility');
			if (!raw) return;
			const v = JSON.parse(raw);
			if (typeof v.disableAll === 'boolean') disableAllBanners = v.disableAll;
		} catch {
			// ignore malformed local state
		}
	});

	let filteredUsers = $derived(buildDmDirectoryUsers({
		onlineUsers: $users,
		serverMembers: $serverMembers,
		currentUser: $currentUser,
		searchQuery
	}).filter((user) => /^user-[1-9][0-9]*$/.test(getDmDirectoryKey(user)) &&
		!selectedUsers.some((selected) => getDmDirectoryKey(selected) === getDmDirectoryKey(user))));

	const memberCount = $derived(selectedUsers.length + 1);
	const canCreate = $derived(!pending && groupName.trim().length > 0 && selectedUsers.length > 0);
	/** The footer line: what is still missing while Create group is disabled, else the count. */
	const footLine = $derived(
		pending
			? $_('cgm.waiting')
			: !groupName.trim() && selectedUsers.length === 0
				? $_('cgm.name_and_pick')
				: !groupName.trim()
					? $_('cgm.name_only')
					: selectedUsers.length === 0
						? $_('cgm.pick_one')
						: memberCount === 1 ? $_('cgm.foot_one', { values: { count: memberCount } }) : $_('cgm.foot_other', { values: { count: memberCount } })
	);

	/** The footer's hairline shows only while the body scrolls (§7.13). */
	let bodyScrolls = $state(false);
	function watchBodyScroll(node: HTMLElement) {
		const body = node.closest<HTMLElement>('.base-modal__body');
		if (!body || typeof ResizeObserver === 'undefined') return {};
		const measure = () => (bodyScrolls = body.scrollHeight > body.clientHeight + 1);
		const observer = new ResizeObserver(measure);
		observer.observe(body);
		observer.observe(node);
		measure();
		return { destroy: () => observer.disconnect() };
	}

	function toggleUser(user: User) {
		if (pending) return;
		const idx = selectedUsers.findIndex((selected) => getDmDirectoryKey(selected) === getDmDirectoryKey(user));
		if (idx >= 0) {
			selectedUsers = selectedUsers.filter((_, i) => i !== idx);
		} else {
			selectedUsers = [...selectedUsers, user];
		}
	}

	function removeSelected(user: User) {
		if (pending) return;
		selectedUsers = selectedUsers.filter((selected) => getDmDirectoryKey(selected) !== getDmDirectoryKey(user));
	}

	async function handleCreate() {
		if (!canCreate) return;
		const memberIds = selectedUsers.map((user) => getDmDirectoryKey(user));
		pending = true;
		operationError = '';
		try {
			const channel = await createGroup(groupName.trim(), memberIds);
			pending = false;
			closeModal();
			onCreated?.(channel);
		} catch (error) {
			console.warn('[group] create failed', error);
			operationError = $_('cgm.op_error');
		} finally { pending = false; }
	}

	function closeModal() {
		if (pending) return;
		isOpen = false;
		searchQuery = '';
		groupName = '';
		selectedUsers = [];
		operationError = '';
	}
</script>

<BaseModal {isOpen} onClose={closeModal} size="md" padded title={$_('dm.new_group')} initialFocus="#{uid}-name" panelClass="cg" closeOnScrim={!pending}>
	<form id="{uid}-form" class="cg-form" aria-busy={pending} use:watchBodyScroll onsubmit={(event) => { event.preventDefault(); void handleCreate(); }}>
		<div class="cg-field">
			<label class="w-label" for="{uid}-name">{$_('cgm.name_label')} <span class="cg-required">{$_('cgm.required')}</span></label>
			<input
				id="{uid}-name"
				class="w-field"
				type="text"
				bind:value={groupName}
				maxlength="64"
				autocomplete="off"
				required
				disabled={pending}
				aria-describedby="{uid}-privacy"
			/>
			<p class="cg-privacy" id="{uid}-privacy">
				<Icon name="hourglass" size={14} />
				{$_('cgm.privacy')}
			</p>
		</div>

		<div class="cg-field">
			<span class="w-label" id="{uid}-people">{$_('places.people')}</span>
			{#if selectedUsers.length > 0}
				<ul class="cg-chips" aria-labelledby="{uid}-people">
					{#each selectedUsers as user (getDmDirectoryKey(user))}
						<li class="w-tag cg-chip">
							<span>{user.username}</span>
							<button type="button" class="cg-chip__remove" disabled={pending} aria-label={$_('file_upload_preview.remove_file', { values: { name: user.username } })} onclick={() => removeSelected(user)}>
								<Icon name="x" size={12} />
							</button>
						</li>
					{/each}
				</ul>
			{/if}
			<div class="w-field w-field--chrome cg-search">
				<Icon name="search" size={16} />
				<input type="search" bind:value={searchQuery} placeholder={$_('cgm.search')} aria-label={$_('cgm.search')} disabled={pending} autocomplete="off" />
			</div>
		</div>

		{#if filteredUsers.length === 0}
			<div class="w-empty cg-empty">
				<Icon name="users" size={28} />
				<p class="w-empty__title">{searchQuery.trim() ? $_('ulist.empty_no_match') : selectedUsers.length ? $_('cgm.everyone_in') : $_('cgm.none_yet')}</p>
				<p class="w-empty__text">
					{searchQuery.trim()
						? $_('cgm.try_other')
						: selectedUsers.length
							? $_('cgm.all_in')
							: $_('cgm.appear_here')}
				</p>
			</div>
		{:else}
			<ul class="cg-list" aria-label={$_('payment_access.registered')}>
				{#each filteredUsers as user (getDmDirectoryKey(user))}
					{@const presence = presenceOf(user.status)}
					<li>
						<button type="button" class="cg-row" style={$inkFor(user.roleColor || user.color)} disabled={pending} aria-label={$_('cgm.add_user', { values: { name: user.username } })} onclick={() => toggleUser(user)}>
							<span class="cg-av" data-presence={presence}>
								{#if user.profilePicture}
									<ProfileMedia src={mediaUrl(user.profilePicture)} decorative class="cg-av__pic" />
								{:else}
									<span class="cg-av__stamp" aria-hidden="true">{stampInitial(user.username)}</span>
								{/if}
								{#if user.overlayUrl && !disableAllBanners}
									<span class="avatar-overlay-badge" style={overlayStyle(user)} aria-hidden="true"></span>
								{/if}
								<span class="cg-av__presence" aria-hidden="true"></span>
							</span>
							<span class="cg-text">
								<span class="cg-name">{user.username}</span>
								<span class="cg-sub">{user.handle ? `@${user.handle}` : $_(presenceLabelKey(presence))}</span>
							</span>
							<Icon name="plus" size={16} />
						</button>
					</li>
				{/each}
			</ul>
		{/if}

		{#if operationError}
			<div class="w-notice cg-notice" role="alert">
				<Icon name="alert" size={16} />
				<p class="w-notice__title">{operationError}</p>
			</div>
		{/if}
	</form>

	<div slot="footer" class="w-dialog__foot cg-foot" class:w-dialog__foot--rule={bodyScrolls}>
		<p class="w-dialog__foot-start cg-count" id="{uid}-foot" role="status">{footLine}</p>
		<div class="cg-foot__actions">
			<button type="button" class="w-btn w-btn--quiet" onclick={closeModal} disabled={pending}>{$_('common.cancel')}</button>
			<button type="submit" form="{uid}-form" class="w-btn w-btn--primary" aria-busy={pending} aria-describedby="{uid}-foot" disabled={!canCreate}>
				{pending ? $_('cch.creating') : $_('cgm.create')}
			</button>
		</div>
	</div>
</BaseModal>

<style>
	.cg-form {
		display: grid;
		gap: 20px;
	}
	.cg-field {
		min-width: 0;
	}
	.cg-privacy {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		margin: 8px 0 0;
		color: var(--w-mute);
		font: 400 calc(12px * var(--w-fs)) / calc(16px * var(--w-fs)) var(--w-sans);
		text-wrap: pretty;
	}
	.cg-privacy :global(svg) {
		flex: none;
		margin-top: 1px;
		color: var(--w-seal);
	}
	.cg-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin: 0 0 10px;
		padding: 0;
		list-style: none;
	}
	.cg-chip {
		gap: 4px;
		padding-right: 3px;
		color: var(--w-text);
	}
	.cg-chip__remove {
		display: grid;
		place-items: center;
		width: 18px;
		height: 18px;
		padding: 0;
		border: 0;
		border-radius: var(--w-pill);
		background: transparent;
		color: var(--w-mute);
		cursor: pointer;
	}
	.cg-chip__remove:hover {
		background: var(--w-raise);
		color: var(--w-text);
	}
	.cg-chip__remove:focus-visible {
		outline: 2px solid var(--w-accent);
		outline-offset: 0;
	}
	.cg-empty {
		padding: 16px 0 0;
	}
	.cg-list {
		display: grid;
		gap: 2px;
		margin: -12px -8px 0;
		padding: 0;
		list-style: none;
	}
	.cg-row {
		display: grid;
		grid-template-columns: 28px minmax(0, 1fr) auto;
		align-items: center;
		column-gap: 12px;
		box-sizing: border-box;
		width: 100%;
		min-height: 46px;
		padding: 0 8px;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--w-mute);
		font: var(--w-t-ui);
		text-align: left;
		cursor: pointer;
		transition: background-color var(--w-dur-1) var(--w-ease), color var(--w-dur-1) var(--w-ease);
	}
	.cg-row:hover:not(:disabled) {
		background: color-mix(in srgb, var(--w-raise) 70%, transparent);
		color: var(--w-text);
	}
	.cg-row:focus-visible {
		outline: 2px solid var(--w-accent);
		outline-offset: -2px;
	}
	.cg-row:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
	:global(:root[data-char='contrast']) .cg-row:hover:not(:disabled) {
		background: transparent;
		box-shadow: inset 0 0 0 1px var(--w-line-strong);
	}
	.cg-av {
		position: relative;
		display: block;
		width: 28px;
		height: 28px;
		border-radius: var(--w-avr);
	}
	.cg-av__stamp,
	.cg-av :global(.cg-av__pic) {
		display: grid;
		place-items: center;
		box-sizing: border-box;
		width: 28px;
		height: 28px;
		border-radius: var(--w-avr);
		object-fit: cover;
	}
	.cg-av__stamp {
		background: var(--disc, var(--w-raise));
		color: var(--on, var(--w-text));
		font: 600 calc(12px * var(--w-fs)) / 1 var(--w-serif);
	}
	.cg-av__presence {
		position: absolute;
		right: -2px;
		bottom: -2px;
		box-sizing: border-box;
		width: 10px;
		height: 10px;
		border-radius: var(--w-avr);
		background: var(--w-online);
		box-shadow: 0 0 0 2px var(--w-bg);
	}
	.cg-av[data-presence='away'] .cg-av__presence {
		background: var(--w-warn);
	}
	.cg-av[data-presence='busy'] .cg-av__presence {
		background: var(--w-danger);
	}
	.cg-av[data-presence='offline'] .cg-av__presence {
		background: var(--w-bg);
		box-shadow: inset 0 0 0 1.5px var(--w-faint), 0 0 0 2px var(--w-bg);
	}
	.cg-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.cg-name {
		overflow: hidden;
		color: var(--ink, var(--w-text));
		font: var(--w-t-label);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.cg-sub {
		overflow: hidden;
		color: var(--w-faint);
		font: var(--w-t-mono);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.cg-required {
		margin-left: 6px;
		color: var(--w-faint);
		font: var(--w-t-micro);
	}
	/* When the line and the buttons don't fit on one row (phones), the line takes its own row
	   whole instead of breaking mid-phrase. */
	.cg-foot {
		flex-wrap: wrap;
		row-gap: 8px;
	}
	/* Cancel and Create group stay together; the pair wraps below the line as one. */
	.cg-foot__actions {
		display: flex;
		flex: none;
		gap: 8px;
		margin-left: auto;
	}
	.cg-count {
		margin-top: 0;
		margin-bottom: 0;
		color: var(--w-faint);
		font: var(--w-t-small);
		white-space: nowrap;
	}
	@media (pointer: coarse) {
		.cg-row {
			min-height: 52px;
		}
		.cg-chip__remove {
			width: 32px;
			height: 32px;
		}
	}
</style>
