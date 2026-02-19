#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import pg from 'pg';

const { Pool } = pg;

const argv = process.argv.slice(2);
const args = new Map();
for (let i = 0; i < argv.length; i++) {
  const token = argv[i];
  if (token.startsWith('--')) {
    const key = token.slice(2);
    const maybeValue = argv[i + 1];
    if (!maybeValue || maybeValue.startsWith('--')) {
      args.set(key, 'true');
    } else {
      args.set(key, maybeValue);
      i += 1;
    }
  }
}

const sqlitePath =
  args.get('sqlite') ||
  process.env.SQLITE_PATH ||
  process.env.DATABASE_PATH ||
  path.join(process.cwd(), 'data', 'chat.db');

const postgresUrl = args.get('database-url') || process.env.DATABASE_URL || process.env.POSTGRES_URL;
const dryRun = args.get('dry-run') === 'true';

if (!fs.existsSync(sqlitePath)) {
  console.error(`[migrate] SQLite file not found: ${sqlitePath}`);
  process.exit(1);
}

const postgresConfig = postgresUrl
  ? { connectionString: postgresUrl }
  : {
      host: process.env.POSTGRES_HOST || 'localhost',
      port: Number(process.env.POSTGRES_PORT || 5432),
      user: process.env.POSTGRES_USER || 'wabi',
      password: process.env.POSTGRES_PASSWORD || 'wabi',
      database: process.env.POSTGRES_DB || 'wabi'
    };

const schemaCandidates = [
  path.join(process.cwd(), 'src', 'db', 'schema.postgres.sql'),
  path.join(process.cwd(), 'backend', 'src', 'db', 'schema.postgres.sql'),
  path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'db', 'schema.postgres.sql')
];
const schemaPath = schemaCandidates.find((candidate) => fs.existsSync(candidate));
if (!schemaPath) {
  console.error('[migrate] Could not locate backend/src/db/schema.postgres.sql');
  process.exit(1);
}

function splitSqlStatements(sql) {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

const CORE_TABLES = [
  { table: 'users', conflict: ['user_id'] },
  { table: 'roles', conflict: ['role_name'] },
  { table: 'sessions', conflict: ['session_id'] },
  { table: 'user_settings', conflict: ['user_id'] },
  { table: 'theme_preferences', conflict: ['user_id'] },
  { table: 'user_roles', conflict: ['id'] },
  { table: 'guest_codes', conflict: ['code'] },
  { table: 'user_encryption_keys', conflict: ['id'] },
  { table: 'channels', conflict: ['channel_id'] },
  { table: 'channel_members', conflict: ['id'] },
  { table: 'messages', conflict: ['message_id'] },
  { table: 'offline_messages', conflict: ['message_id'] },
  { table: 'emoji_role_rules', conflict: ['id'] },
  { table: 'webhooks', conflict: ['id'] },
  { table: 'webhook_deliveries', conflict: ['id'] },
  { table: 'relays', conflict: ['relay_id'] }
];

const SERIAL_COLUMNS = [
  { table: 'users', column: 'user_id' },
  { table: 'offline_messages', column: 'message_id' },
  { table: 'user_roles', column: 'id' },
  { table: 'user_encryption_keys', column: 'id' },
  { table: 'channel_members', column: 'id' },
  { table: 'messages', column: 'id' },
  { table: 'emoji_role_rules', column: 'id' },
  { table: 'relays', column: 'relay_id' },
  { table: 'webhooks', column: 'id' },
  { table: 'webhook_deliveries', column: 'id' }
];

function buildUpsertSql(table, columns, conflictColumns) {
  const quotedCols = columns.map((col) => `"${col}"`);
  const placeholders = columns.map((_, idx) => `$${idx + 1}`);
  const conflict = conflictColumns.map((col) => `"${col}"`).join(', ');
  const updateCols = columns.filter((col) => !conflictColumns.includes(col));

  let conflictClause = '';
  if (conflictColumns.length > 0) {
    if (updateCols.length > 0) {
      const updates = updateCols.map((col) => `"${col}" = EXCLUDED."${col}"`).join(', ');
      conflictClause = ` ON CONFLICT (${conflict}) DO UPDATE SET ${updates}`;
    } else {
      conflictClause = ` ON CONFLICT (${conflict}) DO NOTHING`;
    }
  }

  return `INSERT INTO "${table}" (${quotedCols.join(', ')}) VALUES (${placeholders.join(', ')})${conflictClause}`;
}

async function main() {
  const sqlite = new Database(sqlitePath, { readonly: true });
  const pool = new Pool(postgresConfig);

  console.log(`[migrate] SQLite source: ${sqlitePath}`);
  console.log('[migrate] Postgres target configured');
  if (dryRun) {
    console.log('[migrate] Dry-run mode enabled (no writes)');
  }

  const client = await pool.connect();
  try {
    if (!dryRun) {
      await client.query('BEGIN');

      const schemaSql = fs.readFileSync(schemaPath, 'utf8');
      for (const statement of splitSqlStatements(schemaSql)) {
        await client.query(statement);
      }
      console.log('[migrate] Schema bootstrap complete');
    }

    for (const { table, conflict } of CORE_TABLES) {
      const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
      if (!rows || rows.length === 0) {
        console.log(`[migrate] ${table}: 0 rows`);
        continue;
      }

      const columns = Object.keys(rows[0]);
      const insertSql = buildUpsertSql(table, columns, conflict);

      if (!dryRun) {
        for (const row of rows) {
          const values = columns.map((col) => row[col]);
          await client.query(insertSql, values);
        }
      }

      console.log(`[migrate] ${table}: ${rows.length} rows`);
    }

    if (!dryRun) {
      for (const { table, column } of SERIAL_COLUMNS) {
        await client.query(
          `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX("${column}") FROM "${table}"), 1), true)`,
          [table, column]
        );
      }

      await client.query('COMMIT');
      console.log('[migrate] SQLite -> Postgres migration complete');
    } else {
      console.log('[migrate] Dry-run completed');
    }
  } catch (error) {
    if (!dryRun) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {
        // ignore rollback error
      }
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
}

main().catch((error) => {
  console.error('[migrate] Failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
