<script lang="ts">
	import { _ } from '$lib/i18n';
	import { onMount } from 'svelte';
	import { activeServerUrl } from '$lib/serverUrl';
	import { getAuthToken } from '$lib/authSession';
	import { currentUser } from '$lib/socket';

	type ReportStatus = 'open' | 'reviewing' | 'resolved' | 'dismissed';
	type StaffComment = { id: string; authorUserId: number; authorUsername: string; body: string; createdAt: string };
	type CaseActionKind = 'server_ban' | 'channel_ban' | 'channel_timeout' | 'lift_server_ban' | 'lift_channel_ban' | 'lift_channel_timeout';
	type CaseAction = { id: string; kind: CaseActionKind; actorUsername: string; targetUserId: number; reason: string; createdAt: string; expiresAt: string | null; outcome: string };
	type Report = {
		id: string; source: string; channelId: string; messageId: string; messageSnapshot: string;
		messageWasDeleted: boolean; evidenceDeletedAt?: string | null; evidenceExpiresAt?: string | null; authorUserId: number; authorUsername: string;
		reporterUserId: number; reporterUsername: string; reason: string; comment: string | null;
		createdAt: string; status: ReportStatus; assignedToUserId: number | null; assignedToUsername: string | null;
		resolution: string | null; staffComments: StaffComment[]; actions?: CaseAction[];
	};

	let reports: Report[] = $state([]);
	let loading = $state(true);
	let error = $state('');
	let busy = $state<string | null>(null);
	let commentDrafts: Record<string, string> = $state({});
	let expanded: Record<string, boolean> = $state({});
	let actionOpen: Record<string, boolean> = $state({});
	let actionKind: Record<string, CaseActionKind> = $state({});
	let actionReason: Record<string, string> = $state({});
	let actionMinutes: Record<string, number> = $state({});
	let confirmRedaction: Record<string, boolean> = $state({});
	const canRemoveEvidence = $derived($currentUser?.highestRole?.toLowerCase() === 'owner');

	const openCount = $derived(reports.filter(r => r.status === 'open').length);
	const reviewingCount = $derived(reports.filter(r => r.status === 'reviewing').length);
	const closedCount = $derived(reports.filter(r => r.status === 'resolved' || r.status === 'dismissed').length);

	function token(): string | null { return getAuthToken($activeServerUrl); }
	async function request(path: string, init: RequestInit = {}) {
		const auth = token();
		if (!auth) throw new Error($_('mod.sign_in_again'));
		const response = await fetch(`${$activeServerUrl}/api/server-center${path}`, {
			...init,
			headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
			credentials: 'include'
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(data.error || $_('mod.request_failed', { values: { status: response.status } }));
		return data;
	}

	async function refresh() {
		loading = true; error = '';
		try { reports = (await request('/reports')).reports ?? []; }
		catch (cause) { error = cause instanceof Error ? cause.message : $_('mod.load_failed'); }
		finally { loading = false; }
	}

	async function setStatus(report: Report, status: ReportStatus, assignToMe = false) {
		busy = report.id; error = '';
		try {
			const data = await request(`/reports/${encodeURIComponent(report.id)}/status`, {
				method: 'PUT', body: JSON.stringify({ status, assignToMe })
			});
			reports = reports.map(item => item.id === report.id ? data.report : item);
		} catch (cause) { error = cause instanceof Error ? cause.message : $_('mod.update_failed'); }
		finally { busy = null; }
	}

	async function addComment(report: Report) {
		const body = (commentDrafts[report.id] ?? '').trim();
		if (!body) return;
		busy = report.id; error = '';
		try {
			await request(`/reports/${encodeURIComponent(report.id)}/comment`, { method: 'POST', body: JSON.stringify({ body }) });
			commentDrafts[report.id] = '';
			await refresh();
			expanded[report.id] = true;
		} catch (cause) { error = cause instanceof Error ? cause.message : $_('mod.comment_failed'); }
		finally { busy = null; }
	}

	async function applyAction(report: Report) {
		const kind = actionKind[report.id] ?? 'channel_timeout';
		busy = report.id; error = '';
		try {
			await request(`/reports/${encodeURIComponent(report.id)}/action`, {
				method: 'POST',
				body: JSON.stringify({ kind, reason: (actionReason[report.id] ?? '').trim() || report.reason, minutes: actionMinutes[report.id] ?? 10 })
			});
			actionOpen[report.id] = false;
			await refresh();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : $_('mod.action_failed');
			await refresh();
		} finally { busy = null; }
	}

	async function removeEvidence(report: Report) {
		busy = report.id; error = '';
		try {
			await request(`/reports/${encodeURIComponent(report.id)}/evidence`, { method: 'DELETE' });
			confirmRedaction[report.id] = false;
			await refresh();
		} catch (cause) { error = cause instanceof Error ? cause.message : $_('mod.remove_snapshot_failed'); }
		finally { busy = null; }
	}

	function actionLabel(kind: CaseActionKind): string {
		return ({ server_ban: $_('mod.action_server_ban'), channel_ban: $_('mod.action_channel_ban'), channel_timeout: $_('mod.action_channel_timeout'),
			lift_server_ban: $_('mod.action_lift_server_ban'), lift_channel_ban: $_('mod.action_lift_channel_ban'), lift_channel_timeout: $_('mod.action_lift_channel_timeout') })[kind];
	}

	function when(value: string) {
		const time = Date.parse(value);
		return Number.isFinite(time) ? new Date(time).toLocaleString() : value;
	}

	onMount(() => { void refresh(); });
</script>

<div class="mod-center">
	<section class="hero">
		<div><span class="eyebrow">{$_('mod.inbox')}</span><h2>{$_('mod.heading')}</h2><p>{$_('mod.hero_desc')}</p></div>
		<button class="refresh" onclick={refresh} disabled={loading}>{loading ? $_('mod.refreshing') : $_('yt.refresh')}</button>
	</section>

	<div class="summary" aria-label={$_('mod.summary_label')}>
		<div><strong>{openCount}</strong><span>{$_('mod.needs_review')}</span></div>
		<div><strong>{reviewingCount}</strong><span>{$_('mod.being_handled')}</span></div>
		<div><strong>{closedCount}</strong><span>{$_('login.wizard.join_closed_label')}</span></div>
	</div>

	{#if error}<div class="error" role="alert">{error}</div>{/if}
	{#if !loading && reports.length === 0}
		<section class="empty"><strong>{$_('mod.queue_clear')}</strong><span>{$_('mod.queue_clear_desc')}</span></section>
	{/if}

	<div class="queue">
		{#each reports as report (report.id)}
			<article class:closed={report.status === 'resolved' || report.status === 'dismissed'}>
				<header>
					<div class="report-title"><span class="status {report.status}">{$_('mod.status_' + report.status)}</span><strong>{report.reason}</strong><span>#{report.channelId}</span></div>
					<time>{when(report.createdAt)}</time>
				</header>
				<div class="people"><span>{report.source === 'safety_flag' ? $_('mod.flagged_message') : $_('mod.reported_message')} {$_('mod.by_author')} <strong>@{report.authorUsername}</strong></span><span>{report.source === 'safety_flag' ? $_('mod.safety_rule') : $_('mod.reported_by', { values: { name: report.reporterUsername } })}</span>{#if report.assignedToUsername}<span>{$_('mod.assigned_to', { values: { name: report.assignedToUsername } })}</span>{/if}</div>
				<blockquote>{report.evidenceDeletedAt ? $_('mod.snapshot_removed', { values: { when: when(report.evidenceDeletedAt) } }) : report.source === 'safety_flag' ? $_('mod.no_snapshot') : report.messageSnapshot || $_('mod.no_text')}</blockquote>
				{#if report.evidenceExpiresAt && !report.evidenceDeletedAt}<p class="notice">{$_('mod.snapshot_expires', { values: { when: when(report.evidenceExpiresAt) } })}</p>{/if}
				{#if report.messageWasDeleted}<p class="notice">{$_('mod.source_deleted')}</p>{/if}
				{#if report.comment}<p class="reporter-comment"><strong>{$_('mod.reporter_note')}</strong> {report.comment}</p>{/if}

				<div class="actions">
					{#if report.status === 'open'}<button onclick={() => setStatus(report, 'reviewing', true)} disabled={busy === report.id}>{$_('mod.take_case')}</button>{/if}
					{#if report.status !== 'resolved'}<button onclick={() => setStatus(report, 'resolved')} disabled={busy === report.id}>{$_('reader_doc.resolve')}</button>{/if}
					{#if report.status !== 'dismissed'}<button onclick={() => setStatus(report, 'dismissed')} disabled={busy === report.id}>{$_('common.dismiss')}</button>{/if}
					<button class="quiet" onclick={() => expanded[report.id] = !expanded[report.id]}>{expanded[report.id] ? $_('mod.hide_comments') : $_('mod.staff_comments_count', { values: { count: report.staffComments.length } })}</button>
					<button onclick={() => actionOpen[report.id] = !actionOpen[report.id]} disabled={busy === report.id || report.authorUserId <= 0}>{actionOpen[report.id] ? $_('mod.cancel_action') : $_('mod.take_action')}</button>
					{#if canRemoveEvidence && report.messageSnapshot && !report.evidenceDeletedAt}<button class="quiet" onclick={() => confirmRedaction[report.id] = !confirmRedaction[report.id]} disabled={busy === report.id}>{$_('mod.remove_snapshot')}</button>{/if}
				</div>
				{#if confirmRedaction[report.id] && !report.evidenceDeletedAt}<div class="notice">{$_('mod.confirm_removal_text')} <button onclick={() => removeEvidence(report)} disabled={busy === report.id}>{$_('mod.confirm_removal')}</button></div>{/if}
				{#if actionOpen[report.id]}
					<section class="case-action-form">
						<p>{$_('mod.action_form_desc', { values: { name: report.authorUsername } })}</p>
						<label>{$_('ffxiv.kind_action')}<select bind:value={actionKind[report.id]}>
							<option value="channel_timeout">{$_('mod.opt_channel_timeout')}</option>
							<option value="channel_ban">{$_('mod.opt_channel_ban')}</option>
							<option value="server_ban">{$_('mod.opt_server_ban')}</option>
							<option value="lift_channel_timeout">{$_('mod.opt_lift_channel_timeout')}</option>
							<option value="lift_channel_ban">{$_('mod.opt_lift_channel_ban')}</option>
							<option value="lift_server_ban">{$_('mod.opt_lift_server_ban')}</option>
						</select></label>
						{#if (actionKind[report.id] ?? 'channel_timeout') === 'channel_timeout'}<label>{$_('mod.minutes')}<input type="number" min="1" max="10080" bind:value={actionMinutes[report.id]} placeholder="10" /></label>{/if}
						<label>{$_('mod.reason')}<input bind:value={actionReason[report.id]} placeholder={report.reason} maxlength="280" /></label>
						<button onclick={() => applyAction(report)} disabled={busy === report.id}>{$_('mod.apply_action')}</button>
					</section>
				{/if}
				{#if (report.actions ?? []).length > 0}
					<section class="case-history" aria-label={$_('mod.case_actions_label')}>
						<strong>{$_('mod.action_history')}</strong>
						{#each report.actions ?? [] as action (action.id)}
							<div><span>{actionLabel(action.kind)} · {action.outcome} · @{action.actorUsername} · {when(action.createdAt)}</span><small>{action.reason}{action.expiresAt ? $_('mod.expires', { values: { when: when(action.expiresAt) } }) : ''}</small></div>
						{/each}
						{#if report.actions?.some(action => action.outcome === 'pending')}<p class="notice">{$_('mod.pending_action')}</p>{/if}
					</section>
				{/if}

				{#if expanded[report.id]}
					<section class="staff-thread">
						<div class="staff-note"><strong>{$_('mod.staff_discussion')}</strong>{$_('mod.staff_discussion_desc')}</div>
					{#each report.staffComments as comment (comment.id)}
						<div class="comment"><div><strong>@{comment.authorUsername}</strong><time>{when(comment.createdAt)}</time></div><p>{comment.body}</p></div>
					{/each}
					<div class="comment-box"><textarea bind:value={commentDrafts[report.id]} rows="2" placeholder={$_('mod.add_context')}></textarea><button onclick={() => addComment(report)} disabled={busy === report.id || !(commentDrafts[report.id] ?? '').trim()}>{$_('office.editor.comment')}</button></div>
					</section>
				{/if}
			</article>
		{/each}
	</div>
</div>

<style>
	.mod-center{display:grid;gap:18px}.hero{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;padding:24px;border:1px solid var(--w-line-strong);border-radius:18px;background:linear-gradient(135deg,var(--w-raise),var(--w-bg2))}.hero h2{margin:4px 0 6px;font-size:1.7rem}.hero p{margin:0;color:var(--w-mute);max-width:720px}.eyebrow{text-transform:uppercase;letter-spacing:.11em;font-size:.72rem;color:var(--w-mute)}button{font:inherit;cursor:pointer;border:1px solid var(--w-line-strong);border-radius:10px;background:var(--w-bg2);color:var(--w-text);padding:9px 13px}button:hover{background:var(--w-raise)}button:disabled{opacity:.5;cursor:not-allowed}.summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.summary div{padding:18px;border:1px solid var(--w-line-strong);border-radius:14px;background:var(--w-raise);display:grid;gap:3px}.summary strong{font-size:1.6rem}.summary span,.people,time{color:var(--w-mute);font-size:.86rem}.queue{display:grid;gap:12px}.queue article{padding:18px;border:1px solid var(--w-line-strong);border-radius:16px;background:var(--w-raise)}.queue article.closed{opacity:.78}.queue header{display:flex;justify-content:space-between;gap:16px}.report-title{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.status{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;border:1px solid var(--w-line-strong);border-radius:999px;padding:3px 8px}.status.open,.status.reviewing{background:var(--w-raise)}.people{display:flex;gap:14px;flex-wrap:wrap;margin:10px 0}blockquote{margin:12px 0;padding:14px 16px;border-left:3px solid var(--w-accent);background:var(--w-bg2);border-radius:0 10px 10px 0;white-space:pre-wrap}.notice,.staff-note{padding:10px 12px;border:1px solid var(--w-line-strong);border-radius:10px;background:var(--w-bg2);color:var(--w-mute)}.reporter-comment{color:var(--w-mute)}.actions{display:flex;gap:8px;flex-wrap:wrap}.quiet{margin-left:auto}.staff-thread{margin-top:14px;padding-top:14px;border-top:1px solid var(--w-line-strong);display:grid;gap:10px}.comment{padding:10px 12px;background:var(--w-bg2);border-radius:10px}.comment div{display:flex;justify-content:space-between}.comment p{margin:5px 0 0;white-space:pre-wrap}.comment-box{display:flex;gap:8px}.comment-box textarea{flex:1;resize:vertical;background:var(--w-bg2);border:1px solid var(--w-line-strong);border-radius:10px;padding:10px;color:var(--w-text);font:inherit}.error{padding:12px;border:1px solid var(--w-danger);border-radius:10px}.empty{padding:28px;border:1px dashed var(--w-line-strong);border-radius:14px;display:grid;text-align:center;gap:4px;color:var(--w-mute)}.empty strong{color:var(--w-text)}@media(max-width:720px){.hero{display:grid}.summary{grid-template-columns:1fr}.queue header{display:grid}.quiet{margin-left:0}.comment-box{display:grid}}
	.case-action-form,.case-history{margin-top:14px;padding:14px;border:1px solid var(--w-line-strong);border-radius:12px;background:var(--w-bg2);display:grid;gap:10px}.case-action-form p{margin:0;color:var(--w-mute);font-size:.86rem}.case-action-form label{display:grid;gap:5px;font-size:.84rem}.case-action-form input,.case-action-form select{min-width:0;padding:9px 11px;border:1px solid var(--w-line-strong);border-radius:9px;background:var(--w-raise);color:var(--w-text);font:inherit}.case-action-form button{justify-self:start}.case-history div{display:grid;gap:3px}.case-history small{color:var(--w-mute)}
</style>
