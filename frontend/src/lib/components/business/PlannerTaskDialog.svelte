<!--
	The Planner task dialog opened from outside the board (design contract §8.6): the Calendar
	(a task title opens the task, it never completes it) and the Tasks companion panel (+ and a
	row's title). It is the same KanbanTaskModal the board's "New task" uses; this wrapper only
	owns the form state, so every place edits a task the same way and saves the same fields.

	  <PlannerTaskDialog todo={task} onclose={() => (task = null)} />
	  <PlannerTaskDialog todo={null} status="todo" onclose={…} />   (a new task)
-->
<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { plannerActor as currentUser } from '$lib/business/personalWorkspace';
	import { plannerUserById, ensurePlannerDirectory } from '$lib/business/plannerUsers';
	import { addTodo, deleteTodo, updateTodo } from '$lib/business/store';
	import type { Todo, TodoStatus } from '$lib/business/types';
	import { completedAtFor, dateInputValue, dueDateForSave } from '$lib/business/plannerBoard';
	import { confirmAction } from '$lib/confirm';
	import KanbanTaskModal from './KanbanTaskModal.svelte';

	interface RegisteredUser {
		user_id: number;
		username: string;
		profile_picture?: string;
		color: string;
	}

	interface Props {
		/** The task to edit, or null for a new one. */
		todo: Todo | null;
		/** Lane of a new task. */
		status?: TodoStatus;
		/** Due day of a new task (a timestamp), e.g. "Add task on 23 September". */
		dueDate?: number;
		/** Project of a new task (a project page's Board). */
		projectId?: string;
		isReadOnly?: boolean;
		onclose: () => void;
	}

	let { todo, status = 'todo', dueDate, projectId, isReadOnly = false, onclose }: Props = $props();

	// The dialog edits a snapshot of the task taken when it opens.
	const opened = untrack(() => ({ todo, status, dueDate, projectId }));
	const editing = opened.todo;
	const minutes = editing?.estimatedMinutes;
	const hasEstimate = typeof minutes === 'number' && minutes > 0;
	let targetColumn = $state<TodoStatus>(editing?.status ?? opened.status);
	let formTitle = $state(editing?.title ?? '');
	let formDescription = $state(editing?.description ?? '');
	let formPriority = $state<Todo['priority']>(editing?.priority ?? 'medium');
	let formProjectId = $state<string | null>(editing ? (editing.projectId ?? null) : (opened.projectId ?? null));
	let formDueDate = $state(dateInputValue(editing ? editing.dueDate : opened.dueDate));
	let formAssigneeId = $state<number | null>(editing?.assignedTo ? Number.parseInt(String(editing.assignedTo), 10) || null : null);
	let formHasTimeEstimate = $state(hasEstimate);
	let formEstimatedHours = $state(hasEstimate ? String((minutes as number) / 60) : '1');
	let draftSignatures = $state<NonNullable<Todo['signatures']>>(editing?.signatures ? [...editing.signatures] : []);
	const legacySignedBy = editing?.signatures?.length ? undefined : editing?.signedBy;
	let draftLoreRefs = $state<NonNullable<Todo['loreRefs']>>(editing?.loreRefs ? [...editing.loreRefs] : []);
	let userSearchQuery = $state('');
	let showUserDropdown = $state(false);

	ensurePlannerDirectory();
	const registeredUsers = $derived<RegisteredUser[]>([...$plannerUserById.values()]);
	const filteredUsers = $derived(
		userSearchQuery.trim()
			? registeredUsers.filter((u) => u.username.toLowerCase().includes(userSearchQuery.trim().toLowerCase()))
			: registeredUsers
	);

	function filterUsers(query: string): void {
		userSearchQuery = query;
	}
	function selectUser(user: RegisteredUser): void {
		formAssigneeId = user.user_id;
		showUserDropdown = false;
		userSearchQuery = '';
	}
	function clearAssignee(): void {
		formAssigneeId = null;
		userSearchQuery = '';
	}
	function getAssigneeName(userId: number | undefined): string {
		return userId ? ($plannerUserById.get(userId)?.username ?? '') : '';
	}

	function handleSubmit(): void {
		if (!formTitle.trim() || isReadOnly) return;
		const hours = Number.parseFloat(formEstimatedHours);
		const signatures = draftSignatures.length > 0 ? [...draftSignatures] : undefined;
		const data = {
			title: formTitle.trim(),
			description: formDescription.trim() || undefined,
			priority: formPriority,
			estimatedMinutes: formHasTimeEstimate && Number.isFinite(hours) && hours > 0 ? Math.max(1, Math.round(hours * 60)) : undefined,
			projectId: formProjectId || undefined,
			dueDate: dueDateForSave(formDueDate, editing?.dueDate),
			status: targetColumn,
			completedAt: completedAtFor(targetColumn, editing?.completedAt),
			assignedTo: formAssigneeId ? String(formAssigneeId) : undefined,
			signatures,
			loreRefs: draftLoreRefs.length > 0 ? [...draftLoreRefs] : undefined,
			// Legacy single-signer mirror (first signer's name) for older clients.
			signedBy: signatures?.[0]?.name
		};
		if (editing) {
			updateTodo(editing.id, data);
		} else {
			const actor = $currentUser;
			addTodo({ ...data, createdBy: actor?.dbUserId ? String(actor.dbUserId) : (actor?.id ?? 'unknown') });
		}
		onclose();
	}

	async function handleDelete(task: Todo): Promise<void> {
		const confirmed = await confirmAction({
			title: 'Delete this task?',
			body: `“${task.title}” will be removed from your Planner.`,
			confirm: 'Delete task',
			danger: true
		});
		if (!confirmed) return;
		deleteTodo(task.id);
		await tick();
		onclose();
	}
</script>

<KanbanTaskModal
	editingTodo={editing}
	{isReadOnly}
	{registeredUsers}
	{filteredUsers}
	bind:showUserDropdown
	bind:formTitle
	bind:formDescription
	bind:formPriority
	bind:formProjectId
	bind:formDueDate
	bind:formAssigneeId
	bind:formHasTimeEstimate
	bind:formEstimatedHours
	bind:draftSignatures
	{legacySignedBy}
	bind:draftLoreRefs
	bind:userSearchQuery
	bind:targetColumn
	closeModal={onclose}
	{handleSubmit}
	{handleDelete}
	{filterUsers}
	{selectUser}
	{clearAssignee}
	{getAssigneeName}
/>
