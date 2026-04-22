import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';

const smokeDir = mkdtempSync(join(tmpdir(), 'wabi-auth-recovery-'));
const databasePath = join(smokeDir, 'chat.db');

const env = {
	...process.env,
	DB_MODE: 'sqlite',
	DATABASE_PATH: databasePath,
	STATE_STDB_SUBSCRIPTIONS_ENABLED: 'false'
};

async function seedUser(): Promise<void> {
	process.env.DB_MODE = env.DB_MODE;
	process.env.DATABASE_PATH = env.DATABASE_PATH;
	process.env.STATE_STDB_SUBSCRIPTIONS_ENABLED = env.STATE_STDB_SUBSCRIPTIONS_ENABLED;

	const { initializeDatabase, closeDatabase } = await import('../src/db/database.js');
	const { userRepository } = await import('../src/db/repositories/userRepository.js');
	const { settingsRepository } = await import('../src/db/repositories/settingsRepository.js');
	const { sessionRepository } = await import('../src/db/repositories/sessionRepository.js');

	initializeDatabase();

	const oldPasswordHash = await bcrypt.hash('old-password-123', 10);
		const user = userRepository.create({
			username: 'smoke-user',
			handle: 'smoke-user',
			password_hash: oldPasswordHash,
			created_at: Date.now(),
			color: '#abcdef'
		});

	settingsRepository.set(user.user_id!, {
		require_password_change: 0
	});

	sessionRepository.create({
		session_id: 'smoke-session',
		user_id: user.user_id!,
		username: user.username,
		color: user.color,
		profile_picture: user.profile_picture,
		created_at: Date.now(),
		expires_at: Date.now() + 60_000,
		is_temporary: 0
	});

	closeDatabase();
}

function runReset(): void {
	const tsxCliUrl = new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url);
	const tsxCliPath = fileURLToPath(tsxCliUrl);
	const result = spawnSync(
		process.execPath,
		[
			tsxCliPath,
			'--env-file-if-exists=.env',
			'scripts/operator-reset-password.ts',
			'--user',
			'smoke-user',
			'--password',
			'new-password-456',
			'--temporary',
			'--json'
		],
		{
			cwd: process.cwd(),
			env,
			encoding: 'utf8'
		}
	);

	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || 'operator reset command failed');
	}

	const jsonStart = result.stdout.indexOf('{');
	const jsonEnd = result.stdout.lastIndexOf('}');
	if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
		throw new Error(`Expected JSON output from operator reset command, got: ${result.stdout}`);
	}
	const parsed = JSON.parse(result.stdout.slice(jsonStart, jsonEnd + 1)) as {
		success: boolean;
		temporary: boolean;
		revokedRegisteredSessions: number;
		username: string;
	};
	if (!parsed.success || parsed.username !== 'smoke-user' || parsed.temporary !== true) {
		throw new Error(`Unexpected reset result: ${result.stdout}`);
	}
	if (parsed.revokedRegisteredSessions !== 1) {
		throw new Error(`Expected one revoked session, got: ${parsed.revokedRegisteredSessions}`);
	}
}

async function verifyReset(): Promise<void> {
	const db = new Database(databasePath, { readonly: true });
	try {
		const user = db.prepare('SELECT user_id, password_hash FROM users WHERE username = ?').get('smoke-user') as
			| { user_id: number; password_hash: string }
			| undefined;
		if (!user) {
			throw new Error('Smoke user missing after reset');
		}

		const passwordMatches = await bcrypt.compare('new-password-456', user.password_hash);
		if (!passwordMatches) {
			throw new Error('Password hash was not updated');
		}

		const settings = db.prepare('SELECT require_password_change FROM user_settings WHERE user_id = ?').get(user.user_id) as
			| { require_password_change: number }
			| undefined;
		if (!settings || Number(settings.require_password_change) !== 1) {
			throw new Error('Temporary-password flag was not set');
		}

		const sessions = db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ? AND is_temporary = 0').get(user.user_id) as
			| { count: number }
			| undefined;
		if (!sessions || Number(sessions.count) !== 0) {
			throw new Error('Registered sessions were not revoked');
		}
	} finally {
		db.close();
	}
}

async function main(): Promise<void> {
	try {
		await seedUser();
		runReset();
		await verifyReset();
		console.log(JSON.stringify({ ok: true, databasePath }));
	} finally {
		rmSync(smokeDir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	const detail = error instanceof Error ? error.message : String(error);
	console.error(detail);
	process.exit(1);
});
