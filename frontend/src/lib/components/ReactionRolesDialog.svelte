<script lang="ts">
	import BaseModal from './BaseModal.svelte';
	import ReactionEmojiSelect from './emoji/ReactionEmojiSelect.svelte';
	import { _ } from '$lib/i18n';
	import { listedRoles, saveReactionRoles } from '$lib/serverRoles';
	import { reactionRoleMessages, reactionRulesProblem, type ReactionRoleRule } from '$lib/reactionRoles';
	import { showToast } from '$lib/toast';

	/** Staff: which emoji on this message give which role. */
	export let visible = false;
	export let messageId: string | null = null;
	export let channelId: string | null = null;
	export let onClose: () => void;

	let rules: ReactionRoleRule[] = [];
	let loadedFor: string | null = null;
	let busy = false;
	let error = '';

	// Only roles members may pick themselves can be given by a reaction.
	$: choices = $listedRoles.filter((role) => role.selfAssignable);
	$: if (visible && messageId && loadedFor !== messageId) {
		loadedFor = messageId;
		rules = ($reactionRoleMessages[messageId]?.rules ?? []).map((rule) => ({ ...rule }));
		error = '';
	}
	$: if (!visible) loadedFor = null;
	$: problem = reactionRulesProblem(rules);

	function addRow(): void {
		rules = [...rules, { emojiId: '', roleId: choices[0]?.id ?? '' }];
	}
	function removeRow(index: number): void {
		rules = rules.filter((_rule, at) => at !== index);
	}
	function setEmoji(index: number, emojiId: string): void {
		rules = rules.map((rule, at) => (at === index ? { ...rule, emojiId } : rule));
	}

	async function save(): Promise<void> {
		if (!messageId || !channelId || busy || problem) return;
		busy = true;
		error = '';
		try {
			await saveReactionRoles(messageId, channelId, rules);
			showToast($_(rules.length ? 'reaction_roles.saved' : 'reaction_roles.removed'), 'info');
			onClose();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : $_('reaction_roles.save_failed');
		} finally {
			busy = false;
		}
	}
</script>

<BaseModal isOpen={visible} {onClose} size="sm" title={$_('reaction_roles.title')} padded>
	<p class="rr-note">{$_('reaction_roles.description')}</p>
	{#if choices.length === 0}
		<p class="rr-note rr-note--warn" role="note">{$_('reaction_roles.no_roles')}</p>
	{:else}
		<ul class="rr-list">
			{#each rules as rule, index (index)}
				<li class="rr-row">
					<ReactionEmojiSelect value={rule.emojiId} disabled={busy} onchange={(id) => setEmoji(index, id)} />
					<select class="rr-role" bind:value={rule.roleId} disabled={busy} aria-label={$_('reaction_roles.role_label')}>
						{#each choices as role (role.id)}
							<option value={role.id}>{role.name}</option>
						{/each}
					</select>
					<button type="button" class="w-btn w-btn--quiet w-btn--sm" disabled={busy} on:click={() => removeRow(index)}>{$_('reaction_roles.remove_row')}</button>
				</li>
			{/each}
		</ul>
		<button type="button" class="w-btn w-btn--sm" disabled={busy || rules.length >= 20} on:click={addRow}>{$_('reaction_roles.add_row')}</button>
	{/if}
	{#if problem}
		<p class="rr-note rr-note--warn" role="note">{$_(problem === 'duplicate' ? 'reaction_roles.problem_duplicate' : 'reaction_roles.problem_incomplete')}</p>
	{/if}
	{#if error}
		<p class="rr-note rr-note--warn" role="alert">{error}</p>
	{/if}
	<div class="rr-actions">
		<button type="button" class="w-btn w-btn--quiet" disabled={busy} on:click={onClose}>{$_('common.cancel')}</button>
		<button type="button" class="w-btn w-btn--primary" disabled={busy || Boolean(problem)} on:click={() => void save()}>{$_('reaction_roles.save')}</button>
	</div>
</BaseModal>

<style>
	.rr-note {
		margin: 0 0 12px;
		color: var(--w-dim, inherit);
		font-size: 13px;
		line-height: 1.45;
	}
	.rr-note--warn {
		color: var(--w-ink, inherit);
		border-left: 2px solid var(--w-sig, currentColor);
		padding-left: 10px;
		margin-top: 12px;
	}
	.rr-list {
		list-style: none;
		margin: 0 0 12px;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.rr-row {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.rr-role {
		flex: 1;
		min-width: 120px;
		min-height: 36px;
	}
	.rr-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 16px;
	}
</style>
