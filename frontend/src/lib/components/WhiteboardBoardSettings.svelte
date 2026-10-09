<script lang="ts">
	import { roleDefinitions } from '$lib/presenceStore';
	import BaseModal from './BaseModal.svelte';
	import { portal } from '$lib/actions/portal';
	import { get } from 'svelte/store';
	import { boardStore, policy } from '$lib/whiteboard/boardStore';
	import type { WhiteboardPolicy } from '$lib/whiteboard/boardTypes';

	export let open = false;
	export let onClose: () => void = () => {};

	let draftDrawRole: NonNullable<WhiteboardPolicy['drawRole']> = 'participants';
	let draftRoles: string[] = [];
	let roleSearch = '';
	const assignableBoardRoles = new Set(['owner', 'admin', 'developer', 'mod', 'artist', 'member']);
	$: availableRoles = $roleDefinitions.filter(role => assignableBoardRoles.has(role.roleName.toLowerCase()));
	$: filteredRoles = availableRoles.filter(role => `${role.displayName} ${role.roleName}`.toLowerCase().includes(roleSearch.toLowerCase()));
	let draftAccess: WhiteboardPolicy['access'] = 'open';
	let draftWriteAccess: WhiteboardPolicy['writeAccess'] = 'anyone';

	$: if (open) {
		const current = get(policy);
		draftRoles = [...(current?.drawRoles || [])];
		roleSearch = '';
		draftDrawRole = current?.drawRole || 'participants';
		draftAccess = current?.access || 'open';
		draftWriteAccess = current?.writeAccess || 'anyone';
	}

	function handleSave(): void {
		boardStore.setWhiteboardPolicy({ access: draftAccess, writeAccess: draftWriteAccess, drawRole: draftDrawRole, drawRoles: draftDrawRole === 'custom' ? draftRoles : [] });
		onClose();
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (open && event.key === 'Escape') {
			event.preventDefault();
			onClose();
		}
	}
</script>

<svelte:window on:keydown={handleKeydown} />

{#if open}
 <div use:portal={(document.fullscreenElement as HTMLElement) || document.body}>
 <BaseModal isOpen={open} title="Board settings" {onClose} width="440px" overlayZIndex={1700}>
 <div class="board-settings-body">
		<div class="wb-settings-section">
			<span class="wb-settings-label">Client preference for viewing</span>
			<div class="wb-settings-segmented" role="radiogroup" aria-label="Board access">
				<button
					type="button"
					class:active={draftAccess === 'open'}
					class="wb-settings-seg-btn"
					role="radio"
					aria-checked={draftAccess === 'open'}
					on:click={() => (draftAccess = 'open')}
				>
					Web and desktop
				</button>
				<button
					type="button"
					class:active={draftAccess === 'desktop_only'}
					class="wb-settings-seg-btn"
					role="radio"
					aria-checked={draftAccess === 'desktop_only'}
					on:click={() => (draftAccess = 'desktop_only')}
				>
					Desktop app only
				</button>
			</div>
			<span class="wb-settings-description">
				{draftAccess === 'open'
					? 'View and edit from web or desktop.'
					: 'Web clients show a desktop-app requirement. This is a client preference.'}
			</span>
		</div>

		<div class="wb-settings-section">
			<span class="wb-settings-label">Client preference for drawing</span>
			<div class="wb-settings-segmented" role="radiogroup" aria-label="Devices that can draw">
				<button
					type="button"
					class:active={draftWriteAccess === 'anyone'}
					class="wb-settings-seg-btn"
					role="radio"
					aria-checked={draftWriteAccess === 'anyone'}
					on:click={() => (draftWriteAccess = 'anyone')}
				>
					Web and desktop
				</button>
				<button
					type="button"
					class:active={draftWriteAccess === 'desktop'}
					class="wb-settings-seg-btn"
					role="radio"
					aria-checked={draftWriteAccess === 'desktop'}
					on:click={() => (draftWriteAccess = 'desktop')}
				>
					Desktop app only
				</button>
			</div>
			<span class="wb-settings-description">
				{draftWriteAccess === 'anyone'
					? 'Web and desktop users can draw.'
					: 'Web clients become view-only. Drawing permissions still apply to desktop users.'}
			</span>
		</div>

		<div class="wb-settings-section"><label class="wb-settings-label" for="board-draw-role">Who can draw <span tabindex="0" class="policy-help" aria-label="About drawing permissions" title="Channel permissions control who can open this board. Drawing is checked against current server roles. Only the server owner can change this policy. Device preferences are not a security boundary.">ⓘ</span></label><select id="board-draw-role" bind:value={draftDrawRole}><option value="participants">Everyone with channel access</option><option value="moderators">Moderators, admins and owner</option><option value="admins">Admins and owner</option><option value="owner">Owner only</option><option value="custom">Selected roles</option></select><p class="wb-settings-description">Everyone with channel access can view. Drawing uses each person's current server role.</p></div>
        {#if draftDrawRole === 'custom'}
         <div class="custom-roles">
          <input type="search" aria-label="Search drawing roles" placeholder="Search server roles" bind:value={roleSearch} />
          <div class="role-inventory">
           {#each filteredRoles as role (role.roleName)}<label><input type="checkbox" checked={draftRoles.includes(role.roleName)} on:change={(event) => { draftRoles = event.currentTarget.checked ? [...new Set([...draftRoles,role.roleName])] : draftRoles.filter(name => name !== role.roleName); }} />{role.displayName}</label>{/each}
           {#if !filteredRoles.length}<p>No matching assignable roles.</p>{/if}
          </div>
          {#each draftRoles.filter(name => !availableRoles.some(role => role.roleName.toLowerCase() === name.toLowerCase())) as name}<label><input type="checkbox" checked on:change={() => draftRoles = draftRoles.filter(role => role !== name)} />{name} · unavailable role</label>{/each}
          <p>{draftRoles.length} selected · roles follow each member’s current server assignment. The owner can always manage this board.</p>
          {#if !$roleDefinitions.length}<p class="role-help">No server roles have been received on this connection. Reconnect, then reopen these settings.</p>{/if}
         </div>
        {/if}
		<div class="wb-settings-actions">
			<button type="button" class="wb-settings-save" disabled={draftDrawRole === 'custom' && draftRoles.length === 0} on:click={handleSave}>Save</button>
			<button type="button" class="wb-settings-cancel" on:click={onClose}>Cancel</button>
		</div>
	</div></BaseModal></div>
{/if}

<style>
 .custom-roles { display: flex; flex-direction: column; gap: 8px; font-size: 12px; }
 .custom-roles input[type="search"] { background: var(--bg-secondary); color: var(--text-heading); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 8px; }
 .role-inventory { max-height: 150px; overflow: auto; display: flex; flex-direction: column; gap: 8px; }
 .custom-roles label { display: flex; gap: 8px; align-items: center; }
	.wb-settings-backdrop {
		position: absolute;
		inset: 0;
		z-index: 39;
		background: rgba(var(--surface-app-rgb, 15, 23, 42), 0.32);
		backdrop-filter: blur(2px);
	}

	.wb-settings-popover {
		position: absolute;
		top: 4.3rem;
		right: 0.9rem;
		z-index: 40;
		width: min(360px, calc(100% - 1.8rem));
		padding: var(--space-4);
		border-radius: var(--radius-lg, 12px);
		background: color-mix(in srgb, var(--surface-raised, #302b63) 82%, transparent);
		border: 1px solid color-mix(in srgb, var(--text-muted, #9999ff) 22%, transparent);
		backdrop-filter: blur(14px);
		box-shadow: 0 18px 40px rgba(var(--surface-app-rgb, 15, 23, 42), 0.28);
		animation: wb-settings-pop 0.16s ease-out;
	}

	@keyframes wb-settings-pop {
		from {
			opacity: 0;
			transform: translateY(-6px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.wb-settings-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		margin-bottom: var(--space-3);
	}

	.wb-settings-title {
		margin: 0;
		font-size: var(--font-size-base, 0.875rem);
		font-weight: var(--font-weight-bold, 700);
		color: var(--text-heading, #e0e0ff);
	}

	.wb-settings-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		padding: 0;
		border: 0;
		border-radius: var(--radius-sm, 4px);
		background: transparent;
		color: var(--text-muted, #9999ff);
		cursor: pointer;
		transition: background 0.14s ease, color 0.14s ease;
	}

	.wb-settings-close:hover {
		background: color-mix(in srgb, var(--text-muted, #9999ff) 14%, transparent);
		color: var(--text-heading, #e0e0ff);
	}

	.wb-settings-close svg {
		width: 14px;
		height: 14px;
	}

	.wb-settings-section {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		padding: var(--space-3) 0;
	}

	.wb-settings-section + .wb-settings-section {
		border-top: 1px solid color-mix(in srgb, var(--text-muted, #9999ff) 16%, transparent);
	}

	.wb-settings-label {
		font-size: var(--font-size-sm, 0.8125rem);
		font-weight: 650;
		color: var(--text-heading, #e0e0ff);
	}

	.wb-settings-segmented {
		display: flex;
		flex-wrap: wrap;
		gap: 0;
		border: var(--w-bw, 1px) solid var(--w-line-strong, var(--border-default));
		border-radius: calc(10px * var(--w-rs, 1));
		overflow: hidden;
		background: var(--w-bg2, var(--surface-base));
	}

	.wb-settings-seg-btn {
		flex: 1 1 auto;
		min-width: 0;
		padding: 0.4rem 0.6rem;
		border: 0;
		border-radius: 0;
		background: transparent;
		color: var(--w-mute, var(--text-secondary, #b3b3ff));
		font-size: var(--font-size-sm, 0.8125rem);
		font-weight: 600;
		cursor: pointer;
		transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
	}

	.wb-settings-seg-btn + .wb-settings-seg-btn {
		border-left: var(--w-bw, 1px) solid var(--w-line, transparent);
	}

	.wb-settings-seg-btn:hover {
		color: var(--w-text, var(--text-heading, #e0e0ff));
	}

	.wb-settings-seg-btn.active {
		background: var(--w-accent, var(--accent-primary, #6366f1));
		color: var(--w-on-accent, #fff);
	}

	.wb-settings-description {
		font-size: var(--font-size-xs, 0.6875rem);
		line-height: 1.4;
		color: var(--text-muted, #9999ff);
	}

	.wb-settings-note {
		margin: var(--space-1) 0 var(--space-3);
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-sm, 4px);
		background: color-mix(in srgb, var(--accent-primary, #6366f1) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--accent-primary, #6366f1) 22%, transparent);
		font-size: var(--font-size-xs, 0.6875rem);
		color: var(--text-secondary, #b3b3ff);
	}

	.wb-settings-actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
	}

	.wb-settings-save,
	.wb-settings-cancel {
		padding: 0.42rem 0.95rem;
		border-radius: calc(10px * var(--w-rs, 1));
		font-size: var(--font-size-sm, 0.8125rem);
		font-weight: 700;
		cursor: pointer;
		transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
	}

	.wb-settings-save {
		border: 0;
		background: var(--w-text, var(--accent-primary, #6366f1));
		color: var(--w-bg, var(--text-heading, #e0e0ff));
	}

	.wb-settings-save:hover {
		background: color-mix(in srgb, var(--w-text, var(--accent-primary)) 88%, var(--w-accent, var(--accent-primary)));
	}

	.wb-settings-cancel {
		border: var(--w-bw, 1px) solid var(--w-line-strong, var(--border-default));
		background: transparent;
		color: var(--w-text, var(--text-secondary, #b3b3ff));
	}

	.wb-settings-cancel:hover {
		background: var(--w-raise, color-mix(in srgb, var(--text-muted, #9999ff) 12%, transparent));
		border-color: var(--w-accent, var(--border-default));
	}

	@media (prefers-reduced-motion: reduce) {
		.wb-settings-popover {
			animation: none;
		}
	}

 .board-settings-body { padding: 0 20px 20px; }

 select { width:100%; min-height:40px; padding:8px; color:var(--w-text, var(--text-primary)); background:var(--w-sink, var(--bg-primary)); border:var(--w-bw, 1px) solid var(--w-line-strong, var(--border-subtle)); border-radius:calc(10px * var(--w-rs, 1)); }
</style>
