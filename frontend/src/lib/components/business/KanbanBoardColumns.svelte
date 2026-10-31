<script module lang="ts">
	let boardCounter = 0;
</script>

<script lang="ts">
	/**
	 * Board lanes and task cards (design contract §7.27). Used by My Planner and the shared
	 * project board.
	 *
	 * - Lane: no fill, no outline, no full-height rule. Head 44px: drawn status glyph, name, mono
	 *   count, an always-visible quiet "+" and ⋯, a hairline under it. Lanes hug their cards and
	 *   end with a quiet "Add task" row; while a card is dragged every lane stretches into a drop
	 *   target and shows a dashed slot where the card will land.
	 * - Card: on --w-lift with a hairline; title, a two-line description, one mono meta row (due
	 *   words, a High/Urgent mark, the project only when the board spans several, estimate,
	 *   sign-offs, assignee last). Done cards are quiet and dashed and show when they were done.
	 * - Keyboard (only while a card has focus): the cards are one roving tab stop; arrows move
	 *   between cards, Enter opens, M opens "Move task…", [ and ] move one lane.
	 */
	import { tick } from 'svelte';
	import { visibleKanbanColumns } from '$lib/business';
	import type { KanbanColumn, Todo, TodoStatus } from '$lib/business/types';
	import {
		cardFocusTarget,
		dueLabel,
		isClosedStatus,
		laneGlyph,
		laneLabel,
		neighbourLane,
		priorityMark,
		type CardKey,
		type DueLabel
	} from '$lib/business/plannerBoard';
	import type { MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import PlannerAvatar from './PlannerAvatar.svelte';
	import { parseAssigneeId } from '$lib/business/plannerUsers';
	import LoreRefChips from './LoreRefChips.svelte';
	import { _ } from '$lib/i18n';

	type TaskField = 'title' | 'due' | 'assignee' | 'priority';

	export let sortedTodosByColumn: Record<TodoStatus, Todo[]>;
	export let columns: KanbanColumn[] | null = null;
	export let showPriorityLabel = false;
	export let compactEmpty = false;
	export let getColumnHint: (status: TodoStatus) => string = () => '';
	export let dragOverColumn: TodoStatus | null = null;
	/** The card being dragged (its lane shows where it came from; other lanes show a drop slot). */
	export let draggingId: string | null = null;
	export let getWorkingLabel: (todo: Todo) => string = () => '';
	export let getClaimLabel: (todo: Todo) => string = () => 'Claim this task';
	export let canClaim: (todo: Todo) => boolean = () => false;
	export let claimTask: (todo: Todo) => void = () => {};
	export let isReadOnly = false;
	/** Show each card's project (a dot and its name): only when the board spans several. */
	export let showProjects = false;
	export let getPriorityColor: (priority: Todo['priority']) => string;
	export let formatEstimateHours: (minutes: number | undefined) => string;
	export let getAssigneeName: (userId: number | undefined) => string;
	export let getAssigneeColor: (userId: number | undefined) => string = () => '';
	export let getAssigneeAvatarUrl: (userId: number | undefined) => string | undefined = () => undefined;
	export let getProjectColor: (projectId: string | undefined) => string;
	export let getProjectName: (projectId: string | undefined) => string;
	/** A host's own date words (the shared board); without one the card says "Wed 23" / "Overdue · Mon 21". */
	export let formatDueDate: ((timestamp: number | undefined) => string) | null = null;
	export let isOverdue: ((timestamp: number | undefined) => boolean) | null = null;
	export let openAddModal: (column: TodoStatus) => void;
	export let handleDragOver: (event: DragEvent, status: TodoStatus) => void;
	export let handleDragLeave: (event?: DragEvent) => void;
	export let handleDrop: (event: DragEvent, status: TodoStatus) => void;
	export let handleDragStart: (event: DragEvent, todo: Todo) => void;
	export let handleDragEnd: () => void;
	export let handleCardClick: (todo: Todo) => void;
	/** Keyboard moves ([ ], Move task…). Without it the cards still open with Enter. */
	export let moveTodo: ((todo: Todo, status: TodoStatus) => void) | null = null;
	/** Opens the task dialog on one field (Move task… → Due date…, Assignee…, Priority…). */
	export let openTaskField: ((todo: Todo, field: TaskField) => void) | null = null;
	export let onHideColumn: ((status: TodoStatus) => void) | null = null;
	export let onEditColumns: (() => void) | null = null;

	const uid = `kb${++boardCounter}`;

	$: lanes = columns ?? $visibleKanbanColumns;
	$: laneIds = lanes.map((lane) => lane.id);
	$: laneModel = lanes.map((lane) => ({ id: lane.id, cards: (sortedTodosByColumn[lane.id] || []).map((todo) => todo.id) }));
	$: allIds = laneModel.flatMap((lane) => lane.cards);
	$: draggingStatus = draggingId ? findTodo(draggingId)?.status ?? null : null;

	// One tab stop for all the cards (roving tabindex): the last focused card, else the first.
	let currentId: string | null = null;
	$: tabStopId = currentId && allIds.includes(currentId) ? currentId : allIds[0] ?? null;

	let announcement = '';
	let moveOpen = false;
	let moveAnchor: HTMLElement | null = null;
	let moveTarget: Todo | null = null;

	function findTodo(id: string): Todo | undefined {
		for (const lane of lanes) {
			const found = (sortedTodosByColumn[lane.id] || []).find((todo) => todo.id === id);
			if (found) return found;
		}
		return undefined;
	}

	function cardId(id: string): string {
		return `${uid}-card-${id}`;
	}

	function laneName(status: string): string {
		const lane = lanes.find((l) => l.id === status);
		return lane ? laneLabel(lane) : status;
	}

	async function focusCard(id: string): Promise<void> {
		currentId = id;
		await tick();
		// A dialog opened from the card's menu keeps focus; the card gets it back when it closes.
		if (document.querySelector('[aria-modal="true"]')) return;
		const button = document.getElementById(cardId(id));
		button?.focus();
		button?.closest('.kanban-card')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}

	function due(todo: Todo): DueLabel | null {
		if (formatDueDate) {
			if (!todo.dueDate) return null;
			const late = Boolean(isOverdue?.(todo.dueDate)) && !isClosedStatus(todo.status);
			const text = formatDueDate(todo.dueDate);
			return { text, tone: late ? 'overdue' : 'due', title: late ? `Overdue, was due ${text}` : `Due ${text}` };
		}
		return dueLabel(todo, Date.now(), typeof document === 'undefined' ? undefined : document.documentElement.lang || undefined);
	}

	async function move(todo: Todo, status: TodoStatus): Promise<void> {
		if (!moveTodo || isReadOnly || todo.status === status) return;
		moveTodo(todo, status);
		announcement = `Moved “${todo.title}” to ${laneName(status)}`;
		await focusCard(todo.id);
	}

	function openMoveMenu(todo: Todo, anchor: HTMLElement): void {
		moveTarget = todo;
		moveAnchor = (anchor.closest('.kanban-card') as HTMLElement | null) ?? anchor;
		moveOpen = true;
	}

	$: moveItems = moveTarget ? buildMoveItems(moveTarget, laneIds, isReadOnly) : [];
	function buildMoveItems(todo: Todo, laneIds: string[], isReadOnly: boolean): MenuEntry[] {
		const back = neighbourLane(laneIds, todo.status, -1);
		const forward = neighbourLane(laneIds, todo.status, 1);
		const items: MenuEntry[] = [
			{ id: 'move-kicker', type: 'kicker', label: 'Move to' },
			...lanes.map((lane) => ({
				id: `move-${lane.id}`,
				label: laneLabel(lane),
				role: 'menuitemradio' as const,
				checked: lane.id === todo.status,
				keepCase: true,
				shortcut: lane.id === back ? '[' : lane.id === forward ? ']' : undefined,
				disabled: isReadOnly,
				onSelect: () => void move(todo, lane.id)
			}))
		];
		if (openTaskField) {
			items.push(
				{ id: 'move-sep', type: 'separator', label: '' },
				{ id: 'field-due', label: 'Due date…', icon: 'calendar', onSelect: () => openTaskField?.(todo, 'due') },
				{ id: 'field-assignee', label: 'Assignee…', icon: 'user', onSelect: () => openTaskField?.(todo, 'assignee') },
				{ id: 'field-priority', label: 'Priority…', icon: 'flag', onSelect: () => openTaskField?.(todo, 'priority') }
			);
		}
		return items;
	}

	function laneItems(column: KanbanColumn): MenuEntry[] {
		const items: MenuEntry[] = [
			{ id: 'lane-add', label: $_('planner.add_task'), icon: 'plus', disabled: isReadOnly, onSelect: () => openAddModal(column.id) }
		];
		if (onHideColumn) items.push({ id: 'lane-hide', label: 'Hide this lane', icon: 'eyeOff', disabled: lanes.length <= 1, onSelect: () => onHideColumn?.(column.id) });
		if (onEditColumns) items.push({ id: 'lane-sep', type: 'separator', label: '' }, { id: 'lane-edit', label: $_('planner.edit_columns'), icon: 'sliders', disabled: isReadOnly, onSelect: () => onEditColumns?.() });
		return items;
	}

	const ARROWS: Record<string, CardKey> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Home: 'home', End: 'end' };

	function handleCardKeydown(event: KeyboardEvent, todo: Todo): void {
		if (event.altKey || event.ctrlKey || event.metaKey) return;
		const direction = ARROWS[event.key];
		if (direction) {
			const next = cardFocusTarget(laneModel, todo.id, direction);
			event.preventDefault();
			if (next) void focusCard(next);
			return;
		}
		if (!moveTodo || isReadOnly) return;
		if (event.key === 'm' || event.key === 'M') {
			event.preventDefault();
			openMoveMenu(todo, event.currentTarget as HTMLElement);
		} else if (event.key === '[' || event.key === ']') {
			const next = neighbourLane(laneIds, todo.status, event.key === '[' ? -1 : 1);
			event.preventDefault();
			if (next) void move(todo, next as TodoStatus);
		}
	}

	function handleCardSurfaceClick(event: MouseEvent, todo: Todo): void {
		// The title button, sign-off chips and links handle their own clicks.
		if ((event.target as HTMLElement).closest('button, a, input, select, textarea')) return;
		handleCardClick(todo);
	}

	function startDrag(event: DragEvent, todo: Todo): void {
		if (isReadOnly) {
			event.preventDefault();
			return;
		}
		// The drag image is taken right after this handler: lift the card for it, then let the
		// card left behind become the quiet placeholder.
		const card = event.currentTarget as HTMLElement;
		card.classList.add('is-lifting');
		requestAnimationFrame(() => card.classList.remove('is-lifting'));
		handleDragStart(event, todo);
	}
</script>

<div class="kanban-board" class:is-dragging={Boolean(draggingId)} style="--lanes: {Math.max(lanes.length, 1)}">
	{#each lanes as column (column.id)}
		{@const cards = sortedTodosByColumn[column.id] || []}
		{@const name = laneLabel(column)}
		{@const glyph = laneGlyph(column.id)}
		<section
			class="kanban-column"
			class:drag-over={dragOverColumn === column.id && draggingStatus !== column.id}
			aria-labelledby="{uid}-lane-{column.id}"
			on:dragover={(e) => handleDragOver(e, column.id)}
			on:dragleave={(e) => handleDragLeave(e)}
			on:drop={(e) => handleDrop(e, column.id)}
		>
			<header class="column-header">
				<span class="lane-glyph lane-glyph--{glyph}" aria-hidden="true">
					{#if glyph === 'done'}<Icon name="checkCircle" size={14} />{/if}
				</span>
				<div class="column-labels">
					<h3 class="column-name" id="{uid}-lane-{column.id}">{name}</h3>
					{#if getColumnHint(column.id)}<p class="column-hint">{getColumnHint(column.id)}</p>{/if}
				</div>
				<span class="column-count"><span aria-hidden="true">{cards.length}</span><span class="sr-only">{cards.length === 1 ? '1 task' : `${cards.length} tasks`}</span></span>
				<span class="column-actions">
					<button
						type="button"
						class="w-ibtn w-ibtn--sm add-card-btn"
						on:click={() => openAddModal(column.id)}
						disabled={isReadOnly}
						aria-label={$_('planner.add_task_to', { values: { lane: name } })}
						title={isReadOnly ? 'Read-only: tasks cannot be added here' : $_('planner.add_task_to', { values: { lane: name } })}
					>
						<Icon name="plus" size={16} />
					</button>
					{#if onHideColumn || onEditColumns}
						<Menu items={laneItems(column)} label="{name} options" triggerLabel="{name} options" class="w-ibtn w-ibtn--sm column-menu-btn" align="end" heading={name}>
							<Icon name="more" size={16} />
						</Menu>
					{/if}
				</span>
			</header>
			<ul class="column-cards" aria-labelledby="{uid}-lane-{column.id}">
				{#each cards as todo (todo.id)}
					{@const closed = isClosedStatus(todo.status)}
					{@const dueText = due(todo)}
					{@const mark = priorityMark(todo.priority)}
					{@const aid = todo.assignedTo ? parseAssigneeId(todo.assignedTo) : null}
					{@const working = getWorkingLabel(todo)}
					<li class="kanban-card-item">
						<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions: the whole card is a pointer convenience; its title button is the keyboard path -->
						<div
							class="kanban-card"
							class:is-done={closed}
							class:dragging={draggingId === todo.id}
							draggable={!isReadOnly}
							on:dragstart={(e) => startDrag(e, todo)}
							on:dragend={handleDragEnd}
							on:click={(e) => handleCardSurfaceClick(e, todo)}
						>
							{#if showPriorityLabel}<span class="card-priority-label" style="--priority-color: {getPriorityColor(todo.priority)}">{todo.priority}</span>{/if}
							<h4 class="card-title">
								<button
									type="button"
									class="card-open"
									id={cardId(todo.id)}
									tabindex={todo.id === tabStopId ? 0 : -1}
									aria-describedby="{uid}-meta-{todo.id}"
									aria-keyshortcuts={moveTodo && !isReadOnly ? 'Enter M [ ]' : 'Enter'}
									on:focus={() => (currentId = todo.id)}
									on:click={() => handleCardClick(todo)}
									on:keydown={(e) => handleCardKeydown(e, todo)}
								>{todo.title}</button>
							</h4>
							{#if todo.description}
								<p class="card-description">{todo.description}</p>
							{/if}
							{#if canClaim(todo)}<button class="w-btn w-btn--sm claim-card" type="button" on:click={() => claimTask(todo)} disabled={isReadOnly}>{getClaimLabel(todo)}</button>{/if}
							<LoreRefChips refs={todo.loreRefs ?? []} />
							<div class="card-meta" id="{uid}-meta-{todo.id}">
								{#if dueText}
									<span class="card-due card-due--{dueText.tone}" title={dueText.title}>
										{#if dueText.tone === 'done'}<Icon name="check" size={14} />{:else}<Icon name="calendar" size={14} />{/if}<span class="sr-only">{dueText.title}</span><span aria-hidden="true">{dueText.text}</span>
									</span>
								{/if}
								{#if mark && !closed && !showPriorityLabel}
									<span class="card-mark"><span class="w-dot w-dot--{mark.tone}" aria-hidden="true"></span>{mark.word}</span>
								{/if}
								{#if showProjects && todo.projectId && getProjectName(todo.projectId)}
									<span class="card-project">
										<span class="card-project__dot" style="--project-dot: {getProjectColor(todo.projectId) || 'var(--w-faint)'}" aria-hidden="true"></span>{getProjectName(todo.projectId)}
									</span>
								{/if}
								{#if todo.estimatedMinutes}
									<span class="card-estimate" title="Time estimate">{formatEstimateHours(todo.estimatedMinutes)}</span>
								{/if}
								{#if (todo.signatures?.length ?? 0) > 0 || todo.signedBy}
									<span
										class="card-signed"
										title={todo.signatures?.length
											? `Signed off by ${todo.signatures.map((s) => s.name).join(', ')}`
											: `Signed by ${todo.signedBy}`}
									>
										<Icon name="pencil" size={14} /><span class="sr-only">Sign-offs: </span>{todo.signatures?.length ?? 1}
									</span>
								{/if}
								{#if working}<span class="card-working">{working}</span>{/if}
								{#if aid}
									<span class="card-assignee" title={getAssigneeName(aid)}>
										<PlannerAvatar
											name={getAssigneeName(aid)}
											color={getAssigneeColor(aid) || undefined}
											src={getAssigneeAvatarUrl(aid)}
											size="sm"
										/>
										<span class="sr-only">Assigned to {getAssigneeName(aid) || 'a member'}</span>
									</span>
								{/if}
							</div>
						</div>
					</li>
				{/each}
				{#if draggingId && dragOverColumn === column.id && draggingStatus !== column.id}
					<li class="drop-slot" aria-hidden="true"></li>
				{/if}
			</ul>
			<button
				type="button"
				class="add-task-row"
				on:click={() => openAddModal(column.id)}
				disabled={isReadOnly}
				title={isReadOnly ? 'Read-only: tasks cannot be added here' : undefined}
			>
				<Icon name="plus" size={16} /><span>{compactEmpty ? 'Add a card' : $_('planner.add_task')}</span>
			</button>
		</section>
	{/each}
</div>
<p class="sr-only" aria-live="polite">{announcement}</p>

{#if moveAnchor}
	<Menu
		items={moveItems}
		label={$_('planner.move_task')}
		anchor={moveAnchor}
		bind:open={moveOpen}
		heading={moveTarget?.title ?? 'Move task'}
		onopenchange={(open) => {
			if (!open && moveTarget) void focusCard(moveTarget.id);
		}}
	/>
{/if}
