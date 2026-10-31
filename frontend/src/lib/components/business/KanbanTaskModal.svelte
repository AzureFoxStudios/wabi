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
		assignee: '#planner-task-assignee, #planner-task-assignee-clear',
		priority: '#planner-task-priority'
	};

	let linksUnread = 0;
	let assigneeHighlight = -1;

	$: statusOptions = $kanbanColumns.map((col) => ({ value: col.id, label: laneLabel(col) })) satisfies SelectOption[];
	const priorityOptions: SelectOption[] = [
		{ value: 'low', label: 'Low' },
		{ value: 'medium', label: 'Medium' },
		{ value: 'high', label: 'High' },
		{ value: 'urgent', label: 'Urgent' }
	];
	$: projectOptions = [
		{ value: '', label: 'No project' },
		...$projects.map((project) => ({ value: project.id, label: project.name }))
	] satisfies SelectOption[];

	// The kit select works on strings; the board keeps `null` for "no project".
	let projectValue = formProjectId ?? '';
	$: formProjectId = projectValue || null;
	let statusValue: string = targetColumn;
	$: targetColumn = statusValue as TodoStatus;
	let priorityValue: string = formPriority;
	$: formPriority = priorityValue as Todo['priority'];

	$: assigneeName = formAssigneeId ? getAssigneeName(formAssigneeId) || `Member ${formAssigneeId}` : '';
	$: titleMissing = formTitle.trim() === '';

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

	function handleAssigneeKeydown(event: KeyboardEvent): void {
		if (!showUserDropdown || filteredUsers.length === 0) {
			if (event.key === 'ArrowDown') {
				showUserDropdown = true;
				event.preventDefault();
			}
			return;
		}
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			const step = event.key === 'ArrowDown' ? 1 : -1;
			assigneeHighlight = (assigneeHighlight + step + filteredUsers.length) % filteredUsers.length;
		} else if (event.key === 'Enter' && assigneeHighlight >= 0) {
			event.preventDefault();
			selectUser(filteredUsers[assigneeHighlight]);
			assigneeHighlight = -1;
		} else if (event.key === 'Escape') {
			// Close the list, not the dialog.
			event.preventDefault();
			event.stopPropagation();
			showUserDropdown = false;
			assigneeHighlight = -1;
		}
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
	title={editingTodo ? 'Edit task' : $_('planner.new_task')}
	note={isReadOnly ? 'Read-only: changes cannot be saved here' : ''}
	initialFocus={FIELD_SELECTOR[initialField]}
	panelClass="planner-task-dialog"
>
	<form id="planner-task-form" class="ptd-form" on:submit|preventDefault={submit} novalidate use:watchScroll>
		<div class="ptd-field">
			<label class="w-label" for="planner-task-title">Title</label>
			<input
				id="planner-task-title"
				class="w-field"
				type="text"
				bind:value={formTitle}
				placeholder="What needs doing?"
				required
				aria-required="true"
				maxlength="300"
				disabled={isReadOnly}
			/>
		</div>

		<div class="ptd-field">
			<label class="w-label" for="planner-task-description">Description</label>
			<textarea id="planner-task-description" class="w-field" bind:value={formDescription} placeholder="Add details, links or notes" rows="3" disabled={isReadOnly}></textarea>
		</div>

		<div class="ptd-pair">
			<div class="ptd-field">
				<span class="w-label" id="planner-task-status-label">Status</span>
				<Select id="planner-task-status" ariaLabel="Status" options={statusOptions} bind:value={statusValue} disabled={isReadOnly} heading="Status" class="ptd-select" />
			</div>
			<div class="ptd-field">
				<span class="w-label" id="planner-task-priority-label">Priority</span>
				<Select id="planner-task-priority" ariaLabel="Priority" options={priorityOptions} bind:value={priorityValue} disabled={isReadOnly} heading="Priority" class="ptd-select" />
			</div>
		</div>

		<div class="ptd-pair">
			<div class="ptd-field ptd-assignee">
				<label class="w-label" for={formAssigneeId ? 'planner-task-assignee-clear' : 'planner-task-assignee'}>Assignee</label>
				{#if formAssigneeId}
					<div class="ptd-assigned">
						<span class="ptd-assigned__name">{assigneeName}</span>
						<button
							type="button"
							id="planner-task-assignee-clear"
							class="w-ibtn w-ibtn--sm"
							on:click={clearAssignee}
							disabled={isReadOnly}
							aria-label="Remove {assigneeName} as assignee"
						><Icon name="x" size={16} /></button>
					</div>
				{:else}
					<div class="ptd-combo">
						<input
							id="planner-task-assignee"
							class="w-field"
							type="text"
							role="combobox"
							aria-expanded={showUserDropdown && filteredUsers.length > 0}
							aria-controls="planner-task-assignee-list"
							aria-autocomplete="list"
							aria-activedescendant={assigneeHighlight >= 0 ? `planner-task-assignee-${filteredUsers[assigneeHighlight]?.user_id}` : undefined}
							bind:value={userSearchQuery}
							on:input={(e) => { filterUsers((e.target as HTMLInputElement).value); assigneeHighlight = -1; showUserDropdown = true; }}
							on:focus={() => (showUserDropdown = true)}
							on:keydown={handleAssigneeKeydown}
							placeholder={registeredUsers.length ? 'Search people' : 'No one to assign yet'}
							autocomplete="off"
							disabled={isReadOnly}
						/>
						{#if showUserDropdown && filteredUsers.length > 0}
							<ul class="ptd-combo__list w-pop" id="planner-task-assignee-list" role="listbox" aria-label="People">
								{#each filteredUsers as user, index (user.user_id)}
									<li
										id="planner-task-assignee-{user.user_id}"
										role="option"
										aria-selected={index === assigneeHighlight}
										class="ptd-combo__option"
										class:is-active={index === assigneeHighlight}
										on:mousedown|preventDefault={() => selectUser(user)}
									>{user.username}</li>
								{/each}
							</ul>
						{/if}
					</div>
				{/if}
			</div>
			<div class="ptd-field">
				<span class="w-label" id="planner-task-project-label">Project</span>
				<Select id="planner-task-project" ariaLabel="Project" options={projectOptions} bind:value={projectValue} disabled={isReadOnly} heading="Project" class="ptd-select" />
			</div>
		</div>

		<div class="ptd-field ptd-field--date">
			<label class="w-label" for="planner-task-due">Due date</label>
			<input id="planner-task-due" class="w-field" type="date" bind:value={formDueDate} disabled={isReadOnly} />
		</div>

		<div class="w-srow ptd-srow">
			<div class="w-srow__text">
				<span class="w-srow__label" id="planner-task-estimate-label">{$_('planner.time_estimate')}</span>
				<span class="w-srow__hint" id="planner-task-estimate-hint">Used for the project burndown</span>
			</div>
			<Switch bind:checked={formHasTimeEstimate} labelledby="planner-task-estimate-label" describedby="planner-task-estimate-hint" disabled={isReadOnly} />
		</div>
		{#if formHasTimeEstimate}
			<div class="ptd-field ptd-field--hours">
				<label class="w-label" for="planner-task-hours">Hours</label>
				<input id="planner-task-hours" class="w-field" type="number" min="0.25" step="0.25" inputmode="decimal" bind:value={formEstimatedHours} disabled={isReadOnly} />
			</div>
		{/if}

		<div class="ptd-field ptd-signatures">
			<SignatureRow bind:draftSignatures {legacySignedBy} label="Names attached" disabled={isReadOnly} />
		</div>

		<div class="ptd-field">
			<label class="w-label" for="planner-task-links">Project file links</label>
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
					<span class="w-field-error" id="planner-task-links-error"><Icon name="alert" size={14} />{linksUnread === 1 ? 'One link is not a Project file link and was left out.' : `${linksUnread} links are not Project file links and were left out.`}</span>
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
		<button type="button" class="w-btn w-btn--quiet" on:click={closeModal}>Cancel</button>
		<button type="submit" form="planner-task-form" class="w-btn w-btn--primary" disabled={isReadOnly || titleMissing}>
			{editingTodo ? 'Save' : $_('planner.add_task')}
		</button>
	</footer>
</BaseModal>
