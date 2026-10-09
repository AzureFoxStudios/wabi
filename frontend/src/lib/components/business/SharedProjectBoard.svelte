<script lang="ts">
	import { onMount } from 'svelte';
	import { getAuthToken, getStoredDbUserId, onAuthSessionCleared } from '$lib/authSession';
	import { fetchChannel } from '$lib/api/channelAccess';
	import { getServerUrl } from '$lib/serverUrl';
	import type { KanbanColumn, Todo, TodoStatus } from '$lib/business/types';
	import { projectBurndown, type BurnRevision } from '$lib/business/projectBurndown';
	import KanbanBoardColumns from './KanbanBoardColumns.svelte';
	import ProjectMap from './ProjectMap.svelte';

	export let channelId: string;

	type Priority = Todo['priority'];
	type ProjectTask = {
		taskId: string; channelId: string; title: string; description: string;
		status: TodoStatus; priority: Priority; dueDateMillis: number | null;
		assigneeUserId: number | null; createdByUserId: number; updatedByUserId: number;
		notes: string; checklist: { id: string; title: string; done: boolean }[]; relatedTaskIds: string[]; humanEstimateMinutes: number | null;
		createdAtMicros: number; updatedAtMicros: number; revision: number; isArchived: boolean;
	};
	type ProjectMember = { id: number; name: string; isBot: boolean };
	const columns: KanbanColumn[] = [
		{ id: 'ideas', label: 'Ideas', color: '#8b5cf6', visible: true },
		{ id: 'todo', label: 'To do', color: '#3b82f6', visible: true },
		{ id: 'in_progress', label: 'In progress', color: '#f59e0b', visible: true },
		{ id: 'done', label: 'Done', color: '#10b981', visible: true },
		{ id: 'scrapped', label: 'Scrapped', color: '#6b7280', visible: true }
	];
	let tasks: ProjectTask[] = [];
	let members: ProjectMember[] = [];
	let loading = true;
	let saving = false;
	let error = '';
	let modalOpen = false;
	let editing: ProjectTask | null = null;
	let createOperationId: string | null = null;
	let title = '';
	let description = '';
	let notes = '';
	let checklist: ProjectTask['checklist'] = [];
	let relatedTaskIds: string[] = [];
	let linkSearch = '';
	let inspectedLink = '';
	$: linkCandidates = tasks.filter(task => task.taskId !== editing?.taskId && !task.isArchived && `${task.title} ${task.taskId}`.toLowerCase().includes(linkSearch.toLowerCase().trim()));
	let estimateHours: number | undefined;
	let showBurn = false;
	let history: BurnRevision[] = [];
	let historyError = '';
	$: burn = projectBurndown(history);
	$: maxBurn = Math.max(60, ...burn.map(p => Math.max(p.scopeMinutes, p.remainingMinutes)));
	$: burnStart = burn[0]?.at ?? 0;
	$: burnEnd = Math.max(burnStart + 1, burn.at(-1)?.at ?? 0);
	$: burnPath = burn.map((p, i) => `${i ? 'L' : 'M'}${30 + (p.at - burnStart) / (burnEnd - burnStart) * 640},${160 - p.remainingMinutes / maxBurn * 130}`).join(' ');
	$: scopePath = burn.map((p, i) => `${i ? 'L' : 'M'}${30 + (p.at - burnStart) / (burnEnd - burnStart) * 640},${160 - p.scopeMinutes / maxBurn * 130}`).join(' ');
	let status: TodoStatus = 'todo';
	let priority: Priority = 'medium';
	let dueDate = '';
	let assigneeUserId = '';
	let dragOverColumn: TodoStatus | null = null;
	let draggedId = '';
	let requestEpoch = 0;
	let showScrapped = false;
	let currentUserId: number | null = null;

	$: visibleTasks = tasks.filter(task => !task.isArchived && task.status !== 'archived');
	$: visibleColumns = columns.filter(column => column.id !== 'scrapped' || showScrapped);
	$: trackedTasks = visibleTasks.filter(task => task.status !== 'scrapped');
	$: doneCount = trackedTasks.filter(task => task.status === 'done').length;
	$: workingCount = trackedTasks.filter(task => task.status === 'in_progress').length;
	$: scrappedCount = visibleTasks.filter(task => task.status === 'scrapped').length;
	$: completionPercent = trackedTasks.length ? Math.round(doneCount / trackedTasks.length * 100) : 0;
	$: sortedTodosByColumn = Object.fromEntries(columns.map(column => [column.id,
		visibleTasks.filter(task => task.status === column.id).map(toTodo)])) as Record<TodoStatus, Todo[]>;

	function toTodo(task: ProjectTask): Todo {
		return {
			id: task.taskId, title: task.title, description: task.description,
			status: task.status, priority: task.priority,
			createdAt: Math.floor(task.createdAtMicros / 1000),
			updatedAt: Math.floor(task.updatedAtMicros / 1000),
			createdBy: String(task.createdByUserId),
			...(task.dueDateMillis != null ? { dueDate: task.dueDateMillis } : {}),
			...(task.humanEstimateMinutes != null ? { estimatedMinutes: task.humanEstimateMinutes } : {}),
			...(task.assigneeUserId != null ? { assignedTo: String(task.assigneeUserId) } : {})
		};
	}

	function headers(): Record<string, string> {
		const token = getAuthToken();
		return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
	}
	function path(taskId = ''): string {
		return `${getServerUrl()}/api/projects/${encodeURIComponent(channelId)}/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ''}`;
	}
	async function loadMembers(): Promise<void> {
		try {
			const response = await fetchChannel(channelId, `${getServerUrl()}/api/projects/${encodeURIComponent(channelId)}/members`, { headers: headers() });
			if (!response.ok) return;
			const data = await response.json();
			members = Array.isArray(data.members) ? data.members : [];
		} catch { /* Board access errors are reported by load(). */ }
	}
	async function load(): Promise<void> {
		const epoch = ++requestEpoch;
		try {
			const response = await fetchChannel(channelId, path(), { headers: headers() });
			if (!response.ok) throw new Error(response.status === 403 ? 'Project access was removed.' : `Could not load the shared board (${response.status}).`);
			const data = await response.json();
			if (epoch !== requestEpoch) return;
			tasks = Array.isArray(data.tasks) ? data.tasks : [];
			if (showBurn) void loadHistory();
			error = '';
		} catch (cause) {
			if (epoch !== requestEpoch) return;
			tasks = [];
			error = cause instanceof Error ? cause.message : 'Could not load the shared board.';
		} finally {
			if (epoch === requestEpoch) loading = false;
		}
	}
	onMount(() => {
		currentUserId = getStoredDbUserId();
		void load();
		void loadMembers();
		const poll = setInterval(() => { if (!saving && !modalOpen && document.visibilityState === 'visible') void load(); }, 5000);
		const stopAuth = onAuthSessionCleared(() => { requestEpoch++; tasks = []; members = []; history = []; currentUserId = null; error = 'Sign in to view this project.'; });
		return () => { clearInterval(poll); stopAuth(); requestEpoch++; };
	});

	async function loadHistory(): Promise<void> {
        try {
            const response = await fetchChannel(channelId, `${getServerUrl()}/api/projects/${encodeURIComponent(channelId)}/history`, { headers: headers() });
            if (!response.ok) throw new Error('Could not load estimate history.');
            const data = await response.json(); history = data.history ?? []; historyError = '';
        } catch (cause) { history = []; historyError = cause instanceof Error ? cause.message : 'Could not load estimate history.'; }
    }
	function openAddModal(column: TodoStatus): void {
		void loadMembers();
		editing = null; createOperationId = crypto.randomUUID(); title = ''; description = ''; status = column; priority = 'medium';
		dueDate = ''; assigneeUserId = ''; notes = ''; checklist = []; relatedTaskIds = []; estimateHours = undefined; modalOpen = true; error = '';
	}
	function handleCardClick(todo: Todo): void {
		void loadMembers();
		const task = tasks.find(item => item.taskId === todo.id);
		if (!task) return;
		editing = task; createOperationId = null; title = task.title; description = task.description;
		status = task.status; priority = task.priority; notes = task.notes ?? ''; checklist = structuredClone(task.checklist ?? []); relatedTaskIds = [...(task.relatedTaskIds ?? [])]; estimateHours = task.humanEstimateMinutes == null ? undefined : task.humanEstimateMinutes / 60;
		dueDate = task.dueDateMillis == null ? '' : new Date(task.dueDateMillis).toISOString().slice(0, 10);
		assigneeUserId = task.assigneeUserId == null ? '' : String(task.assigneeUserId);
		modalOpen = true; error = '';
	}
	function fields(nextStatus: TodoStatus = status) {
		return { title: title.trim(), description, status: nextStatus, priority,
			dueDateMillis: dueDate ? new Date(`${dueDate}T12:00:00`).getTime() : null,
			assigneeUserId: assigneeUserId ? Number(assigneeUserId) : null, notes, checklist, relatedTaskIds,
			humanEstimateMinutes: estimateHours == null ? null : Math.round(estimateHours * 60) };
	}
	async function write(task: ProjectTask | null, body: Record<string, unknown>): Promise<boolean> {
		saving = true;
		try {
			const response = await fetchChannel(channelId, path(task?.taskId), {
				method: task ? 'PUT' : 'POST', headers: headers(), body: JSON.stringify(body)
			});
			if (!response.ok) {
				if (response.status === 409) {
					await load();
					const current = task ? tasks.find(item => item.taskId === task.taskId) : null;
					if (modalOpen && current) editing = current;
					throw new Error(current
						? `This card changed to ${current.status} by member #${current.updatedByUserId}. Your draft is still here; review before saving again.`
						: 'This card changed or was removed. Your draft is still here; refresh before saving again.');
				}
				throw new Error(response.status === 403 ? 'You no longer have access to edit this project.' : `Could not save the card (${response.status}).`);
			}
			await load();
			error = '';
			return true;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not save the card.';
			return false;
		} finally { saving = false; }
	}
	async function save(): Promise<void> {
		if (!title.trim() || saving) return;
		const task = editing;
		const body = task ? { expectedRevision: task.revision, ...fields() }
			: { operationId: createOperationId ?? (createOperationId = crypto.randomUUID()), ...fields() };
		if (await write(task, body)) { modalOpen = false; createOperationId = null; }
	}
	async function archive(): Promise<void> {
		if (!editing || saving) return;
		if (await write(editing, { expectedRevision: editing.revision, ...fields('archived') })) modalOpen = false;
	}
	function handleDragStart(event: DragEvent, todo: Todo): void {
		draggedId = todo.id;
		event.dataTransfer?.setData('text/plain', todo.id);
	}
	function handleDragOver(event: DragEvent, column: TodoStatus): void { event.preventDefault(); dragOverColumn = column; }
	function handleDragLeave(): void { dragOverColumn = null; }
	async function handleDrop(event: DragEvent, nextStatus: TodoStatus): Promise<void> {
		event.preventDefault(); dragOverColumn = null;
		const id = event.dataTransfer?.getData('text/plain') || draggedId;
		const task = tasks.find(item => item.taskId === id);
		if (!task || task.status === nextStatus || saving) return;
		await write(task, { expectedRevision: task.revision, title: task.title,
			description: task.description, status: nextStatus, priority: task.priority,
			dueDateMillis: task.dueDateMillis, assigneeUserId: task.assigneeUserId });
	}
	async function claimTask(todo: Todo): Promise<void> {
        const task = tasks.find(item => item.taskId === todo.id);
        if (!task || saving) return;
        saving = true;
        try {
            const response = await fetchChannel(channelId, `${path(task.taskId)}/claim`, {method:'POST', headers:headers(), body:JSON.stringify({expectedRevision:task.revision})});
            if (!response.ok) throw new Error(response.status===409?'Someone changed or claimed this card. Review its assignment before trying again.':'Could not claim this card.');
            error=''; await load();
        } catch (cause) { await load(); error=cause instanceof Error?cause.message:'Could not claim this card.'; }
        finally { saving=false; }
    }
	function getPriorityColor(value: Priority): string {
		return { low: '#10b981', medium: '#3b82f6', high: '#f59e0b', urgent: '#ef4444' }[value];
	}
	function getAssigneeName(id: number | undefined): string {
		if (!id) return '';
		const member = members.find(item => item.id === id);
		return member ? `${member.name}${member.isBot ? ' · bot' : ''}` : `Member #${id}`;
	}
	function getColumnHint(value: TodoStatus): string {
		return { ideas: 'Capture what might be', todo: 'Ready when you are', in_progress: 'Being worked on', done: 'Finished work', scrapped: 'Set aside for now', archived: '' }[value] ?? '';
	}
</script>

<section class="shared-project-board" class:burn-open={showBurn} aria-label="Shared project plan">
	<div class="board-overview">
		<header class="board-heading">
			<div class="board-intro"><p class="board-eyebrow">THE SHARED BOARD <span>·</span> LIVE</p><h2>Work in motion</h2><p>Pick up a card, make progress, leave a clear trail for the team.</p></div>
			<div class="board-actions"><button class="refresh-button" type="button" onclick={() => void load()} disabled={loading} aria-label="Refresh board" title="Refresh board"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/></svg></button><button class="new-card-button" type="button" onclick={() => openAddModal('todo')}><span aria-hidden="true">＋</span> New card</button></div>
		</header>
		<div class="board-pulse" aria-label="Board progress">
			<div class="pulse-stat"><strong>{trackedTasks.length}</strong><span>On the board</span></div>
			<div class="pulse-stat"><strong>{workingCount}</strong><span>In progress</span></div>
			<div class="pulse-stat"><strong>{doneCount}</strong><span>Done</span></div>
			<div class="pulse-progress"><span>{completionPercent}% complete</span><div class="progress-track" role="progressbar" aria-label="Cards done" aria-valuenow={completionPercent} aria-valuemin="0" aria-valuemax="100"><div style:width={`${completionPercent}%`}></div></div></div>
		</div>
	</div>
	{#if !loading}<ProjectMap {tasks} nameOf={getAssigneeName} onOpen={(id) => handleCardClick({ id } as Todo)} />{/if}
	{#if error}<p class="board-error" role="alert">{error}</p>{/if}
	{#if loading}<p class="board-state" role="status">Loading shared board…</p>{:else}
		<div class="board-section-bar"><div><span class="section-line"></span><h3>Board lanes</h3><span class="lane-count">{visibleColumns.length}</span></div><button type="button" class:pressed={showScrapped} onclick={() => showScrapped = !showScrapped}>{showScrapped ? 'Hide' : 'Show'} set aside <span>{scrappedCount}</span></button></div>
		<div class="burn-toggle"><button type="button" onclick={() => { showBurn = !showBurn; if (showBurn) void loadHistory(); }}>{showBurn ? 'Hide' : 'Show'} estimate burndown</button><span>For human planning · estimates never sent to bots</span></div>
        {#if showBurn}<section class="burn-chart" aria-label="Human estimate burndown"><h3>Estimated work remaining</h3><p>Recorded changes, including added work and reopened cards. No estimate means uncounted work.</p>
        {#if historyError}<p role="alert">{historyError}</p>{:else if burn.length}<svg viewBox="0 0 700 195" role="img" aria-label="Remaining estimated hours over recorded changes"><path d="M30 30V160H670" class="burn-axis"/><path d={scopePath} class="scope-line"/><path d={burnPath} class="burn-line"/><text x="30" y="20">{(maxBurn / 60).toFixed(1)} hours</text><text x="30" y="185">{new Date(burnStart).toLocaleDateString()}</text><text x="550" y="185">{new Date(burnEnd).toLocaleDateString()}</text></svg><div class="burn-legend"><span>Remaining: {((burn.at(-1)?.remainingMinutes ?? 0)/60).toFixed(1)}h</span><span>Scope: {((burn.at(-1)?.scopeMinutes ?? 0)/60).toFixed(1)}h</span><span>{burn.at(-1)?.unestimated ?? 0} unestimated cards</span></div>{:else}<p>Estimate history will appear as cards change.</p>{/if}</section>{/if}
        <div class="board-scroll">
			<KanbanBoardColumns columns={visibleColumns} {sortedTodosByColumn} {dragOverColumn}
				showPriorityLabel compactEmpty {getColumnHint}
				{getPriorityColor} formatEstimateHours={(minutes) => minutes == null ? '' : `${minutes / 60}h · human estimate`}
				{getAssigneeName} {claimTask} isReadOnly={saving}
                canClaim={(todo) => currentUserId != null && (!todo.assignedTo || Number(todo.assignedTo)===currentUserId && todo.status!=='in_progress') && ['ideas','todo','in_progress'].includes(todo.status)}
                getClaimLabel={(todo) => todo.assignedTo ? 'Start working' : 'Claim this task'}
                getWorkingLabel={(todo) => { const task = tasks.find(t => t.taskId===todo.id); return task?.assigneeUserId != null && task.status==='in_progress' ? `${getAssigneeName(task.assigneeUserId)} is working on this` : ''; }}
				getProjectColor={() => '#3b82f6'} getProjectName={() => ''}
				formatDueDate={(date) => date ? new Date(date).toLocaleDateString() : ''}
				isOverdue={(date) => Boolean(date && date < Date.now())}
				{openAddModal} {handleDragOver} {handleDragLeave} {handleDrop} {handleDragStart}
				handleDragEnd={() => { draggedId = ''; }} {handleCardClick} />
		</div>
	{/if}
</section>

{#if modalOpen}
	<div class="task-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget && !saving) modalOpen = false; }}>
		<form class="shared-task-editor" onsubmit={(event) => { event.preventDefault(); void save(); }} aria-label={editing ? 'Edit shared card' : 'Create shared card'}>
			<header><h2>{editing ? 'Edit card' : 'New card'}</h2><button type="button" onclick={() => modalOpen = false} disabled={saving} aria-label="Close card editor">×</button></header>
			<label>Title<input bind:value={title} maxlength="200" required /></label>
			<label>Description<textarea bind:value={description} maxlength="16000" rows="5"></textarea></label>
			<div class="editor-grid"><label>Status<select bind:value={status}>{#each columns as column}<option value={column.id}>{column.label}</option>{/each}</select></label>
			<label>Priority<select bind:value={priority}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option></select></label></div>
			<div class="editor-grid"><label>Due date<input type="date" bind:value={dueDate} /></label><label>Assignee<select bind:value={assigneeUserId}><option value="">Unassigned</option>{#each members as member (member.id)}<option value={String(member.id)}>{member.name}{member.isBot ? ' · bot' : ''}</option>{/each}</select></label></div>
            <label>Human estimate (hours)<input type="number" min="0" max="10000" step="0.25" bind:value={estimateHours} placeholder="Leave blank if unknown" /><small>Human planning only. Bots cannot read or change this field.</small></label>
            <fieldset class="checklist-editor"><legend>Checklist</legend><p>Small steps belong here. Work needing its own owner or review belongs on a linked card.</p>{#each checklist as item, index (item.id)}<div class="checklist-row"><input type="checkbox" bind:checked={item.done} aria-label={`Complete checklist item ${index + 1}`} /><input bind:value={item.title} maxlength="500" aria-label={`Checklist item ${index + 1}`} required /><button type="button" aria-label={`Remove checklist item ${index + 1}`} onclick={() => checklist = checklist.filter(i => i.id !== item.id)}>×</button></div>{/each}<button type="button" disabled={checklist.length >= 100} onclick={() => checklist = [...checklist, {id: crypto.randomUUID(), title:'', done:false}]}>＋ Add step</button></fieldset>
            <label>Notes<textarea bind:value={notes} maxlength="16000" rows="3" placeholder="Decisions, context, links, or handoff notes"></textarea></label>
<fieldset class="linked-inventory"><legend>Linked cards</legend><p>Connect real cards. Each keeps its own owner and status.</p>
 {#each relatedTaskIds as id (id)}{@const target = tasks.find(task => task.taskId === id)}
 <div class="linked-selection"><button type="button" onclick={() => inspectedLink = inspectedLink === id ? '' : id}>{target?.title || 'Unavailable card'} <small>{target?.status.replaceAll('_',' ') || ''}</small></button><button type="button" aria-label={`Unlink ${target?.title || id}`} onclick={() => relatedTaskIds = relatedTaskIds.filter(value => value !== id)}>×</button></div>
 {#if inspectedLink === id && target}<div class="linked-preview"><strong>{target.title}</strong><p>{target.description || 'No description'}</p><small>Assignee: {members.find(member => member.id === target.assigneeUserId)?.name || 'Unassigned'}</small>{#if target.notes}<p>{target.notes}</p>{/if}</div>{/if}
 {/each}
 <label>Find cards<input bind:value={linkSearch} placeholder="Search card titles…" /></label>
 <div class="link-options">{#each linkCandidates as task (task.taskId)}<label><input type="checkbox" checked={relatedTaskIds.includes(task.taskId)} onchange={(event) => relatedTaskIds = event.currentTarget.checked ? [...new Set([...relatedTaskIds,task.taskId])] : relatedTaskIds.filter(id=>id !== task.taskId)} /><span>{task.title}<small>{task.status.replaceAll('_',' ')} · {members.find(member=>member.id===task.assigneeUserId)?.name || 'Unassigned'}</small></span></label>{:else}<p>No matching cards.</p>{/each}</div>
 <small>Click a linked card to inspect it without losing this draft. Unlinking does not delete the card.</small>
</fieldset>
			{#if error}<p class="board-error" role="alert">{error}</p>{/if}
			<footer>{#if editing}<button type="button" onclick={() => void archive()} disabled={saving}>Archive</button>{/if}<button type="button" onclick={() => modalOpen = false} disabled={saving}>Cancel</button><button type="submit" disabled={saving || !title.trim()}>{saving ? 'Saving…' : 'Save card'}</button></footer>
		</form>
	</div>
{/if}

<style>
 .linked-inventory{padding:16px;border:1px solid var(--border-subtle);border-radius:var(--radius-lg);display:grid;gap:12px}.linked-inventory p{font-size:13px;color:var(--text-muted);margin:0}.linked-selection{display:flex;gap:8px}.linked-selection button:first-child{flex:1;text-align:left;overflow-wrap:anywhere}.linked-selection small{display:block;color:var(--text-muted)}.linked-preview{padding:16px;background:var(--surface-base);border-radius:var(--radius-md);display:grid;gap:10px;white-space:pre-wrap;overflow-wrap:anywhere}.link-options{max-height:190px;overflow:auto;display:grid;gap:4px}.link-options label{display:flex;align-items:center;gap:10px;padding:10px;background:var(--surface-base);border-radius:var(--radius-md)}.link-options input{width:16px;flex-shrink:0}.link-options small{display:block;color:var(--text-muted);font-size:11px;margin-top:4px}

    .burn-toggle { display:flex; align-items:center; gap:.8rem; padding:.4rem 4rem .4rem clamp(1rem, 3vw, 2.25rem); color:var(--text-secondary); font-size:.72rem; flex-wrap:wrap; }
    .burn-toggle button, .checklist-editor button { border:1px solid var(--border-default); border-radius:var(--radius-md); background:var(--surface-raised); color:var(--text-primary); padding:.45rem .65rem; }
    .burn-chart { margin:.4rem 4rem .5rem 2rem; padding:.8rem 1rem; border:1px solid var(--border-subtle); border-radius:var(--radius-lg); flex:none; }
    .burn-chart h3 { margin:0; font-size:.9rem; } .burn-chart p { color:var(--text-secondary); font-size:.75rem; margin:.3rem 0; }
    .burn-chart svg { max-height:160px; width:100%; } .burn-chart text { fill:var(--text-secondary); font-size:12px; }
    .burn-axis { fill:none; stroke:var(--border-default); } .burn-line { fill:none; stroke:var(--accent-primary); stroke-width:3; } .scope-line { fill:none; stroke:var(--text-muted); stroke-dasharray:5 4; }
    .burn-legend { display:flex; flex-wrap:wrap; gap:1rem; font-size:.75rem; color:var(--text-secondary); }
    .checklist-editor { border:1px solid var(--border-subtle); border-radius:var(--radius-md); padding:.75rem; } .checklist-editor p, .shared-task-editor small { font-weight:400; color:var(--text-secondary); font-size:.72rem; }
    .checklist-row { display:flex; align-items:center; gap:.5rem; margin-bottom:.5rem; } .checklist-row input[type=checkbox] { width:auto; }
	.shared-project-board { display:flex; flex-direction:column; min-height:0; height:100%; background:var(--surface-base); color:var(--text-primary); }
	.shared-project-board.burn-open { overflow:auto; }
	.burn-open .board-scroll { flex:none; min-height:22rem; }
	.board-scroll :global(.assignee-chip-card) { max-width:100%; white-space:normal; overflow-wrap:anywhere; }
	.board-overview { padding:1.3rem 4rem 1.1rem clamp(1rem, 3vw, 2.25rem); background:linear-gradient(180deg, color-mix(in srgb, var(--surface-raised) 25%, var(--surface-base)), var(--surface-base)); }
	.board-heading { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:1rem; }
	.board-eyebrow { margin:0 0 .25rem; color:var(--accent-primary, #b69cff); font-size:.67rem; font-weight:760; letter-spacing:.14em; }
	.board-eyebrow span { color:var(--text-muted, var(--text-secondary)); }
	.board-intro h2 { margin:0; font-size:clamp(1.25rem, 2vw, 1.65rem); letter-spacing:-.03em; line-height:1.2; }
	.board-intro > p:last-child { margin:.35rem 0 0; color:var(--text-secondary); font-size:.82rem; line-height:1.4; }
	.board-actions { display:flex; align-items:center; gap:.55rem; }
	button { font:inherit; cursor:pointer; }
	.board-actions button { display:inline-flex; align-items:center; justify-content:center; min-height:2.5rem; border:1px solid var(--border-default); border-radius:.75rem; color:var(--text-primary); }
	.board-actions .refresh-button { width:2.5rem; padding:0; background:var(--surface-raised); }
	.refresh-button svg { width:1.05rem; height:1.05rem; }
	.board-actions .new-card-button { gap:.35rem; padding:.55rem .9rem; border-color:transparent; background:var(--accent-primary-color, var(--accent-primary, #8754e9)); color:#fff; font-weight:700; box-shadow:0 5px 20px color-mix(in srgb, var(--accent-primary, #8754e9) 28%, transparent); }
	.board-actions .new-card-button span { font-size:1.2rem; line-height:1; }
	.board-actions button:hover:not(:disabled) { filter:brightness(1.1); }
	.board-pulse { display:flex; align-items:center; gap:clamp(.7rem, 2.5vw, 2rem); margin-top:1.25rem; padding:1rem 1.2rem; border:1px solid var(--border-subtle); border-radius:1rem; background:color-mix(in srgb, var(--surface-raised) 65%, transparent); box-shadow:0 9px 24px #00000012; }
	.pulse-stat { display:flex; align-items:baseline; gap:.42rem; white-space:nowrap; }
	.pulse-stat strong { font-size:1.3rem; line-height:1; letter-spacing:-.04em; }
	.pulse-stat span { color:var(--text-secondary); font-size:.73rem; }
	.pulse-progress { flex:1; min-width:7rem; max-width:16rem; margin-left:auto; display:grid; gap:.4rem; color:var(--text-secondary); font-size:.72rem; text-align:right; }
	.progress-track { height:.34rem; border-radius:1rem; overflow:hidden; background:color-mix(in srgb, var(--text-secondary) 17%, transparent); }
	.progress-track > div { height:100%; border-radius:inherit; background:linear-gradient(90deg, var(--accent-primary, #9b6bff), #6ed5a4); transition:width .25s ease; }
	.board-section-bar { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:.35rem 4rem .2rem clamp(1rem, 3vw, 2.25rem); }
	.board-section-bar > div { display:flex; align-items:center; gap:.55rem; }
	.section-line { width:.2rem; height:1.05rem; border-radius:1rem; background:var(--accent-primary, #9b6bff); }
	.board-section-bar h3 { margin:0; font-size:.83rem; letter-spacing:.015em; }
	.lane-count { color:var(--text-muted, var(--text-secondary)); font-size:.72rem; }
	.board-section-bar button { border:0; padding:.4rem .5rem; border-radius:.45rem; background:transparent; color:var(--text-secondary); font-size:.75rem; }
	.board-section-bar button:hover, .board-section-bar button.pressed { color:var(--text-primary); background:var(--surface-raised); }
	.board-section-bar button span { margin-left:.2rem; color:var(--text-muted, var(--text-secondary)); }
	.board-scroll { flex:1; min-height:0; overflow:auto; padding:.15rem 4rem 1.5rem clamp(.5rem, 2vw, 1.5rem); scrollbar-color:color-mix(in srgb, var(--accent-primary, #9b6bff) 45%, transparent) transparent; }
	.board-scroll :global(.kanban-board) { align-items:flex-start; gap:.9rem; width:max-content; min-width:100%; height:auto; padding:.5rem; }
	.board-scroll :global(.kanban-column) { flex:0 0 clamp(245px, 27vw, 305px); min-height:15rem; height:auto; overflow:hidden; border:1px solid color-mix(in srgb, var(--border-default) 75%, transparent); border-radius:1rem; background:color-mix(in srgb, var(--surface-raised) 45%, var(--surface-base)); box-shadow:0 8px 26px #00000012; }
	.board-scroll :global(.kanban-column.drag-over) { border-color:var(--accent-primary, #9b6bff); background:color-mix(in srgb, var(--accent-primary, #9b6bff) 10%, var(--surface-base)); }
	.board-scroll :global(.column-header) { align-items:flex-start; padding:1rem 1rem .85rem; border-bottom:1px solid var(--border-subtle); }
	.board-scroll :global(.column-title) { align-items:flex-start; }
	.board-scroll :global(.column-indicator) { width:.5rem; height:.5rem; margin-top:.34rem; border-radius:50%; box-shadow:0 0 0 4px color-mix(in srgb, var(--col-color) 15%, transparent); }
	.board-scroll :global(.column-labels h2) { margin:0; color:var(--text-primary); font-size:.94rem; font-weight:720; }
	.board-scroll :global(.column-hint) { margin:.22rem 0 0; color:var(--text-muted, var(--text-secondary)); font-size:.69rem; }
	.board-scroll :global(.column-count) { margin-left:.1rem; padding:.12rem .43rem; border-radius:.45rem; background:color-mix(in srgb, var(--col-color) 15%, transparent); color:var(--text-primary); font-size:.7rem; }
	.board-scroll :global(.add-card-btn) { width:1.8rem; height:1.8rem; border:1px solid var(--border-subtle); border-radius:.55rem; background:var(--surface-raised); color:var(--text-secondary); }
	.board-scroll :global(.column-cards) { flex:none; overflow:visible; gap:.65rem; padding:.7rem; }
	.board-scroll :global(.kanban-card) { position:relative; border:1px solid var(--border-subtle); border-radius:.8rem; background:var(--surface-raised); box-shadow:0 3px 12px #00000014; }
	.board-scroll :global(.kanban-card:hover) { border-color:color-mix(in srgb, var(--accent-primary, #9b6bff) 42%, var(--border-default)); background:var(--surface-raised); box-shadow:0 9px 24px #00000024; transform:translateY(-2px); }
	.board-scroll :global(.card-priority) { width:3px; }
	.board-scroll :global(.card-content) { padding:.85rem .9rem; }
	.board-scroll :global(.card-priority-label) { display:inline-flex; align-items:center; margin-bottom:.5rem; padding:.2rem .42rem; border-radius:.4rem; background:color-mix(in srgb, var(--priority-color) 15%, transparent); color:var(--priority-color); font-size:.61rem; font-weight:750; text-transform:uppercase; letter-spacing:.07em; }
	.board-scroll :global(.card-title) { margin:0 0 .3rem; color:var(--text-primary); font-size:.91rem; line-height:1.35; }
	.board-scroll :global(.card-description) { margin:0; color:var(--text-secondary); font-size:.75rem; line-height:1.5; }
	.board-scroll :global(.claim-card) { margin-top:.6rem; border:1px solid var(--border-default); border-radius:var(--radius-md); padding:.35rem .5rem; background:var(--surface-base); color:var(--text-secondary); font-size:.7rem; }
	.board-scroll :global(.card-meta) { margin-top:.55rem; }
	.board-scroll :global(.empty-column) { flex-direction:row; justify-content:flex-start; min-height:2.55rem; padding:.55rem .7rem; border-radius:.6rem; text-align:left; font-size:.75rem; }
	.board-scroll :global(.empty-column-plus) { width:1.25rem; height:1.25rem; background:transparent; }
	.board-error { margin:.5rem clamp(1rem, 3vw, 2.25rem); padding:.65rem .85rem; border-radius:.6rem; background:color-mix(in srgb, var(--text-danger, #ef4444) 12%, var(--surface-base)); color:var(--text-danger, #ef4444); }
	.board-state { margin:1rem clamp(1rem, 3vw, 2.25rem); color:var(--text-secondary); }
	.task-backdrop { position:fixed; inset:0; z-index:var(--z-modal); background:#000a; display:grid; place-items:center; padding:1rem; backdrop-filter:blur(5px); }
	.shared-task-editor { width:min(100%, 36rem); max-height:95vh; overflow:auto; display:grid; gap:1rem; padding:1.35rem; background:var(--surface-base); color:var(--text-primary); border:1px solid var(--border-default); border-radius:1rem; box-shadow:0 25px 80px #0008; }
	.shared-task-editor header, .shared-task-editor footer { display:flex; align-items:center; justify-content:space-between; gap:.5rem; }
	.shared-task-editor h2 { margin:0; font-size:1.25rem; }
	.shared-task-editor label { display:grid; gap:.35rem; font-size:.78rem; font-weight:650; color:var(--text-secondary); }
	.shared-task-editor input, .shared-task-editor textarea, .shared-task-editor select { width:100%; box-sizing:border-box; border:1px solid var(--border-default); border-radius:.6rem; padding:.7rem .8rem; background:var(--surface-raised); color:var(--text-primary); font:inherit; font-weight:400; }
	.shared-task-editor input:focus, .shared-task-editor textarea:focus, .shared-task-editor select:focus { outline:2px solid color-mix(in srgb, var(--accent-primary, #9b6bff) 65%, transparent); outline-offset:1px; }
	.editor-grid { display:grid; grid-template-columns:1fr 1fr; gap:.75rem; }
	.shared-task-editor footer { justify-content:flex-end; padding-top:.65rem; border-top:1px solid var(--border-subtle); }
	.shared-task-editor footer button, .shared-task-editor header button { border:1px solid var(--border-default); background:var(--surface-raised); color:var(--text-primary); border-radius:.6rem; padding:.55rem .8rem; }
	.shared-task-editor footer button:last-child { border-color:transparent; background:var(--accent-primary-color, var(--accent-primary, #8754e9)); color:white; font-weight:700; }
	@media (max-width:740px) { .board-pulse { flex-wrap:wrap; gap:.8rem 1.2rem; } .pulse-progress { flex-basis:100%; max-width:none; margin-left:0; text-align:left; } .board-scroll :global(.kanban-column) { flex-basis:min(78vw, 285px); } }
	@media (max-width:520px) { .board-overview { padding:1rem 3.5rem 1rem 1rem; } .board-heading { align-items:flex-start; } .board-actions { width:100%; justify-content:flex-start; } .board-section-bar { padding-left:1rem; padding-right:3.5rem; } .editor-grid { grid-template-columns:1fr; } .shared-task-editor { padding:1rem; } }
</style>
