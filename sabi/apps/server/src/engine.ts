import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Capability, IsoDate, Jurisdiction, JournalEvent, Pack } from '@sabi/core';
import { tx } from './db.ts';
import { append, type EventDraft } from './journal.ts';
import { project } from './projector.ts';

export interface Ctx {
  db: DatabaseSync;
  pack: Pack;
  jur: Jurisdiction;
  dataDir: string;
  /** Injectable clock (tests, demo seeding). */
  now: () => Date;
  /** Called after every committed command with its events. */
  onCommit?: (events: JournalEvent[]) => void;
}

export interface Actor {
  id: string;
  name: string;
  role: string;
  /** System actor for automations. */
  system?: boolean;
}

export const SYSTEM: Actor = { id: 'system', name: 'Sabi', role: 'owner', system: true };

export class CommandError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const fail = (code: string, message: string, details?: unknown, status = 400): never => {
  throw new CommandError(status, code, message, details);
};

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('base64url').replace(/[-_]/g, '').slice(0, 10).toLowerCase()}`;
}

export class Scope {
  readonly ctx: Ctx;
  readonly actor: Actor;
  readonly at: string;
  readonly events: JournalEvent[] = [];
  /** Subjects touched by this command; auto-transitions are evaluated for these. */
  readonly touched = new Set<string>();

  constructor(ctx: Ctx, actor: Actor) {
    this.ctx = ctx;
    this.actor = actor;
    this.at = ctx.now().toISOString();
  }

  get db() {
    return this.ctx.db;
  }
  get pack() {
    return this.ctx.pack;
  }
  get jur() {
    return this.ctx.jur;
  }

  today(): IsoDate {
    // Business dates are local to Thailand for the first deployment (UTC+7, no DST).
    const tzOffsetMin = Number(process.env.SABI_TZ_OFFSET_MINUTES ?? 420);
    return new Date(this.ctx.now().getTime() + tzOffsetMin * 60_000).toISOString().slice(0, 10);
  }

  /** Append to the journal and project immediately (reads within the command see it). */
  emit(draft: EventDraft, actor: Actor = this.actor): JournalEvent {
    const e = append(this.db, draft, actor.id, this.at);
    project(this.db, e);
    this.events.push(e);
    if (draft.subjectType === 'job' || draft.subjectType === 'document') this.touched.add(`${draft.subjectType}:${draft.subjectId}`);
    return e;
  }

  can(cap: Capability): boolean {
    if (this.actor.system) return true;
    const role = this.pack.roles.find((r) => r.id === this.actor.role);
    return !!role && (role.capabilities.includes('all') || role.capabilities.includes(cap));
  }

  require(cap: Capability): void {
    if (!this.can(cap)) fail('forbidden', `Your role cannot do this (${cap}).`, { capability: cap }, 403);
  }

  get isSuperuser(): boolean {
    return this.actor.system === true || this.can('all');
  }
}

export type Handler = (s: Scope, input: any) => unknown;

export interface Registry {
  commands: Record<string, Handler>;
  /** Evaluate system auto-transitions for touched subjects until stable. */
  settle: (s: Scope) => void;
}

export function execute(ctx: Ctx, registry: Registry, name: string, input: unknown, actor: Actor) {
  const handler = registry.commands[name];
  if (!handler) fail('unknown_command', `Unknown command '${name}'`, undefined, 404);
  const scope = new Scope(ctx, actor);
  const result = tx(ctx.db, () => {
    const r = handler(scope, input ?? {});
    registry.settle(scope);
    return r;
  });
  if (scope.events.length) ctx.onCommit?.(scope.events);
  return { result, events: scope.events.map((e) => ({ seq: e.seq, type: e.type, subjectType: e.subjectType, subjectId: e.subjectId })) };
}
