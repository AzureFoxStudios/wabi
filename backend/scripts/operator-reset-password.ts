import { randomBytes } from 'crypto';
import { hashPassword } from '../src/auth/passwordHash.js';
import db, { closeDatabase } from '../src/db/database.js';
import { settingsRepository } from '../src/db/repositories/settingsRepository.js';
import type { RegisteredUser } from '../src/state-plane/records.js';

type StateStores = Awaited<typeof import('../src/state-plane/index.js')> | null;

interface Args {
	user: string | null;
	password: string | null;
	generate: boolean;
	temporary: boolean;
	json: boolean;
	help: boolean;
}

function printHelp(): void {
	console.log(`Wabi operator password reset

Usage:
  npm run auth:operator-reset -- --user <username|@handle|userId> [--generate] [--temporary]
  npm run auth:operator-reset -- --user <username|@handle|userId> --password <newPassword> [--temporary|--permanent]

Options:
  --user <value>       Username, @handle, or numeric user id to reset
  --password <value>   Explicit replacement password (min 8 chars)
  --generate           Generate a random temporary password and print it once
  --temporary          Force password change on next login (default)
  --permanent          Do not force password change on next login
  --json               Print machine-readable JSON
  --help               Show this help

Notes:
  - Run this only on the trusted origin/backend host.
  - This is not for relay/media/community nodes.
  - Restart the backend after using this command if you need live in-memory lockout timers cleared immediately.`);
}

function parseArgs(argv: string[]): Args {
	const parsed: Args = {
		user: null,
		password: null,
		generate: false,
		temporary: true,
		json: false,
		help: false
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		switch (arg) {
			case '--user':
				parsed.user = argv[i + 1] || null;
				i += 1;
				break;
			case '--password':
				parsed.password = argv[i + 1] || null;
				i += 1;
				break;
			case '--generate':
				parsed.generate = true;
				break;
			case '--temporary':
				parsed.temporary = true;
				break;
			case '--permanent':
				parsed.temporary = false;
				break;
			case '--json':
				parsed.json = true;
				break;
			case '--help':
			case '-h':
				parsed.help = true;
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return parsed;
}

async function loadStateStores(): Promise<StateStores> {
	try {
		return await import('../src/state-plane/index.js');
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[AuthRecovery] State-plane unavailable, falling back to local auth mirror only (${detail})`);
		return null;
	}
}

function findUserLocally(identifier: string): RegisteredUser | null {
	const trimmed = identifier.trim();
	if (!trimmed) return null;
	if (/^\d+$/.test(trimmed)) {
		return (db.prepare('SELECT * FROM users WHERE user_id = ? LIMIT 1').get(Number(trimmed)) as RegisteredUser) || null;
	}
	const handle = trimmed.replace(/^@/, '');
	return (
		db
			.prepare(
				`
					SELECT *
					FROM users
					WHERE handle = ? COLLATE NOCASE OR username = ? COLLATE NOCASE
					LIMIT 1
				`
			)
			.get(handle, trimmed) as RegisteredUser
	) || null;
}

async function findUser(identifier: string, stateStores: StateStores): Promise<RegisteredUser | null> {
	const local = findUserLocally(identifier);
	if (local) return local;
	if (!stateStores) return null;
	const trimmed = identifier.trim();
	if (/^\d+$/.test(trimmed)) {
		return stateStores.stateUserStore.findById(Number(trimmed));
	}
	return stateStores.stateUserStore.findByHandleOrUsername(trimmed);
}

function generateTemporaryPassword(): string {
	return randomBytes(12).toString('base64url');
}

async function revokeRegisteredSessions(userId: number, stateStores: StateStores): Promise<number> {
	if (stateStores && typeof stateStores.stateSessionStore.deleteRegisteredByUserIdAsync === 'function') {
		return await stateStores.stateSessionStore.deleteRegisteredByUserIdAsync(userId);
	}
	if (stateStores) {
		return stateStores.stateSessionStore.deleteRegisteredByUserId(userId);
	}
	const result = db.prepare('DELETE FROM sessions WHERE user_id = ? AND is_temporary = 0').run(userId);
	return Number(result.changes || 0);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		printHelp();
		return;
	}

	if (!args.user) {
		throw new Error('Missing --user');
	}
	if (args.generate && args.password) {
		throw new Error('Use either --generate or --password, not both');
	}

	const nextPassword = args.generate ? generateTemporaryPassword() : (args.password || '');
	if (!nextPassword) {
		throw new Error('Provide --password or --generate');
	}
	if (nextPassword.length < 8) {
		throw new Error('Password must be at least 8 characters');
	}

	const stateStores = await loadStateStores();
	const targetUser = await findUser(args.user, stateStores);
	if (!targetUser?.user_id) {
		throw new Error(`User not found: ${args.user}`);
	}

	const passwordHash = await hashPassword(nextPassword);
	if (stateStores) {
		stateStores.stateUserStore.update(targetUser.user_id, { password_hash: passwordHash });
	} else {
		db.prepare('UPDATE users SET password_hash = ? WHERE user_id = ?').run(passwordHash, targetUser.user_id);
	}

	settingsRepository.set(targetUser.user_id, {
		require_password_change: args.temporary ? 1 : 0
	});
	const revokedSessions = await revokeRegisteredSessions(targetUser.user_id, stateStores);

	const result = {
		success: true,
		userId: targetUser.user_id,
		username: targetUser.username,
		handle: targetUser.handle || null,
		temporary: args.temporary,
		revokedRegisteredSessions: revokedSessions,
		generatedPassword: args.generate ? nextPassword : null,
		note: 'Restart the backend if it is currently running and you need live in-memory login cooldown state cleared immediately.'
	};

	if (args.json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	console.log(`[AuthRecovery] Reset password for ${result.username} (user_id=${result.userId})`);
	console.log(`[AuthRecovery] Temporary password required on next login: ${result.temporary ? 'yes' : 'no'}`);
	console.log(`[AuthRecovery] Revoked registered sessions: ${result.revokedRegisteredSessions}`);
	if (result.generatedPassword) {
		console.log(`[AuthRecovery] Generated password: ${result.generatedPassword}`);
	} else {
		console.log('[AuthRecovery] Password updated to the value you provided.');
	}
	console.log(`[AuthRecovery] ${result.note}`);
}

main()
	.catch((error) => {
		const detail = error instanceof Error ? error.message : String(error);
		console.error(`[AuthRecovery] ${detail}`);
		process.exitCode = 1;
	})
	.finally(() => {
		closeDatabase();
	});
