/** Application assembly: database + pack + jurisdiction + command registry. */
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { JournalEvent, Pack, Jurisdiction } from '@sabi/core';
import { validatePack } from '@sabi/core';
import { th as thailand } from '@sabi/jurisdiction-th';
import { sheetMetalPack, demoSeed, DEMO_USERS } from '@sabi/pack-sheet-metal';
import { all, one, openDb, tx } from './db.ts';
import { execute, SYSTEM, CommandError, type Actor, type Ctx } from './engine.ts';
import { registry } from './commands/index.ts';
import { getDocument, getUser } from './repo.ts';
import { setPassword } from './auth.ts';
import { webhookListener } from './webhook.ts';

export interface AppOptions {
  dataDir: string;
  /** Override the database path (':memory:' for tests). */
  dbPath?: string;
  pack?: Pack;
  jurisdiction?: Jurisdiction;
  now?: () => Date;
}

export interface App {
  ctx: Ctx;
  db: DatabaseSync;
  exec(name: string, input: unknown, actor: Actor): { result: any; events: { seq: number; type: string; subjectType: string; subjectId: string }[] };
  listeners: Set<(events: JournalEvent[]) => void>;
  isSetUp(): boolean;
  close(): void;
}

export function createApp(opts: AppOptions): App {
  const pack = opts.pack ?? sheetMetalPack;
  const problems = validatePack(pack);
  if (problems.length) throw new Error(`Invalid configuration pack:\n  ${problems.join('\n  ')}`);
  const db = openDb(opts.dbPath ?? join(opts.dataDir, 'sabi.db'));
  const listeners = new Set<(events: JournalEvent[]) => void>();
  const ctx: Ctx = {
    db, pack, jur: opts.jurisdiction ?? thailand, dataDir: opts.dataDir, now: opts.now ?? (() => new Date()),
    onCommit: (events) => {
      for (const l of listeners) {
        try {
          l(events);
        } catch (e) {
          console.error('listener failed', e);
        }
      }
    },
  };
  listeners.add(webhookListener(db));
  return {
    ctx, db, listeners,
    exec: (name, input, actor) => execute(ctx, registry, name, input, actor),
    isSetUp: () => !!one(db, "SELECT 1 FROM users WHERE role = 'owner' AND active = 1"),
    close: () => db.close(),
  };
}

export function actorOf(app: App, userId: string): Actor {
  const u = getUser(app.db, userId);
  if (!u || !u.active) throw new CommandError(401, 'unauthenticated', 'Please sign in again');
  return { id: u.id, name: u.name, role: u.role };
}

/** First-run setup: create the owner account and company. */
export function setup(app: App, input: { company: string; name: string; username: string; password: string; locale?: string }) {
  if (app.isSetUp()) throw new CommandError(409, 'already_setup', 'This workspace is already set up');
  if (!input.password || input.password.length < 8) throw new CommandError(400, 'invalid', 'Password must be at least 8 characters', { field: 'password' });
  const user = app.exec('user.create', { name: input.name, username: input.username, role: 'owner', locale: input.locale ?? 'th' }, SYSTEM).result;
  setPassword(app.db, user.id, input.password);
  app.exec('company.update', { name: input.company, fields: { branch_code: '00000', vat_registered: true } }, { id: user.id, name: user.name, role: 'owner' });
  return user;
}

export const DEMO_PASSWORD = 'demo1234';

/**
 * Seed the demo workspace (owner + staff + a month of history). The clock is
 * moved backwards so the journal reads like real history; it stays monotonic
 * because each step is later than the previous one.
 */
export function seedDemo(app: App): void {
  if (app.isSetUp()) throw new Error('Workspace already has data; demo seeding needs an empty database');
  const realNow = app.ctx.now;
  let fake = new Date(0);
  try {
    fake = new Date(realNow().getTime() - 70 * 86400_000);
    app.ctx.now = () => fake;
    const owner = app.exec('user.create', { name: 'Kanya Thaweesap', username: 'owner', role: 'owner', locale: 'th' }, SYSTEM).result;
    const byName = (username: string): Actor => {
      if (username === 'system') return SYSTEM;
      const u = one<{ id: string; name: string; role: string }>(app.db, 'SELECT id, name, role FROM users WHERE username = ?', username);
      if (!u) throw new Error(`seed: unknown user ${username}`);
      return u;
    };
    demoSeed({
      run: (username, command, input) => app.exec(command, input, byName(username)).result,
      clock: (daysAgo, hour = 9, minute = 0) => {
        // Local business time (UTC+7) → UTC instant.
        const base = new Date(realNow().getTime() + 7 * 3600_000);
        const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() - daysAgo, hour - 7, minute));
        // Never move into the future relative to the real clock, never go backwards.
        const t = Math.min(d.getTime(), realNow().getTime() - 60_000);
        fake = new Date(Math.max(t, fake.getTime() + 1000));
      },
      document: (id) => getDocument(app.db, id)!,
      openTasks: (subjectType, subjectId) =>
        all<{ id: string }>(app.db, 'SELECT id FROM tasks WHERE subject_type = ? AND subject_id = ? AND done_at IS NULL', subjectType, subjectId).map((r) => r.id),
    });
    tx(app.db, () => {
      setPassword(app.db, owner.id, DEMO_PASSWORD);
      for (const u of DEMO_USERS) setPassword(app.db, byName(u.username).id, DEMO_PASSWORD);
    });
    app.db.prepare("INSERT OR REPLACE INTO local_state (key, value) VALUES ('demo', 'true')").run();
  } finally {
    app.ctx.now = realNow;
  }
}

export function isDemo(app: App): boolean {
  return !!one(app.db, "SELECT 1 FROM local_state WHERE key = 'demo'");
}
