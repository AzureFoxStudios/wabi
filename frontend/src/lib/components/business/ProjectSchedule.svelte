<script lang="ts">
	import { _ } from '$lib/i18n';
	/**
	 * The project's cards laid out by day: an itinerary you can read at a glance and copy as plain text.
	 * It reads the same shared cards as the board (due date, owner, status); there is no second copy of the data.
	 * Cards carry a due date, not a time of day, so times belong in the card title or in a wiki schedule table.
	 */
	import { onMount } from 'svelte';
	import { getAuthToken } from '$lib/authSession';
	import { fetchChannel } from '$lib/api/channelAccess';
	import { getServerUrl } from '$lib/serverUrl';
	import { copyToClipboard } from '$lib/shareToChannel';

	let { channelId }: { channelId: string } = $props();
	type Item = { taskId: string; title: string; status: string; priority: string; dueDateMillis: number | null; assigneeUserId: number | null; isArchived: boolean };
	let items = $state<Item[]>([]);
	let members = $state<Record<number, string>>({});
	let loading = $state(true);
	let error = $state('');
	let notice = $state('');

	const STATUS: Record<string, string> = { ideas: $_('project_schedule.idea'), todo: $_('project_schedule.to_do'), in_progress: $_('project_schedule.in_progress'), done: $_('project_schedule.done'), scrapped: $_('project_schedule.set_aside') };
	const base = $derived(`${getServerUrl()}/api/projects/${encodeURIComponent(channelId)}`);
	const headers = () => { const token = getAuthToken(); return token ? { Authorization: `Bearer ${token}` } : {}; };

	async function load(): Promise<void> {
		loading = true;
		try {
			const [tasksResponse, membersResponse] = await Promise.all([
				fetchChannel(channelId, `${base}/tasks`, { headers: headers() }),
				fetchChannel(channelId, `${base}/members`, { headers: headers() }).catch(() => null)
			]);
			if (!tasksResponse.ok) throw new Error(tasksResponse.status === 403 ? $_('project_schedule.access_removed') : $_('project_schedule.load_failed', { values: { status: tasksResponse.status } }));
			const data = await tasksResponse.json();
			items = (Array.isArray(data.tasks) ? data.tasks : []).filter((task: Item) => !task.isArchived && task.status !== 'scrapped');
			if (membersResponse?.ok) {
				const list = (await membersResponse.json()).members;
				members = Object.fromEntries((Array.isArray(list) ? list : []).map((member: { id: number; name: string }) => [member.id, member.name]));
			}
			error = '';
		} catch (cause) { error = cause instanceof Error ? cause.message : $_('project_schedule.load_failed_generic'); }
		finally { loading = false; }
	}
	onMount(() => { void load(); });

	const dayKey = (millis: number) => { const d = new Date(millis); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
	const todayKey = $derived(dayKey(Date.now()));
	const groups = $derived.by(() => {
		const dated = items.filter((item) => item.dueDateMillis != null).sort((a, b) => a.dueDateMillis! - b.dueDateMillis!);
		const byDay = new Map<string, Item[]>();
		for (const item of dated) byDay.set(dayKey(item.dueDateMillis!), [...(byDay.get(dayKey(item.dueDateMillis!)) ?? []), item]);
		const out = [...byDay.entries()].map(([key, rows]) => ({
			key, rows, overdue: key < todayKey && rows.some((row) => row.status !== 'done'), today: key === todayKey,
			label: new Date(rows[0].dueDateMillis!).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
		}));
		const undated = items.filter((item) => item.dueDateMillis == null);
		return undated.length ? [...out, { key: 'none', rows: undated, overdue: false, today: false, label: $_('project_schedule.no_date') }] : out;
	});
	const who = (id: number | null) => (id == null ? '' : members[id] ?? $_('project_schedule.member_id', { values: { id } }));

	async function copyText(): Promise<void> {
		const text = groups.map((group) => `${group.label}\n${group.rows.map((row) => `  - ${row.title}${row.assigneeUserId != null ? ` (${who(row.assigneeUserId)})` : ''} [${STATUS[row.status] ?? row.status}]`).join('\n')}`).join('\n\n');
		try { await copyToClipboard(text); notice = $_('project_schedule.copied'); } catch { notice = $_('project_schedule.copy_failed'); }
		setTimeout(() => { notice = ''; }, 3000);
	}
</script>

<section class="schedule" aria-label={$_('project_schedule.aria_label')}>
	<header>
		<div><p class="kicker">{$_('project_schedule.by_day')}</p><h2>{$_('project_schedule.heading')}</h2><p class="hint">{$_('project_schedule.hint')}</p></div>
		<div class="actions">{#if notice}<span class="notice" role="status">{notice}</span>{/if}<button type="button" onclick={copyText} disabled={!groups.length}>{$_('project_schedule.copy_as_text')}</button><button type="button" onclick={() => void load()} disabled={loading}>{$_('network_health.refresh')}</button></div>
	</header>
	{#if error}<p class="error" role="alert">{error}</p>
	{:else if loading}<p class="hint" role="status">{$_('project_schedule.loading')}</p>
	{:else if !groups.length}<p class="hint">{$_('project_schedule.empty')}</p>
	{:else}
		<div class="table-scroll"><table>
			<thead><tr><th>{$_('project_schedule.th_day')}</th><th>{$_('project_schedule.th_what')}</th><th>{$_('project_schedule.th_who')}</th><th>{$_('project_schedule.th_status')}</th></tr></thead>
			<tbody>
				{#each groups as group (group.key)}
					{#each group.rows as row, index (row.taskId)}
						<tr class:done={row.status === 'done'} class:overdue={group.overdue && row.status !== 'done'}>
							<td class="day">{#if index === 0}<span class:today={group.today}>{group.label}</span>{#if group.today}<em>{$_('project_schedule.today')}</em>{:else if group.overdue}<em class="late">{$_('project_schedule.overdue')}</em>{/if}{/if}</td>
							<td class="what">{row.title}</td>
							<td class="who">{who(row.assigneeUserId)}</td>
							<td class="state">{STATUS[row.status] ?? row.status}</td>
						</tr>
					{/each}
				{/each}
			</tbody>
		</table></div>
	{/if}
</section>

<style>
	.schedule { padding: 1.25rem clamp(1rem, 3vw, 2.25rem) 2rem; color: var(--w-text); display: grid; gap: 1rem; align-content: start; }
	header { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .75rem 1.5rem; align-items: flex-end; }
	.kicker { margin: 0 0 .2rem; font: 600 .66rem var(--w-mono); letter-spacing: .1em; text-transform: uppercase; color: var(--w-mute); }
	h2 { margin: 0; font: 600 1.7rem/1.15 var(--w-serif); }
	.hint { margin: .3rem 0 0; color: var(--w-mute); font-size: .85rem; }
	.actions { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
	.actions button { min-height: 32px; padding: 4px 12px; border: var(--w-bw, 1px) solid var(--w-line-strong); border-radius: calc(8px * var(--w-rs, 1)); background: transparent; color: var(--w-text); font: 600 .78rem var(--w-sans); cursor: pointer; }
	.actions button:hover:not(:disabled) { border-color: var(--w-accent); color: var(--w-accent); }
	.actions button:disabled { opacity: .5; cursor: default; }
	.notice { font: 500 .72rem var(--w-mono); color: var(--w-mute); }
	.error { color: var(--w-danger); }
	.table-scroll { overflow-x: auto; }
	table { width: 100%; border-collapse: collapse; }
	th { text-align: left; font: 600 .66rem var(--w-mono); letter-spacing: .1em; text-transform: uppercase; color: var(--w-faint); padding: .5rem .75rem; border-bottom: var(--w-bw, 1px) solid var(--w-line-strong); }
	td { padding: .6rem .75rem; border-bottom: var(--w-bw, 1px) solid var(--w-line); vertical-align: top; font-size: .92rem; }
	.day { white-space: nowrap; font: 600 .82rem var(--w-mono); color: var(--w-sig); width: 1%; }
	.day em { display: block; font: 500 .66rem var(--w-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--w-mute); }
	.day em.late { color: var(--w-danger); }
	.day .today { color: var(--w-text); }
	.what { font: 600 1rem/1.35 var(--w-serif); overflow-wrap: anywhere; }
	.who, .state { color: var(--w-mute); font-size: .82rem; white-space: nowrap; }
	tr.done .what { color: var(--w-mute); text-decoration: line-through; text-decoration-color: var(--w-deco); }
	tr.overdue .what { box-shadow: inset 2px 0 0 var(--w-danger); padding-left: .5rem; }
</style>
