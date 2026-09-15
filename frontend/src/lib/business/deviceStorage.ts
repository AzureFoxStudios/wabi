import { writable } from 'svelte/store';
import { browser } from '$app/environment';
import { notebookOwner } from '../notes/scope';
import { plannerPersistence } from './persistence';
import { PlannerSession, type PlannerOwner } from './session';
import { getBusinessDataSnapshot, applyBusinessDataSnapshot } from './snapshot';
import { hydratePlanner, setPlannerAdmission } from './writeGate';
import { setPersistFlush, isPersistSuppressed } from './persistGate';
import * as state from './state';
import type { BusinessDataSnapshot } from './types';

export const plannerStorage = writable({ epoch: 0, loaded: false, dirty: false, error: null as string | null, legacy: false, recoveryCount: 0 });
let owner: PlannerOwner | null = null;
let session: PlannerSession | null = null;
let epoch = 0;
let applying = false;
let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const retained = new Map<string, PlannerSession>();
const empty = (): BusinessDataSnapshot => ({ todos: [], calendarEvents: [], diaryEntries: [], projects: [], sprints: [],
	kanbanColumns: structuredClone(state.DEFAULT_KANBAN_COLUMNS), resources: [], tags: [], graphEdges: [] });
function publish() {
	plannerStorage.update(s => ({ ...s, epoch, loaded: !!session, dirty: session?.dirty ?? false, error: session?.error ?? s.error }));
}
function apply(data: BusinessDataSnapshot) {
	applying = true;
	try { hydratePlanner(() => applyBusinessDataSnapshot(structuredClone(data))); }
	finally { applying = false; }
}
function changed() {
	if (applying || isPersistSuppressed() || !session || !owner?.isCurrent()) return;
	session.edit(getBusinessDataSnapshot());
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => { timer = null; void flushBusinessStorage(); }, 250);
}
export function capturePlannerSession(): { session: PlannerSession; isCurrent(): boolean } {
	const captured = session, capturedOwner = owner, ticket = epoch;
	if (!captured || !capturedOwner?.isCurrent()) throw new Error('Wait for your Planner account to load.');
	return { session: captured, isCurrent: () => epoch === ticket && session === captured && capturedOwner.isCurrent() };
}
export async function flushBusinessStorage(): Promise<boolean> {
	if (timer) { clearTimeout(timer); timer = null; }
	const captured = session;
	return captured ? captured.flush() : false;
}
async function switchOwner(next: PlannerOwner | null) {
	const ticket = ++epoch;
	if (timer) { clearTimeout(timer); timer = null; }
	const previous = session;
	if (previous?.dirty) void previous.flush(); // Captured data stays in its original account.
	owner = next; session = null;
	apply(empty());
	state.selectedProjectId.set(null); state.todoFilters.set({});
	plannerStorage.set({ epoch, loaded: false, dirty: false, error: next ? null : 'Sign in or join as a guest to open your Planner.', legacy: false, recoveryCount: 0 });
	if (!next) return;
	try {
		const scope = next.scopeId.replace(/^notebook:/, 'planner:');
		const existing = retained.get(scope);
		const record = existing?.dirty ? null : await plannerPersistence.read(scope);
		const drafts = await plannerPersistence.drafts(scope).catch(error => {
			if (existing?.dirty) return [];
			throw error;
		});
		if (ticket !== epoch || !next.isCurrent()) return;
		session = existing?.dirty ? existing : new PlannerSession(scope, record?.data ?? empty(), record?.revision ?? 0, plannerPersistence, publish);
		retained.set(scope, session);
		apply(session.data);
		let legacy = false;
		try { legacy = localStorage.getItem('business_data') !== null; } catch { /* New storage does not depend on localStorage. */ }
		plannerStorage.set({ epoch, loaded: true, dirty: session.dirty, error: session.error, legacy, recoveryCount: drafts.length });
	} catch (error) {
		if (ticket === epoch) plannerStorage.update(s => ({ ...s, error: error instanceof Error ? error.message : 'Planner storage is unavailable. Retry to open it.' }));
	}
}
export function reloadFromStorage(): void {
	if (!browser) return;
	if (started) { if (!session && owner) void switchOwner(owner); return; }
	started = true;
	setPlannerAdmission(() => !!session && !!owner?.isCurrent());
	const collections = [state.todos, state.calendarEvents, state.diaryEntries, state.projects, state.sprints,
		state.kanbanColumns, state.resources, state.tags, state.graphEdges];
	for (const collection of collections) collection.subscribe(changed);
	setPersistFlush(changed);
	notebookOwner.subscribe(({ owner: next }) => { void switchOwner(next); });
	window.addEventListener('pagehide', () => { void flushBusinessStorage(); });
	document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void flushBusinessStorage(); });
	window.addEventListener('beforeunload', event => {
		if ([...retained.values()].some(s => s.dirty)) { event.preventDefault(); event.returnValue = ''; }
	});
}
export function downloadPlannerData(data: unknown, name = 'wabi-planner-backup'): void {
	const bytes = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
	const url = URL.createObjectURL(new Blob([bytes], { type: 'application/json' }));
	const a = document.createElement('a'); a.href = url; a.download = `${name}.json`; a.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function downloadLegacyPlanner(): void {
	const raw = localStorage.getItem('business_data');
	if (raw === null) throw new Error('No older Planner data was found.');
	downloadPlannerData(raw, 'wabi-planner-unassigned-original');
}
export async function downloadPlannerRecovery(): Promise<void> {
	const captured = capturePlannerSession();
	const drafts = await plannerPersistence.drafts(captured.session.scope);
	if (!captured.isCurrent()) throw new Error('Your Planner account changed.');
	downloadPlannerData({ format: 'wabi-planner-recovery', drafts, currentDraft: captured.session.data }, 'wabi-planner-recovery');
}
/** User explicitly keeps a downloadable draft before replacing the active view. */
export async function keepDraftAndReload(): Promise<void> {
	const captured = capturePlannerSession();
	downloadPlannerData({ ...captured.session.data, version: '1.0', sourceScope: captured.session.scope }, 'wabi-planner-unsaved-draft');
	const record = await plannerPersistence.read(captured.session.scope);
	if (!captured.isCurrent()) return;
	// Download is explicit; conflicts also have independent durable recovery copies.
	retained.delete(captured.session.scope);
	session = new PlannerSession(captured.session.scope, record?.data ?? empty(), record?.revision ?? 0, plannerPersistence, publish);
	retained.set(session.scope, session); apply(session.data);
	plannerStorage.update(s => ({ ...s, error: null })); publish();
}
