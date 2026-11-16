<script module lang="ts">
	/** The field the dialog opens on ("Move task…" → Due date… / Assignee… / Priority…). */
	export type TaskField = 'title' | 'due' | 'assignee' | 'priority';
</script>

<script lang="ts">
	/**
	 * The task dialog (design contract §7.13, §8.6): BaseModal md (560) with kit fields. Title,
	 * description, kit selects for Status / Priority / Assignee / Project, a due date, a "Time
	 * estimate" switch row, sign-offs and project file links. Footer: Delete task (danger) at the
	 * left when editing, then a quiet Cancel and the primary Save.
	 *
	 * The form state stays with the board (two-way bound), so the dialog is presentation only.
	 * BaseModal traps focus, closes on Esc, and returns focus to the card or button that opened it.
	 *
	 * Assignee is a kit select like Status, Priority and Project (its menu has typeahead). The
	 * older combobox props (filteredUsers, showUserDropdown, userSearchQuery, filterUsers) are
	 * still accepted so hosts that bind them keep working; the select does not need them.
	 */
	import { kanbanColumns, projects } from '$lib/business';
	import type { Todo, TodoStatus, ItemSignature, LoreCitationRef } from '$lib/business/types';
	import { formatFileLinks, laneLabel, parseFileLinks } from '$lib/business/plannerBoard';
	import { _ } from '$lib/i18n';
	import BaseModal from '$lib/components/BaseModal.svelte';
	import Select, { type SelectOption } from '$lib/components/ui/Select.svelte';
	import Switch from '$lib/components/ui/Switch.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import SignatureRow from './SignatureRow.svelte';
	import LoreRefChips from './LoreRefChips.svelte';

	interface RegisteredUser {
		user_id: number;
		username: string;
		profile_picture?: string;
		color: string;
	}

	export let editingTodo: Todo | null = null;
	export let isReadOnly = false;
	export let initialField: TaskField = 'title';
	export let registeredUsers: RegisteredUser[] = [];
	export let filteredUsers: RegisteredUser[] = [];
	export let showUserDropdown = false;
	export let formTitle = '';
	export let formDescription = '';
	export let formPriority: Todo['priority'] = 'medium';
	export let formProjectId: string | null = null;
	export let formDueDate = '';
	export let formAssigneeId: number | null = null;
	export let formHasTimeEstimate = false;
	export let formEstimatedHours = '1';
	/** Draft sign-offs (two-way bound with the host form). */
	export let draftSignatures: ItemSignature[] = [];
	/** Legacy read-only signer shown when the item predates multi-sign. */
	export let legacySignedBy: string | undefined = undefined;
	/** Draft project file links (two-way bound with the host form). */
	export let draftLoreRefs: LoreCitationRef[] = [];
	export let userSearchQuery = '';
	export let targetColumn: TodoStatus = 'todo';
	export let closeModal: () => void;
	export let handleSubmit: () => void;
	export let handleDelete: (todo: Todo) => void;
	export let filterUsers: (query: string) => void;
	export let selectUser: (user: RegisteredUser) => void;
	export let clearAssignee: () => void;
	export let getAssigneeName: (userId: number | undefined) => string;

	const FIELD_SELECTOR: Record<TaskField, string> = {
		title: '#planner-task-title',
		due: '#planner-task-due',
		assignee: '#planner-task-assignee',
		priority: '#planner-task-priority'
	};

	let linksUnread = 0;
	// The combobox state the hosts still bind (see above); read here so the props stay declared.
	$: void filteredUsers, showUserDropdown, userSearchQuery, filterUsers;

	$: statusOptions = $kanbanColumns.map((col) => ({ value: col.id, label: laneLabel(col) })) satisfies SelectOption[];
	const priorityOptions: SelectOption[] = [
		{ value: 'low', label: $_('kanban_task.low') },
		{ value: 'medium', label: $_('kanban_task.medium') },
		{ value: 'high', label: $_('kanban_task.high') },
		{ value: 'urgent', label: $_('kanban_task.urgent') }
	];
	$: projectOptions = [
		{ value: '', label: $_('kanban_task.no_project') },
		...$projects.map((project) => ({ value: project.id, label: project.name }))
	] satisfies SelectOption[];

	// The kit select works on strings; the board keeps `null` for "no project".
	let projectValue = formProjectId ?? '';
	$: formProjectId = projectValue || null;
	let statusValue: string = targetColumn;
	$: targetColumn = statusValue as TodoStatus;
	let priorityValue: string = formPriority;
	$: formPriority = priorityValue as Todo['priority'];

	$: titleMissing = formTitle.trim() === '';

	// Assignee: "Unassigned" or one person from the directory. A saved assignee the directory
	// does not know (yet) stays listed by name, so opening the dialog never drops it.
	let assigneeValue = formAssigneeId ? String(formAssigneeId) : '';
	$: assigneeOptions = buildAssigneeOptions(registeredUsers, formAssigneeId);
	function buildAssigneeOptions(users: RegisteredUser[], current: number | null): SelectOption[] {
		const people = [...users]
			.sort((a, b) => a.username.localeCompare(b.username))
			.map((user) => ({ value: String(user.user_id), label: user.username }));
		if (current && !users.some((user) => user.user_id === current)) {
			people.unshift({ value: String(current), label: getAssigneeName(current) || $_('kanban_task.member', { values: { id: current } }) });
		}
		return [{ value: '', label: $_('kanban_task.unassigned') }, ...people];
	}
	function chooseAssignee(value: string): void {
		const user = registeredUsers.find((candidate) => String(candidate.user_id) === value);
		if (user) selectUser(user);
		else if (!value) clearAssignee();
		else formAssigneeId = Number(value);
	}

	/** Parse "ch_abc ^c/path/file.ts:12" style input back into refs. */
	function handleRefsInput(event: Event): void {
		const raw = (event.target as HTMLInputElement).value.trim();
		if (!raw) {
			draftLoreRefs = [];
			linksUnread = 0;
			return;
		}
		const parsed = parseFileLinks(raw);
		draftLoreRefs = parsed.refs;
		linksUnread = parsed.unread;
	}

	/** The footer's hairline shows only while the body scrolls (§7.13). */
	let bodyScrolls = false;
	function watchScroll(form: HTMLElement) {
		const body = form.closest('.base-modal__body') as HTMLElement | null;
		if (!body) return {};
		const measure = () => (bodyScrolls = body.scrollHeight > body.clientHeight + 1);
		measure();
		const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
		observer?.observe(body);
		observer?.observe(form);
		return { destroy: () => observer?.disconnect() };
	}

	function submit(): void {
		if (titleMissing || isReadOnly) return;
		handleSubmit();
	}
</script>

<BaseModal
	isOpen={true}
	onClose={closeModal}
	size="md"
	padded
	title={editingTodo ? $_('kanban_task.edit_title') : $_('planner.new_task')}
	note={isReadOnly ? $_('kanban_task.read_only_note') : ''}
	initialFocus={FIELD_SELECTOR[initialField]}
	panelClass="planner-task-dialog"
>
	<form id="planner-task-form" class="ptd-form" on:submit|preventDefault={submit} novalidate use:watchScroll>
		<div class="ptd-field">
			<label class="w-label" for="planner-task-title">{$_('kanban_task.title')}</label>
			<input
				id="planner-task-title"
				class="w-field"
				type="text"
				bind:value={formTitle}
				placeholder={$_('kanban_task.title_ph')}
				required
				aria-required="true"
				maxlength="300"
				disabled={isReadOnly}
			/>
		</div>

		<div class="ptd-field">
			<label class="w-label" for="planner-task-description">{$_('kanban_task.description')}</label>
			<textarea id="planner-task-description" class="w-field" bind:value={formDescription} placeholder={$_('kanban_task.description_ph')} rows="3" disabled={isReadOnly}></textarea>
		</div>

		<div class="ptd-pair">
			<div class="ptd-field">
				<span class="w-label" id="planner-task-status-label">{$_('kanban_task.status')}</span>
				<Select id="planner-task-status" ariaLabel={$_('kanban_task.status')} options={statusOptions} bind:value={statusValue} disabled={isReadOnly} heading={$_('kanban_task.status')} class="ptd-select" />
			</div>
			<div class="ptd-field">
				<span class="w-label" id="planner-task-priority-label">{$_('kanban_task.priority')}</span>
				<Select id="planner-task-priority" ariaLabel={$_('kanban_task.priority')} options={priorityOptions} bind:value={priorityValue} disabled={isReadOnly} heading={$_('kanban_task.priority')} class="ptd-select" />
			</div>
		</div>

		<div class="ptd-pair">
			<div class="ptd-field ptd-assignee">
				<span class="w-label" id="planner-task-assignee-label">{$_('kanban_task.assignee')}</span>
				<Select
					id="planner-task-assignee"
					ariaLabel={$_('kanban_task.assignee')}
					options={assigneeOptions}
					bind:value={assigneeValue}
					onchange={chooseAssignee}
					disabled={isReadOnly}
					heading={$_('kanban_task.assignee')}
					class="ptd-select"
				/>
			</div>
			<div class="ptd-field">
				<span class="w-label" id="planner-task-project-label">{$_('kanban_task.project')}</span>
				<Select id="planner-task-project" ariaLabel={$_('kanban_task.project')} options={projectOptions} bind:value={projectValue} disabled={isReadOnly} heading={$_('kanban_task.project')} class="ptd-select" />
			</div>
		</div>

		<div class="ptd-field ptd-field--date">
			<label class="w-label" for="planner-task-due">{$_('kanban_task.due_date')}</label>
			<input id="planner-task-due" class="w-field" type="date" bind:value={formDueDate} disabled={isReadOnly} />
		</div>

		<div class="w-srow ptd-srow">
			<div class="w-srow__text">
				<span class="w-srow__label" id="planner-task-estimate-label">{$_('planner.time_estimate')}</span>
				<span class="w-srow__hint" id="planner-task-estimate-hint">{$_('kanban_task.burndown_hint')}</span>
			</div>
			<Switch bind:checked={formHasTimeEstimate} labelledby="planner-task-estimate-label" describedby="planner-task-estimate-hint" disabled={isReadOnly} />
		</div>
		{#if formHasTimeEstimate}
			<div class="ptd-field ptd-field--hours">
				<label class="w-label" for="planner-task-hours">{$_('kanban_task.hours')}</label>
				<input id="planner-task-hours" class="w-field" type="number" min="0.25" step="0.25" inputmode="decimal" bind:value={formEstimatedHours} disabled={isReadOnly} />
			</div>
		{/if}

		<div class="ptd-field ptd-signatures">
			<SignatureRow bind:draftSignatures {legacySignedBy} label={$_('sprint_modal.names_attached')} disabled={isReadOnly} />
		</div>

		<div class="ptd-field">
			<label class="w-label" for="planner-task-links">{$_('kanban_task.file_links')}</label>
			<input
				id="planner-task-links"
				class="w-field"
				type="text"
				value={formatFileLinks(draftLoreRefs)}
				on:change={handleRefsInput}
				placeholder={$_('planner.file_link_placeholder')}
				aria-invalid={linksUnread > 0}
				aria-describedby={linksUnread > 0 ? 'planner-task-links-error' : undefined}
				disabled={isReadOnly}
			/>
			{#if linksUnread > 0}
				<div class="w-field-foot">
					<span class="w-field-error" id="planner-task-links-error"><Icon name="alert" size={14} />{linksUnread === 1 ? $_('kanban_task.one_link') : $_('kanban_task.many_links', { values: { count: linksUnread } })}</span>
				</div>
			{/if}
			{#if draftLoreRefs.length > 0}
				<div class="ptd-links">
					<LoreRefChips refs={draftLoreRefs} size="sm" />
				</div>
			{/if}
		</div>
	</form>

	<footer class="w-dialog__foot ptd-foot" class:w-dialog__foot--rule={bodyScrolls} slot="footer">
		{#if editingTodo}
			<button
				type="button"
				class="w-btn w-btn--danger w-dialog__foot-start"
				on:click={() => editingTodo && handleDelete(editingTodo)}
				disabled={isReadOnly}
			>{$_('planner.delete_task')}</button>
		{/if}
		<button type="button" class="w-btn w-btn--quiet" on:click={closeModal}>{$_('common.cancel')}</button>
		<button type="submit" form="planner-task-form" class="w-btn w-btn--primary" disabled={isReadOnly || titleMissing}>
			{editingTodo ? $_('common.save') : $_('planner.add_task')}
		</button>
	</footer>
</BaseModal>
