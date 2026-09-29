#!/usr/bin/env node
/** Operator CLI: serve, verify, backup, restore, export, users. */
import { createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApp, seedDemo } from './app.ts';
import { setPassword } from './auth.ts';
import { SYSTEM } from './engine.ts';
import { readAll } from './journal.ts';
import { backup, restoreFromJournal, verify } from './maintenance.ts';
import { one } from './db.ts';
import { serve } from './main.ts';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const dataDir = resolve(flag('data') ?? process.env.SABI_DATA ?? './data');
const positional = rest.filter((a, i) => !a.startsWith('--') && !rest[i - 1]?.startsWith('--'));

function help() {
  console.log(`sabi <command> [--data DIR]

  serve [--port 8080] [--demo]     start the server
  verify                           check the journal hash chain and rebuild all projections to compare
  backup <out-dir>                 SQLite snapshot + journal.jsonl + attachments
  restore <backup-dir>             rebuild a database in --data from <backup-dir>/journal.jsonl
  export <file.jsonl>              write the journal as JSON lines
  seed-demo                        fill an empty data dir with demo data
  user add <username> <name> <role> <password>
  passwd <username> <password>
`);
}

switch (cmd) {
  case 'serve':
    serve({ port: flag('port') ? Number(flag('port')) : undefined, dataDir, demo: rest.includes('--demo') });
    break;
  case 'verify': {
    const app = createApp({ dataDir });
    const r = verify(app.db);
    console.log(`Journal: ${r.chain.ok ? 'OK' : 'BROKEN'} — ${r.chain.events} events, head ${r.chain.head.slice(0, 16)}…`);
    if (!r.chain.ok) console.log(`  first bad seq ${r.chain.firstBadSeq}: ${r.chain.problem}`);
    for (const p of r.projections) console.log(`  ${p.ok ? '✓' : '✗'} ${p.table.padEnd(20)} ${p.live}${p.ok ? '' : ` (replay: ${p.replayed})`}`);
    console.log(r.ok ? 'All good.' : 'Problems found.');
    process.exit(r.ok ? 0 : 1);
  }
  case 'backup': {
    const app = createApp({ dataDir });
    const out = backup(app.db, dataDir, resolve(positional[0] ?? './backups'));
    console.log(`Backup written to ${out.dir} (${out.events} events)`);
    break;
  }
  case 'restore': {
    const n = restoreFromJournal(join(resolve(positional[0]), 'journal.jsonl'), join(dataDir, 'sabi.db'));
    console.log(`Restored ${n} events into ${dataDir}. Passwords are not part of backups: set them with \`sabi passwd\`.`);
    break;
  }
  case 'export': {
    const app = createApp({ dataDir });
    const file = resolve(positional[0] ?? 'sabi-journal.jsonl');
    const out = createWriteStream(file);
    let n = 0;
    for (const e of readAll(app.db)) (out.write(JSON.stringify(e) + '\n'), n++);
    out.end(() => console.log(`Wrote ${n} events to ${file}`));
    break;
  }
  case 'seed-demo': {
    const app = createApp({ dataDir });
    seedDemo(app);
    console.log('Demo data created. Sign in as "owner" / "demo1234".');
    break;
  }
  case 'user': {
    if (positional[0] !== 'add' || positional.length < 5) (help(), process.exit(1));
    const [, username, name, role, password] = positional;
    const app = createApp({ dataDir });
    const u = app.exec('user.create', { username, name, role }, SYSTEM).result;
    setPassword(app.db, u.id, password);
    console.log(`Created ${username} (${role})`);
    break;
  }
  case 'passwd': {
    const [username, password] = positional;
    const app = createApp({ dataDir });
    const u = one<{ id: string }>(app.db, 'SELECT id FROM users WHERE username = ?', username);
    if (!u) (console.error('No such user'), process.exit(1));
    setPassword(app.db, u!.id, password);
    console.log('Password updated.');
    break;
  }
  default:
    help();
    if (cmd) process.exit(1);
}
