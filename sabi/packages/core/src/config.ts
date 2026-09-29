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
  const roleIds = new Set(pack.roles.map((r) => r.id));
  const checkWf = (name: string, wf: WorkflowDef<string>, money = false) => {
    const ids = new Set(wf.states.map((s) => s.id));
    if (ids.size !== wf.states.length) errs.push(`${name}: duplicate state ids`);
    if (new Set(wf.transitions.map((t) => t.id)).size !== wf.transitions.length) errs.push(`${name}: duplicate transition ids`);
    if (!ids.has(wf.initial)) errs.push(`${name}: initial state '${wf.initial}' missing`);
    for (const s of wf.states) if (s.ownerRole && !roleIds.has(s.ownerRole)) errs.push(`${name}: state '${s.id}' owned by unknown role '${s.ownerRole}'`);
    for (const t of wf.transitions) {
      for (const r of t.roles ?? []) if (!roleIds.has(r)) errs.push(`${name}: transition '${t.id}' allows unknown role '${r}'`);
      if (t.requires?.approval && !roleIds.has(t.requires.approval.role)) errs.push(`${name}: transition '${t.id}' needs approval from unknown role '${t.requires.approval.role}'`);
      if (t.requires?.settled !== undefined && !money) errs.push(`${name}: transition '${t.id}' uses 'settled' but the document carries no receivable/payable`);
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
    checkWf(`doc:${d.id}`, d.workflow, d.effects.includes('receivable') || d.effects.includes('payable'));
    const init = d.workflow.states.find((s) => s.id === d.workflow.initial);
    if (init && init.phase !== 'draft') errs.push(`doc:${d.id}: initial state must be in phase 'draft'`);
    for (const c of d.convertsTo) if (!docIds.has(c)) errs.push(`doc:${d.id}: converts to unknown type '${c}'`);
    if (d.effects.includes('stock_out') && d.effects.includes('stock_in')) errs.push(`doc:${d.id}: cannot both stock_in and stock_out`);
    const money = d.effects.includes('receivable') || d.effects.includes('payable');
    if (d.adjusts) {
      if (!money) errs.push(`doc:${d.id}: a ${d.adjusts} note must carry a receivable or payable`);
      const sources = pack.documentTypes.filter((x) => x.convertsTo.includes(d.id));
      if (!sources.length) errs.push(`doc:${d.id}: no document type converts to this ${d.adjusts} note`);
      for (const src of sources) {
        if (src.direction !== d.direction) errs.push(`doc:${d.id}: source '${src.id}' has a different direction`);
        if (!(src.effects.includes('receivable') || src.effects.includes('payable')) || src.adjusts) errs.push(`doc:${d.id}: source '${src.id}' must be an invoice or bill`);
      }
      if (d.retention) errs.push(`doc:${d.id}: notes cannot hold retention`);
    }
    for (const [effect, field] of Object.entries(d.effectsWhen ?? {})) {
      if (!d.effects.includes(effect as never)) errs.push(`doc:${d.id}: effectsWhen names '${effect}', which is not one of its effects`);
      if (!(d.fields ?? []).some((f) => f.key === field && f.type === 'boolean')) errs.push(`doc:${d.id}: effectsWhen field '${field}' must be a boolean document field`);
    }
    if (d.retention && !money) errs.push(`doc:${d.id}: retention needs a receivable or payable`);
    if (d.retention && !(d.fields ?? []).some((f) => f.key === d.retention!.field && f.type === 'number')) errs.push(`doc:${d.id}: retention field '${d.retention.field}' must be a number field`);
  }
  const unitIds = new Set(pack.units.map((u) => u.id));
  if (unitIds.size !== pack.units.length) errs.push('units: duplicate ids');
  return errs;
}
