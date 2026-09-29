import type { DocTypeDef, JobTypeDef, Pack, StateDef, TransitionDef, WorkflowDef } from './types.ts';

export class ConfigError extends Error {}

export function jobType(pack: Pack, id: string): JobTypeDef {
  const t = pack.jobTypes.find((j) => j.id === id);
  if (!t) throw new ConfigError(`Unknown job type '${id}'`);
  return t;
}

export function docType(pack: Pack, id: string): DocTypeDef {
  const t = pack.documentTypes.find((d) => d.id === id);
  if (!t) throw new ConfigError(`Unknown document type '${id}'`);
  return t;
}

export function stateOf<P extends string>(wf: WorkflowDef<P>, id: string): StateDef<P> {
  const s = wf.states.find((x) => x.id === id);
  if (!s) throw new ConfigError(`Unknown state '${id}'`);
  return s;
}

export function transitionsFrom<P extends string>(wf: WorkflowDef<P>, state: string): TransitionDef[] {
  return wf.transitions.filter((t) => t.from === '*' || t.from.includes(state));
}

/**
 * Structural validation of a pack: every referenced state/type exists and each
 * document workflow can reach 'issued' from its initial draft state.
 */
export function validatePack(pack: Pack): string[] {
  const errs: string[] = [];
  const docIds = new Set(pack.documentTypes.map((d) => d.id));
  const checkWf = (name: string, wf: WorkflowDef<string>) => {
    const ids = new Set(wf.states.map((s) => s.id));
    if (!ids.has(wf.initial)) errs.push(`${name}: initial state '${wf.initial}' missing`);
    for (const t of wf.transitions) {
      if (!ids.has(t.to)) errs.push(`${name}: transition '${t.id}' → unknown state '${t.to}'`);
      if (t.from !== '*') for (const f of t.from) if (!ids.has(f)) errs.push(`${name}: transition '${t.id}' from unknown state '${f}'`);
      for (const d of t.requires?.documents ?? []) if (!docIds.has(d.type)) errs.push(`${name}: transition '${t.id}' requires unknown document type '${d.type}'`);
    }
  };
  for (const j of pack.jobTypes) {
    checkWf(`job:${j.id}`, j.workflow);
    for (const d of j.documentTypes) if (!docIds.has(d)) errs.push(`job:${j.id}: unknown document type '${d}'`);
  }
  for (const d of pack.documentTypes) {
    checkWf(`doc:${d.id}`, d.workflow);
    const init = d.workflow.states.find((s) => s.id === d.workflow.initial);
    if (init && init.phase !== 'draft') errs.push(`doc:${d.id}: initial state must be in phase 'draft'`);
    for (const c of d.convertsTo) if (!docIds.has(c)) errs.push(`doc:${d.id}: converts to unknown type '${c}'`);
    if (d.effects.includes('stock_out') && d.effects.includes('stock_in')) errs.push(`doc:${d.id}: cannot both stock_in and stock_out`);
  }
  return errs;
}
