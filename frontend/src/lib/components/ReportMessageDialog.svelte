<!--
	Report a message to this server's staff (design contract §7.13 dialog, §9 truth words). The kit
	dialog (BaseModal sm): the message as a quoted snapshot, what is wrong, an optional note, then
	what sending keeps and who sees it, in the server's own words. Moderation is the seal's subject,
	so the evidence line carries the seal glyph. A failure is one notice in the dialog with its own
	sentence (the server's raw error goes to the console, never on screen).
-->
<script lang="ts">
	import { _ } from '$lib/i18n';
	import type { Message } from '$lib/socket';
	import { activeServerUrl } from '$lib/serverUrl';
	import { currentChannel } from '$lib/channelStore';
	import { getAuthToken } from '$lib/authSession';
	import BaseModal from './BaseModal.svelte';
	import Icon from './ui/Icon.svelte';
	import Notice from './ui/Notice.svelte';
	import { disclosedText, planReportRequest, reportRequiresDisclosure } from './reportMessageRequest';
	import { E2EE_MESSAGE_PREFIX } from '$lib/e2eeEnvelope';

	export let visible = false;
	export let message: Message | null = null;
	/** The room the message was shown in; falls back to the app's current channel. */
	export let channelId = '';
	export let onClose: () => void = () => {};

	type Failure = { title: string; text: string; cause?: unknown };

	let reason = 'Server rule violation';
	let comment = '';
	let busy = false;
	let failure: Failure | null = null;
	let sent = false;
	const reasons = ['Spam', 'Harassment', 'Hate / abusive behavior', 'Sexual content', 'Threats / dangerous behavior', 'Server rule violation', 'Something else'];
		const reasonLabels: Record<string, string> = {
			'Spam': $_('report.reason_spam'),
			'Harassment': $_('report.reason_harassment'),
			'Hate / abusive behavior': $_('report.reason_hate'),
			'Sexual content': $_('report.reason_sexual'),
			'Threats / dangerous behavior': $_('report.reason_threats'),
			'Server rule violation': $_('report.reason_rule'),
			'Something else': $_('report.reason_other')
		};

	// Experimental encryption: the server holds only ciphertext, so a report carries the decrypted
	// text only when the reporter explicitly agrees to disclose it (reportMessageRequest.ts).
	let discloseConfirmed = false;
	$: disclosureNeeded = reportRequiresDisclosure(message);
	$: unreadable = disclosureNeeded && (Boolean(message?.e2eeUnreadable) || String(message?.text ?? '').startsWith(E2EE_MESSAGE_PREFIX));
	$: disclosure = disclosedText(String(message?.text ?? ''));
	$: nothingToDisclose = disclosureNeeded && !unreadable && !disclosure.text;
	$: canSend = !disclosureNeeded || (discloseConfirmed && !unreadable && !nothingToDisclose);

	$: if (!visible) { failure = null; sent = false; comment = ''; reason = 'Server rule violation'; discloseConfirmed = false; }
	let disclosureMessageId = '';
	$: if ((message?.id ?? '') !== disclosureMessageId) {
		disclosureMessageId = message?.id ?? '';
		discloseConfirmed = false;
	}

	async function submit() {
		if (!message || busy || !canSend) return;
		const plan = planReportRequest({
			channelId: channelId || $currentChannel,
			message,
			reason,
			comment,
			disclosureConfirmed: discloseConfirmed
		});
		if (plan.kind !== 'send') return;
		busy = true; failure = null;
		try {
			const token = getAuthToken($activeServerUrl);
			if (!token) {
				failure = { title: $_('report.sign_in_again'), text: $_('report.session_ended') };
				return;
			}
			const response = await fetch(`${$activeServerUrl}/api/server-center/reports`, {
				method: 'POST', credentials: 'include', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify(plan.body)
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				failure = { title: $_('report.not_sent'), text: $_('report.server_rejected'), cause: { status: response.status, error: data?.error } };
				return;
			}
			sent = true;
		} catch (cause) {
			failure = { title: $_('report.not_sent'), text: $_('report.unreachable'), cause };
		} finally {
			busy = false;
		}
	}
</script>

<BaseModal
	isOpen={visible && Boolean(message)}
	{onClose}
	size="sm"
	padded
	title={sent ? $_('report.title_sent') : $_('report.title')}
	note={sent ? '' : $_('report.note')}
	closeOnScrim={!busy}
	initialFocus={sent ? null : '#report-reason'}
	panelClass="report"
>
	{#if message}
		{#if sent}
			<div class="report-done" role="status">
				<p class="report-done__lead"><Icon name="check" size={18} />{$_('report.done_lead')}</p>
				<p class="report-quiet">{$_('report.done_quiet')}</p>
			</div>
		{:else}
			<div class="report-form">
				<blockquote class="report-snapshot">
					<span class="report-snapshot__author">@{message.user}</span>
					<p class="report-snapshot__text">{message.text || $_('report.no_text')}</p>
				</blockquote>
				<div class="report-field">
					<label class="w-label" for="report-reason">{$_('report.what_wrong')}</label>
					<span class="w-field"><select id="report-reason" bind:value={reason} disabled={busy}>{#each reasons as item}<option value={item}>{reasonLabels[item]}</option>{/each}</select></span>
				</div>
				<div class="report-field">
					<label class="w-label" for="report-comment">{$_('report.anything_else')} <span class="report-optional">{$_('payment_sheet.optional')}</span></label>
					<textarea id="report-comment" class="w-field report-comment" bind:value={comment} maxlength="1000" rows="4" disabled={busy} placeholder={$_('report.comment_placeholder')}></textarea>
				</div>
				{#if disclosureNeeded}
					<section class="report-evidence" aria-labelledby="report-evidence-title">
						<p class="report-evidence__title" id="report-evidence-title"><Icon name="flag" size={16} />{$_('report.disclose_title')}</p>
						{#if unreadable}
							<p>{$_('report.unreadable')}</p>
						{:else if nothingToDisclose}
							<p>{$_('report.nothing_to_disclose')}</p>
						{:else}
							<p>{$_('report.disclose_body')}</p>
							{#if disclosure.truncated}
								<p>{$_('report.truncated')}</p>
							{/if}
							<p class="report-quiet">{$_('report.disclose_quiet')}</p>
							<label class="report-disclose">
								<input type="checkbox" class="w-check" bind:checked={discloseConfirmed} disabled={busy} />
								<span>{$_('report.disclose_checkbox')}</span>
							</label>
						{/if}
					</section>
				{:else}
					<section class="report-evidence" aria-labelledby="report-evidence-title">
						<p class="report-evidence__title" id="report-evidence-title"><Icon name="flag" size={16} />{$_('report.preserve_title')}</p>
						<p>{$_('report.preserve_body')}</p>
						<p class="report-quiet">{$_('report.preserve_quiet')}</p>
					</section>
				{/if}
				{#if failure}<Notice title={failure.title} text={failure.text} error={failure.cause} />{/if}
			</div>
		{/if}
	{/if}
	<div slot="footer" class="w-dialog__foot">
		{#if sent}
			<button type="button" class="w-btn w-btn--primary" on:click={onClose}>{$_('login.wizard.step_done')}</button>
		{:else}
			<button type="button" class="w-btn w-btn--quiet" on:click={onClose} disabled={busy}>{$_('common.cancel')}</button>
			<button type="button" class="w-btn w-btn--primary" on:click={submit} disabled={busy || !canSend} aria-busy={busy}>{busy ? $_('messages.sending') : disclosureNeeded ? $_('report.disclose_send') : $_('report.preserve_send')}</button>
		{/if}
	</div>
</BaseModal>

<style>
	.report-form {
		display: grid;
		gap: 16px;
	}
	/* The reported message, quoted as it will be kept: a hairline on the start edge, never a card. */
	.report-snapshot {
		margin: 0;
		padding: 2px 0 2px 12px;
		border-inline-start: 2px solid var(--w-line-strong);
	}
	.report-snapshot__author {
		color: var(--w-text);
		font: 500 calc(14px * var(--w-fs)) / calc(20px * var(--w-fs)) var(--w-sans);
	}
	.report-snapshot__text {
		max-height: 132px;
		margin: 2px 0 0;
		overflow: auto;
		color: var(--w-mute);
		font: var(--w-t-ui);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.report-field {
		display: grid;
		gap: 6px;
	}
	.report-optional {
		margin-inline-start: 6px;
		color: var(--w-faint);
		font: var(--w-t-small);
	}
	.report-comment {
		height: auto;
		min-height: 96px;
		padding: 8px 10px;
		resize: vertical;
	}
	.report-evidence {
		display: grid;
		gap: 6px;
		padding-top: 14px;
		border-top: var(--w-bw) solid var(--w-line);
	}
	.report-evidence p {
		margin: 0;
		color: var(--w-text);
		font: var(--w-t-small);
	}
	.report-evidence .report-evidence__title {
		display: flex;
		align-items: center;
		gap: 8px;
		font: 500 calc(14px * var(--w-fs)) / calc(20px * var(--w-fs)) var(--w-sans);
	}
	/* Moderation is the seal's subject: the glyph is the seal, the words stay ink. */
	.report-evidence__title :global(svg) {
		flex: none;
		color: var(--w-seal);
	}
	.report-quiet {
		color: var(--w-mute);
	}
	.report-disclose {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		color: var(--w-text);
		font: var(--w-t-small);
		cursor: pointer;
	}
	.report-disclose input {
		flex: none;
		margin-top: 2px;
	}
	.report-evidence .report-quiet {
		color: var(--w-mute);
	}
	.report-done {
		display: grid;
		gap: 6px;
	}
	.report-done p {
		margin: 0;
		font: var(--w-t-ui);
	}
	.report-done__lead {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		color: var(--w-text);
	}
	.report-done__lead :global(svg) {
		flex: none;
		margin-top: 1px;
		color: var(--w-ok);
	}
</style>
