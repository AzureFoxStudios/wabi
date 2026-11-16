<script lang="ts">
	import { _ } from '$lib/i18n';
	import BaseModal from '../BaseModal.svelte';
	import { getAuthToken } from '$lib/authSession';
	import {
		getLoreBinding,
		promoteLoreFromMessage,
		parseLoreChannelId,
		type LoreChannelBinding,
		type LorePromoteResponse
	} from '$lib/api/lore';
	import type { Message } from '$lib/socket';
	import { getMessageAttachmentActionItems } from '../message/messageAttachmentActions';
	import { rememberPromotes, fetchPromotesForMessage } from '$lib/lorePromoteCache';

	let {
		open = false,
		message = null,
		channelId = '',
		onClose
	}: {
		open?: boolean;
		message?: Message | null;
		channelId?: string;
		onClose: () => void;
	} = $props();

	let attachments = $state<{ fileUrl: string; fileName: string }[]>([]);
	let selectedUrl = $state('');
	let binding = $state<LoreChannelBinding | null>(null);
	let repoChannelId = $state<number | null>(null);
	let path = $state('');
	let branch = $state('main');
	let mode = $state<'binding' | 'direct' | 'stage'>('binding');
	let submitting = $state(false);
	let error = $state('');
	let collision = $state<LorePromoteResponse | null>(null);
	let result = $state<LorePromoteResponse | null>(null);
	let bindingMissing = $state(false);

	$effect(() => {
		if (open && message) {
			attachments = getMessageAttachmentActionItems(message).map((a) => ({
				fileUrl: a.fileUrl,
				fileName: a.fileName
			}));
			selectedUrl = attachments[0]?.fileUrl ?? '';
			result = null;
			collision = null;
			error = '';
			mode = 'binding';
			void loadBinding();
		}
	});

	async function loadBinding(): Promise<void> {
		binding = null;
		bindingMissing = false;
		repoChannelId = null;
		path = '/';
		branch = 'main';
		if (!message) return;
		const numeric = parseLoreChannelId(channelId);
		const token = getAuthToken();
		if (!numeric || !token) return;
		try {
			const b = await getLoreBinding(token, numeric);
			if (b) {
				binding = b;
				repoChannelId = b.repoChannelId;
				path = b.path;
				branch = b.branch;
			} else {
				bindingMissing = true;
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	let selectedName = $derived(
		attachments.find((a) => a.fileUrl === selectedUrl)?.fileName ?? ''
	);
	let targetPath = $derived(`${path.replace(/\/+$/, '')}/${selectedName}`);

	async function submit(collisionChoice?: 'overwrite'): Promise<void> {
		if (!message || !selectedUrl || submitting) return;
		submitting = true;
		error = '';
		collision = null;
		try {
			const token = getAuthToken();
			if (!token) throw new Error($_('lpm.not_signed_in'));
			const res = await promoteLoreFromMessage(token, {
				messageId: message.id,
				fileUrl: selectedUrl,
				repoChannelId: repoChannelId ?? undefined,
				path: path || undefined,
				branch: branch || undefined,
				mode: mode === 'binding' ? undefined : mode,
				collision: collisionChoice
			});
			if (res.collision) {
				collision = res;
				return;
			}
			result = res;
			// Keep the badge cache warm for this message.
			void fetchPromotesForMessage(message.id);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			submitting = false;
		}
	}

	function renamePath(): void {
		collision = null;
		// Leave path focused for manual edit; user adjusts and retries.
	}
</script>

<BaseModal isOpen={open} onClose={onClose} width="480px" showCloseButton={true}>
	<div slot="header" class="modal-header">
		<h3>{$_('lpm.title')}</h3>
		{#if binding}
			<p>{$_('lpm.binding', { values: { path: binding.path, branch: binding.branch, mode: binding.mode } })}</p>
		{:else if bindingMissing}
			<p>{$_('lpm.no_binding')}</p>
		{/if}
	</div>

	<div class="modal-body">
		{#if result}
			<div class="promote-result">
				{#if result.pendingReview}
					<p>📋 {$_('lpm.staged')} <code>{selectedName}</code> {$_('lpm.for_review_on')} <code>{result.reviewBranch}</code>.</p>
				{:else}
					<p>📦 {$_('lpm.committed')} <code>{selectedName}</code> → <code>{result.path}</code> ({$_('lpm.rev', { values: { hash: result.revision?.hash?.slice(0, 7) } })}).</p>
				{/if}
				<p class="field-hint">{$_('lpm.confirm_posted')}</p>
			</div>
		{:else}
			{#if attachments.length > 1}
				<label class="field">
					<span class="field-label">{$_('chat.compose.attachment')}</span>
					<select bind:value={selectedUrl}>
						{#each attachments as a (a.fileUrl)}
							<option value={a.fileUrl}>{a.fileName}</option>
						{/each}
					</select>
				</label>
			{/if}

			<label class="field">
				<span class="field-label">{$_('lpm.target_path')}</span>
				<input type="text" bind:value={path} placeholder="/art/concepts/" />
				<span class="field-hint">{targetPath}</span>
			</label>

			<label class="field">
				<span class="field-label">{$_('lpm.branch')}</span>
				<input type="text" bind:value={branch} />
			</label>

			<label class="field">
				<span class="field-label">{$_('server_policy.mode')}</span>
				<select bind:value={mode}>
					<option value="binding">{$_('lpm.use_binding', { values: { mode: binding?.mode ?? $_('payment_intent.na') } })}</option>
					<option value="direct">{$_('lpm.direct')}</option>
					<option value="stage">{$_('lpm.stage')}</option>
				</select>
			</label>

			{#if bindingMissing}
				<label class="field">
					<span class="field-label">{$_('lpm.repo_channel')}</span>
					<input type="number" bind:value={repoChannelId} placeholder="{$_('lpm.eg_42')}" />
				</label>
			{/if}

			{#if collision}
				<div class="collision-warning">
					<p>⚠️ {$_('lpm.exists')} <code>{collision.path}</code>.</p>
					<p class="field-hint">{$_('lpm.overwrite_hint')}</p>
				</div>
			{/if}

			{#if error}
				<div class="promote-error">{error}</div>
			{/if}
		{/if}
	</div>

	<div slot="footer" class="modal-footer">
		{#if result}
			<button class="btn-primary" onclick={onClose}>{$_('login.wizard.step_done')}</button>
		{:else if collision}
			<button class="btn-secondary" onclick={renamePath}>{$_('lpm.choose_path')}</button>
			<button class="btn-danger" disabled={submitting} onclick={() => submit('overwrite')}>
				{$_('lpm.overwrite')}
			</button>
		{:else}
			<button class="btn-secondary" onclick={onClose}>{$_('common.cancel')}</button>
			<button
				class="btn-primary"
				disabled={submitting || !selectedUrl || !path.startsWith('/')}
				onclick={() => submit()}
			>
				{submitting ? $_('lpm.promoting') : mode === 'stage' ? $_('lpm.stage') : $_('lpm.promote')}
			</button>
		{/if}
	</div>
</BaseModal>

<style>
	.modal-header p {
		margin: 4px 0 0;
		font-size: 0.85rem;
		opacity: 0.75;
	}
	.promote-result code,
	.collision-warning code {
		background: rgba(255, 255, 255, 0.08);
		padding: 1px 4px;
		border-radius: 3px;
	}
	.collision-warning {
		padding: 8px;
		border-radius: 6px;
		background: rgba(255, 180, 0, 0.12);
	}
	.promote-error {
		padding: 8px;
		border-radius: 6px;
		background: rgba(240, 70, 70, 0.15);
		color: #f28b82;
		font-size: 0.85rem;
	}
	.btn-danger {
		background: #d9534f;
		color: white;
		border: none;
		border-radius: 6px;
		padding: 8px 14px;
		cursor: pointer;
	}
</style>
