<script lang="ts">
	import { onMount } from 'svelte';
	import { activeServerUrl } from '$lib/serverUrl';
	import { getAuthToken } from '$lib/authSession';

	type ReportStatus = 'open' | 'reviewing' | 'resolved' | 'dismissed';
	type StaffComment = { id: string; authorUserId: number; authorUsername: string; body: string; createdAt: string };
	type Report = {
		id: string; source: string; channelId: string; messageId: string; messageSnapshot: string;
		messageWasDeleted: boolean; authorUserId: number; authorUsername: string;
		reporterUserId: number; reporterUsername: string; reason: string; comment: string | null;
		createdAt: string; status: ReportStatus; assignedToUserId: number | null; assignedToUsername: string | null;
		resolution: string | null; staffComments: StaffComment[];
	};

	let reports: Report[] = $state([]);
	let loading = $state(true);
	let error = $state('');
	let busy = $state<string | null>(null);
	let commentDrafts: Record<string, string> = $state({});
	let expanded: Record<string, boolean> = $state({});

	const openCount = $derived(reports.filter(r => r.status === 'open').length);
	const reviewingCount = $derived(reports.filter(r => r.status === 'reviewing').length);
	const closedCount = $derived(reports.filter(r => r.status === 'resolved' || r.status === 'dismissed').length);

	function token(): string | null { return getAuthToken($activeServerUrl); }
	async function request(path: string, init: RequestInit = {}) {
		const auth = token();
		if (!auth) throw new Error('Sign in again to use moderation tools.');
		const response = await fetch(`${$activeServerUrl}/api/server-center${path}`, {
			...init,
			headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
			credentials: 'include'
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(data.error || `Moderation request failed (${response.status}).`);
		return data;
	}

	async function refresh() {
		loading = true; error = '';
		try { reports = (await request('/reports')).reports ?? []; }
		catch (cause) { error = cause instanceof Error ? cause.message : 'Could not load reports.'; }
		finally { loading = false; }
	}

	async function setStatus(report: Report, status: ReportStatus, assignToMe = false) {
		busy = report.id; error = '';
		try {
			const data = await request(`/reports/${encodeURIComponent(report.id)}/status`, {
				method: 'PUT', body: JSON.stringify({ status, assignToMe })
			});
			reports = reports.map(item => item.id === report.id ? data.report : item);
		} catch (cause) { error = cause instanceof Error ? cause.message : 'Could not update report.'; }
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
		} catch (cause) { error = cause instanceof Error ? cause.message : 'Could not add staff comment.'; }
		finally { busy = null; }
	}

	function when(value: string) {
		const time = Date.parse(value);
		return Number.isFinite(time) ? new Date(time).toLocaleString() : value;
	}

	onMount(() => { void refresh(); });
</script>

<div class="mod-center">
	<section class="hero">
		<div><span class="eyebrow">Moderation inbox</span><h2>What needs a human?</h2><p>Reports arrive with a preserved message snapshot, reporter context, and staff discussion in one place.</p></div>
		<button class="refresh" onclick={refresh} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
	</section>

	<div class="summary" aria-label="Moderation queue summary">
		<div><strong>{openCount}</strong><span>Needs review</span></div>
		<div><strong>{reviewingCount}</strong><span>Being handled</span></div>
		<div><strong>{closedCount}</strong><span>Closed</span></div>
	</div>

	{#if error}<div class="error" role="alert">{error}</div>{/if}
	{#if !loading && reports.length === 0}
		<section class="empty"><strong>Queue clear.</strong><span>No reports are waiting for staff.</span></section>
	{/if}

	<div class="queue">
		{#each reports as report (report.id)}
			<article class:closed={report.status === 'resolved' || report.status === 'dismissed'}>
				<header>
					<div class="report-title"><span class="status {report.status}">{report.status}</span><strong>{report.reason}</strong><span>#{report.channelId}</span></div>
					<time>{when(report.createdAt)}</time>
				</header>
				<div class="people"><span>Reported message by <strong>@{report.authorUsername}</strong></span><span>Reported by @{report.reporterUsername}</span>{#if report.assignedToUsername}<span>Assigned to @{report.assignedToUsername}</span>{/if}</div>
				<blockquote>{report.messageSnapshot || 'Message contained no text.'}</blockquote>
				{#if report.messageWasDeleted}<p class="notice">The source message had already been deleted when this report was captured.</p>{/if}
				{#if report.comment}<p class="reporter-comment"><strong>Reporter note:</strong> {report.comment}</p>{/if}

				<div class="actions">
					{#if report.status === 'open'}<button onclick={() => setStatus(report, 'reviewing', true)} disabled={busy === report.id}>Take case</button>{/if}
					{#if report.status !== 'resolved'}<button onclick={() => setStatus(report, 'resolved')} disabled={busy === report.id}>Resolve</button>{/if}
					{#if report.status !== 'dismissed'}<button onclick={() => setStatus(report, 'dismissed')} disabled={busy === report.id}>Dismiss</button>{/if}
					<button class="quiet" onclick={() => expanded[report.id] = !expanded[report.id]}>{expanded[report.id] ? 'Hide staff comments' : `Staff comments (${report.staffComments.length})`}</button>
				</div>

				{#if expanded[report.id]}
					<section class="staff-thread">
						<div class="staff-note"><strong>Private staff discussion attached to this case.</strong> It is not another public channel, and reporters cannot see these comments.</div>
					{#each report.staffComments as comment (comment.id)}
						<div class="comment"><div><strong>@{comment.authorUsername}</strong><time>{when(comment.createdAt)}</time></div><p>{comment.body}</p></div>
					{/each}
					<div class="comment-box"><textarea bind:value={commentDrafts[report.id]} rows="2" placeholder="Add context for other staff…"></textarea><button onclick={() => addComment(report)} disabled={busy === report.id || !(commentDrafts[report.id] ?? '').trim()}>Comment</button></div>
					</section>
				{/if}
			</article>
		{/each}
	</div>
</div>

<style>
	.mod-center{display:grid;gap:18px}.hero{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;padding:24px;border:1px solid var(--border-default);border-radius:18px;background:linear-gradient(135deg,var(--surface-raised),var(--surface-base))}.hero h2{margin:4px 0 6px;font-size:1.7rem}.hero p{margin:0;color:var(--text-secondary);max-width:720px}.eyebrow{text-transform:uppercase;letter-spacing:.11em;font-size:.72rem;color:var(--text-muted)}button{font:inherit;cursor:pointer;border:1px solid var(--border-default);border-radius:10px;background:var(--surface-base);color:var(--text-primary);padding:9px 13px}button:hover{background:var(--surface-hover)}button:disabled{opacity:.5;cursor:not-allowed}.summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.summary div{padding:18px;border:1px solid var(--border-default);border-radius:14px;background:var(--surface-raised);display:grid;gap:3px}.summary strong{font-size:1.6rem}.summary span,.people,time{color:var(--text-secondary);font-size:.86rem}.queue{display:grid;gap:12px}.queue article{padding:18px;border:1px solid var(--border-default);border-radius:16px;background:var(--surface-raised)}.queue article.closed{opacity:.78}.queue header{display:flex;justify-content:space-between;gap:16px}.report-title{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.status{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;border:1px solid var(--border-default);border-radius:999px;padding:3px 8px}.status.open,.status.reviewing{background:var(--surface-hover)}.people{display:flex;gap:14px;flex-wrap:wrap;margin:10px 0}blockquote{margin:12px 0;padding:14px 16px;border-left:3px solid var(--accent-primary);background:var(--surface-base);border-radius:0 10px 10px 0;white-space:pre-wrap}.notice,.staff-note{padding:10px 12px;border:1px solid var(--border-default);border-radius:10px;background:var(--surface-base);color:var(--text-secondary)}.reporter-comment{color:var(--text-secondary)}.actions{display:flex;gap:8px;flex-wrap:wrap}.quiet{margin-left:auto}.staff-thread{margin-top:14px;padding-top:14px;border-top:1px solid var(--border-default);display:grid;gap:10px}.comment{padding:10px 12px;background:var(--surface-base);border-radius:10px}.comment div{display:flex;justify-content:space-between}.comment p{margin:5px 0 0;white-space:pre-wrap}.comment-box{display:flex;gap:8px}.comment-box textarea{flex:1;resize:vertical;background:var(--surface-base);border:1px solid var(--border-default);border-radius:10px;padding:10px;color:var(--text-primary);font:inherit}.error{padding:12px;border:1px solid var(--danger);border-radius:10px}.empty{padding:28px;border:1px dashed var(--border-default);border-radius:14px;display:grid;text-align:center;gap:4px;color:var(--text-secondary)}.empty strong{color:var(--text-primary)}@media(max-width:720px){.hero{display:grid}.summary{grid-template-columns:1fr}.queue header{display:grid}.quiet{margin-left:0}.comment-box{display:grid}}
</style>
