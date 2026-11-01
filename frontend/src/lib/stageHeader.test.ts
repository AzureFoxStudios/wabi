import { beforeEach, expect, mock, test } from 'bun:test';
import { get, writable } from 'svelte/store';
import type { WorkspaceViewKey } from './components/chat/types';

// The real navigation state pulls in sockets and storage; the header only needs the active view.
const activeWorkspaceView = writable<WorkspaceViewKey>('messages');
mock.module('./workspaceNavigationState', () => ({ activeWorkspaceView, selectWorkspaceView: () => {} }));
const { createStageHeaderStore, stageHeader, setStageHeader, clearStageHeader } = await import('./stageHeader');

const view = writable<WorkspaceViewKey>('messages');
let store = createStageHeaderStore(view);

beforeEach(() => {
	view.set('messages');
	store = createStageHeaderStore(view);
});

test('nothing registered means no header, so the StageBar keeps its defaults', () => {
	expect(get(store.stageHeader)).toBeNull();
});

test('a header belongs to the view active when it is set and is normalized for the bar', () => {
	view.set('planner');
	const onSelect = () => {};
	store.setStageHeader('planner', {
		title: 'My Planner', scope: ' Only you · this device ', status: ' Saved 09:41 ',
		actions: [{ id: 'new-task', label: 'New task', variant: 'primary', onSelect }]
	});
	expect(get(store.stageHeader)).toEqual({
		owner: 'planner', view: 'planner', title: 'My Planner',
		scope: [{ label: 'Only you · this device', kind: 'scope' }], status: 'Saved 09:41',
		actions: [{ id: 'new-task', label: 'New task', variant: 'primary', onSelect }], component: null, props: {}
	});
	view.set('messages');
	expect(get(store.stageHeader)).toBeNull();
	view.set('planner');
	expect(get(store.stageHeader)?.title).toBe('My Planner');
});

test('scope accepts one tag or several, keeping seal and maturity kinds and dropping blanks', () => {
	view.set('documents');
	store.setStageHeader('editor', {
		title: 'Field notes',
		scope: [{ label: 'PREVIEW', kind: 'maturity' }, { label: 'Server-readable', kind: 'seal', title: 'The server operator can read this document.' }, { label: 'Shared · Editor' }, { label: '  ' }]
	});
	expect(get(store.stageHeader)?.scope).toEqual([
		{ label: 'PREVIEW', kind: 'maturity' },
		{ label: 'Server-readable', kind: 'seal', title: 'The server operator can read this document.' },
		{ label: 'Shared · Editor', kind: 'scope' }
	]);
	store.setStageHeader('editor', { title: 'Field notes', scope: { label: 'Private · this device' }, status: '   ' });
	expect(get(store.stageHeader)?.scope).toEqual([{ label: 'Private · this device', kind: 'scope' }]);
	expect(get(store.stageHeader)?.status).toBeNull();
});

test('last writer wins per active view, and clearing reveals the previous owner', () => {
	store.setStageHeader('chat', { title: 'general' });
	store.setStageHeader('forum', { title: 'Show and tell' });
	expect(get(store.stageHeader)?.owner).toBe('forum');
	store.clearStageHeader('forum');
	expect(get(store.stageHeader)?.owner).toBe('chat');
	store.clearStageHeader('chat');
	expect(get(store.stageHeader)).toBeNull();
	store.clearStageHeader('never-registered');
	expect(get(store.stageHeader)).toBeNull();
});

test('an in-place update keeps its position instead of taking the masthead back', () => {
	store.setStageHeader('chat', { title: 'general' });
	store.setStageHeader('search', { title: 'Search in #general' });
	store.setStageHeader('chat', { title: 'general', status: '3 online' });
	expect(get(store.stageHeader)?.owner).toBe('search');
	store.clearStageHeader('search');
	expect(get(store.stageHeader)).toMatchObject({ owner: 'chat', status: '3 online' });
});

test('owners on other views never relabel the active workspace', () => {
	view.set('documents');
	store.setStageHeader('documents', { title: 'Field notes' });
	view.set('messages');
	store.setStageHeader('chat', { title: 'general' });
	// A late async update from the documents owner stays with Documents.
	store.setStageHeader('documents', { title: 'Field notes', status: 'Saved 09:42', view: 'documents' });
	expect(get(store.stageHeader)?.owner).toBe('chat');
	view.set('documents');
	expect(get(store.stageHeader)).toMatchObject({ owner: 'documents', status: 'Saved 09:42' });
});

test('an owner that follows the view moves its header (and goes on top there)', () => {
	view.set('whiteboard');
	store.setStageHeader('board-tools', { title: 'Board tools' });
	view.set('messages');
	store.setStageHeader('board-tools', { title: 'Board tools' });
	store.setStageHeader('chat', { title: 'general' });
	expect(get(store.stageHeader)?.owner).toBe('chat');
	store.setStageHeader('chat', { title: 'Whiteboard', view: 'whiteboard' });
	view.set('whiteboard');
	expect(get(store.stageHeader)).toMatchObject({ owner: 'chat', title: 'Whiteboard', view: 'whiteboard' });
	view.set('messages');
	expect(get(store.stageHeader)?.owner).toBe('board-tools');
});

test('a custom row A component and its props pass through unchanged', () => {
	const EditorHeader = (() => ({})) as unknown as import('svelte').Component<{ tool: string }>;
	const props = { tool: 'documents' };
	view.set('documents');
	store.setStageHeader('editor', { title: 'Field notes', component: EditorHeader, props });
	expect(get(store.stageHeader)?.component).toBe(EditorHeader);
	expect(get(store.stageHeader)?.props).toBe(props);
});

test('identical updates do not notify subscribers; real changes do', () => {
	const actions = [{ id: 'search', label: 'Search', icon: 'search' as const, iconOnly: true, onSelect: () => {} }];
	let notifications = 0;
	const stop = store.stageHeader.subscribe(() => notifications++);
	store.setStageHeader('chat', { title: 'general', scope: 'Shared', actions });
	store.setStageHeader('chat', { title: 'general', scope: 'Shared', actions });
	store.setStageHeader('chat', { title: 'general', scope: { label: 'Shared' }, actions });
	expect(notifications).toBe(2);
	store.setStageHeader('chat', { title: 'random', scope: 'Shared', actions });
	expect(notifications).toBe(3);
	stop();
});

test('an empty owner is ignored', () => {
	store.setStageHeader('', { title: 'Nobody' });
	expect(get(store.stageHeader)).toBeNull();
});

test('the shared store follows the active workspace view', () => {
	activeWorkspaceView.set('notes');
	setStageHeader('notes', { title: 'Notes', scope: 'Only you · this device' });
	expect(get(stageHeader)).toMatchObject({ owner: 'notes', view: 'notes', title: 'Notes' });
	activeWorkspaceView.set('messages');
	expect(get(stageHeader)).toBeNull();
	activeWorkspaceView.set('notes');
	clearStageHeader('notes');
	expect(get(stageHeader)).toBeNull();
});
