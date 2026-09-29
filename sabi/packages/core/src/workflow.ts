import { transitionsFrom, stateOf } from './config.ts';
import { evaluate } from './formula.ts';
import type { DocPhase, Guard, StateDef, TransitionDef, WorkflowDef } from './types.ts';

export type Missing =
  | { kind: 'field'; key: string }
  | { kind: 'document'; type: string; phase: DocPhase[] }
  | { kind: 'tasks'; open: number }
  | { kind: 'lines' }
  | { kind: 'approval'; role: string; status: 'none' | 'pending' | 'rejected' }
  | { kind: 'role'; roles: string[] };

export interface GuardContext {
  /** Values addressable by `requires.fields` (core keys + custom fields). */
  fields: Record<string, unknown>;
  /** Related documents (for job workflows). */
  documents?: { type: string; phase: DocPhase }[];
  openTasks?: number;
  lineCount?: number;
  /** Numeric metrics available to approval `when` formulas. */
  metrics?: Record<string, number>;
  /** Current, still-valid approval decisions for this subject keyed by transition id. */
  approvals?: Record<string, 'pending' | 'approved' | 'rejected'>;
  /** Acting user's role; `null` when evaluated for display only. */
  role: string | null;
  /** True if the acting user may approve for any role (owner/admin). */
  isSuperuser?: boolean;
}

export interface TransitionOption {
  transition: TransitionDef;
  target: StateDef<string>;
  ok: boolean;
  missing: Missing[];
}

const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

export function checkGuard(transition: TransitionDef, ctx: GuardContext): Missing[] {
  const g: Guard = transition.requires ?? {};
  const missing: Missing[] = [];

  if (transition.roles && ctx.role !== null && !ctx.isSuperuser && !transition.roles.includes(ctx.role)) {
    missing.push({ kind: 'role', roles: transition.roles });
  }
  for (const key of g.fields ?? []) {
    if (isEmpty(ctx.fields[key])) missing.push({ kind: 'field', key });
  }
  for (const req of g.documents ?? []) {
    const phases = Array.isArray(req.phase) ? req.phase : [req.phase];
    const found = (ctx.documents ?? []).some((d) => d.type === req.type && phases.includes(d.phase));
    if (!found) missing.push({ kind: 'document', type: req.type, phase: phases });
  }
  if (g.tasksDone && (ctx.openTasks ?? 0) > 0) missing.push({ kind: 'tasks', open: ctx.openTasks ?? 0 });
  if (g.lines && (ctx.lineCount ?? 0) === 0) missing.push({ kind: 'lines' });
  if (g.approval && approvalRequired(g.approval, ctx)) {
    const holdsRole = ctx.role !== null && (ctx.role === g.approval.role || !!ctx.isSuperuser);
    const status = ctx.approvals?.[transition.id];
    if (status !== 'approved' && !holdsRole) {
      missing.push({
        kind: 'approval',
        role: g.approval.role,
        status: status === 'pending' ? 'pending' : status === 'rejected' ? 'rejected' : 'none',
      });
    }
  }
  return missing;
}

export function approvalRequired(a: NonNullable<Guard['approval']>, ctx: GuardContext): boolean {
  if (!a.when) return true;
  return evaluate(a.when, { ...(ctx.metrics ?? {}) }) !== 0;
}

export function evaluateTransitions(
  wf: WorkflowDef<string>,
  state: string,
  ctx: GuardContext,
): TransitionOption[] {
  return transitionsFrom(wf, state)
    .filter((t) => t.to !== state)
    .map((t) => {
      const missing = checkGuard(t, ctx);
      return { transition: t, target: stateOf(wf, t.to), ok: missing.length === 0, missing };
    });
}

/**
 * The single most useful next step: the primary transition (even if blocked,
 * so the UI can explain *why*), else the first allowed forward transition.
 */
export function nextAction(options: TransitionOption[]): TransitionOption | undefined {
  const forward = options.filter((o) => o.target.phase !== 'cancelled' && o.target.phase !== 'void');
  return forward.find((o) => o.transition.primary) ?? forward.find((o) => o.ok);
}

/** Auto transitions whose guard passes (applied by the system after related changes). */
export function autoTransition(wf: WorkflowDef<string>, state: string, ctx: GuardContext): TransitionDef | undefined {
  return evaluateTransitions(wf, state, { ...ctx, role: null })
    .find((o) => o.transition.auto && o.ok)?.transition;
}

/** Ordered list of states for a progress pipeline (excludes terminal side-branches). */
export function pipeline(wf: WorkflowDef<string>): StateDef<string>[] {
  return wf.states.filter((s) => s.phase !== 'cancelled' && s.phase !== 'void');
}
