#!/usr/bin/env node

import { existsSync } from 'fs';
import { resolve } from 'path';
import { spawnSync } from 'child_process';

function usage() {
	console.log(`Usage: node scripts/state-plane-stdb-primary-smoke.mjs [options]

Deterministic STDB-primary cutover smoke check for Wabi state entities.

Options:
  --server <url|nickname>   SpacetimeDB server (default: env WABI_STDB_BRIDGE_SERVER or local)
  --database <name>         Database name (default: env WABI_STDB_BRIDGE_DATABASE or wabi-state-primary-smoke)
  --reducer <name>          Reducer name (default: env WABI_STDB_BRIDGE_REDUCER or ingest_wabi_event)
  --timeout-ms <n>          Helper timeout in ms (default: env WABI_STDB_BRIDGE_TIMEOUT_MS or 15000)
  --token <jwt>             Auth token for helper calls (optional)
  --anonymous               Force anonymous helper auth
  --no-anonymous            Disable anonymous helper auth
  --skip-publish            Skip spacetime publish preflight
  --module-path <path>      Spacetime module path (default: ./spacetimedb/wabi_state_bridge)
  --project-path <path>     Deprecated alias for --module-path
  --spacetime-bin <path>    Spacetime CLI binary (default: spacetime)
  --json                    Print JSON summary
  -h, --help                Show help
`);
}

function parsePositiveInt(value, fallback, min, max) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	const rounded = Math.floor(parsed);
	if (rounded < min) return min;
	if (rounded > max) return max;
	return rounded;
}

function parseArgs(argv) {
	const options = {
		server: (process.env.WABI_STDB_BRIDGE_SERVER || 'local').trim(),
		database: (process.env.WABI_STDB_BRIDGE_DATABASE || 'wabi-state-primary-smoke').trim(),
		reducer: (process.env.WABI_STDB_BRIDGE_REDUCER || 'ingest_wabi_event').trim(),
		timeoutMs: parsePositiveInt(process.env.WABI_STDB_BRIDGE_TIMEOUT_MS || '15000', 15000, 100, 300000),
		token: (process.env.WABI_STDB_AUTH_TOKEN || '').trim(),
		anonymous: !['0', 'false', 'no', 'off'].includes((process.env.WABI_STDB_ANONYMOUS || 'true').trim().toLowerCase()),
		skipPublish: false,
		modulePath: resolve(process.cwd(), 'spacetimedb/wabi_state_bridge'),
		spacetimeBin: 'spacetime',
		json: false
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '-h' || arg === '--help') {
			usage();
			process.exit(0);
		}
		if (arg === '--json') {
			options.json = true;
			continue;
		}
		if (arg === '--skip-publish') {
			options.skipPublish = true;
			continue;
		}
		if (arg === '--anonymous') {
			options.anonymous = true;
			continue;
		}
		if (arg === '--no-anonymous') {
			options.anonymous = false;
			continue;
		}
		if (arg === '--server') {
			i += 1;
			if (i >= argv.length) throw new Error('--server requires a value');
			options.server = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--database') {
			i += 1;
			if (i >= argv.length) throw new Error('--database requires a value');
			options.database = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--reducer') {
			i += 1;
			if (i >= argv.length) throw new Error('--reducer requires a value');
			options.reducer = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--timeout-ms') {
			i += 1;
			if (i >= argv.length) throw new Error('--timeout-ms requires a value');
			options.timeoutMs = parsePositiveInt(argv[i], 15000, 100, 300000);
			continue;
		}
		if (arg === '--token') {
			i += 1;
			if (i >= argv.length) throw new Error('--token requires a value');
			options.token = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--module-path' || arg === '--project-path') {
			i += 1;
			if (i >= argv.length) throw new Error(`${arg} requires a value`);
			options.modulePath = resolve(process.cwd(), argv[i]);
			continue;
		}
		if (arg === '--spacetime-bin') {
			i += 1;
			if (i >= argv.length) throw new Error('--spacetime-bin requires a value');
			options.spacetimeBin = String(argv[i] || '').trim();
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	if (!options.server) throw new Error('server is required');
	if (!options.database) throw new Error('database is required');
	if (!options.reducer) throw new Error('reducer is required');
	if (!existsSync(options.modulePath)) {
		throw new Error(`Spacetime module path not found: ${options.modulePath}`);
	}
	return options;
}

function escapeSqlLiteral(value) {
	return `'${String(value).replace(/'/g, "''")}'`;
}

function parseJsonLine(text) {
	const trimmed = String(text || '').trim();
	if (trimmed) {
		try {
			return JSON.parse(trimmed);
		} catch {
			// Fall back to line-oriented parsing for mixed stdout payloads.
		}
	}
	const lines = String(text || '')
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		if (lines[i].startsWith('{') || lines[i].startsWith('[')) {
			return JSON.parse(lines[i]);
		}
	}
	throw new Error(`expected JSON output, got: ${text}`);
}

function runCommand(command, args, timeoutMs, context) {
	const run = spawnSync(command, args, {
		encoding: 'utf8',
		timeout: timeoutMs,
		maxBuffer: 16 * 1024 * 1024
	});
	if (run.error) throw new Error(`${context}: ${run.error.message}`);
	if (run.signal) throw new Error(`${context}: terminated by ${run.signal}`);
	if (typeof run.status === 'number' && run.status !== 0) {
		const detail = (run.stderr || run.stdout || '').trim();
		throw new Error(`${context}: exit ${run.status}${detail ? ` (${detail})` : ''}`);
	}
	return run.stdout || '';
}

function decodeSqlRows(sqlResponse) {
	const normalized = Array.isArray(sqlResponse) ? sqlResponse[0] : sqlResponse;
	const elements = Array.isArray(normalized?.schema?.elements) ? normalized.schema.elements : [];
	const names = elements.map((entry, index) => entry?.name?.some || `col_${index}`);
	const rows = Array.isArray(normalized?.rows) ? normalized.rows : [];
	return rows.map((row) => {
		const out = {};
		for (let i = 0; i < names.length; i += 1) {
			out[names[i]] = decodeSqlCell(row?.[i]);
		}
		return out;
	});
}

function decodeSqlCell(value) {
	if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'number') {
		if (value[0] === 0) return value[1];
		if (value[0] === 1) return null;
	}
	return value;
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const helperPath = resolve(process.cwd(), 'backend/scripts/state-plane-stdb-http.mjs');
	if (!existsSync(helperPath)) {
		throw new Error(`Missing helper script: ${helperPath}`);
	}

	if (!options.skipPublish) {
		const publishArgs = ['publish', '--module-path', options.modulePath, '--server', options.server, options.database, '--yes', '--no-config'];
		if (options.token) {
			publishArgs.push('--token', options.token);
		} else if (options.anonymous) {
			publishArgs.push('--anonymous');
		}
		runCommand(options.spacetimeBin, publishArgs, Math.max(options.timeoutMs, 120000), 'spacetime publish');
	}

	const helperBase = [helperPath, '--server', options.server, '--database', options.database, '--timeout-ms', String(options.timeoutMs)];
	if (options.token) {
		helperBase.push('--token', options.token);
	} else if (options.anonymous) {
		helperBase.push('--anonymous');
	} else {
		helperBase.push('--no-anonymous');
	}

	function helperCall(modeArgs, context) {
		const stdout = runCommand(process.execPath, [...helperBase, ...modeArgs], options.timeoutMs + 3000, context);
		return parseJsonLine(stdout);
	}

	function callReducer(event) {
		const response = helperCall(
			[
				'call',
				'--reducer',
				options.reducer,
				'--args-json',
				JSON.stringify([JSON.stringify(event)])
			],
			`stdb call ${event.entity}.${event.operation}`
		);
		assert(response?.ok === true, `stdb reducer call failed for ${event.entity}.${event.operation}`);
		return response;
	}

	function sql(query) {
		const response = helperCall(['sql', '--query', query], 'stdb sql');
		assert(response?.ok === true, `stdb sql failed: ${query}`);
		return response;
	}

	let eventCounter = 0;
	const eventPrefix = 'stdb_primary_smoke';
	function emit(entity, operation, payload) {
		eventCounter += 1;
		const event = {
			eventId: `${eventPrefix}_${String(eventCounter).padStart(3, '0')}_${entity}_${operation}`,
			timestamp: 1_700_000_000_000 + eventCounter,
			entity,
			operation,
			payload
		};
		callReducer(event);
	}

	const ids = {
		userId: 910001,
		stableUserId: 'user-910001',
		channelId: 'stdb_primary_smoke_channel_main',
		deleteChannelId: 'stdb_primary_smoke_channel_delete',
		sessionId: 'stdb_primary_smoke_session_main',
		deleteSessionId: 'stdb_primary_smoke_session_delete',
		messageId: 'stdb_primary_smoke_message_main',
		otherMessageId: 'stdb_primary_smoke_message_other',
		deleteMessageId: 'stdb_primary_smoke_message_delete',
		workspaceId: 'default-workspace',
		role: 'member'
	};

	// Deterministic cleanup of prior smoke artifacts.
	emit('message', 'clearAll', { count: 0 });
	emit('channel', 'delete', { channelId: ids.channelId });
	emit('channel', 'delete', { channelId: ids.deleteChannelId });
	emit('session', 'delete', { sessionId: ids.sessionId });
	emit('session', 'delete', { sessionId: ids.deleteSessionId });
	emit('rbac', 'remove_role', {
		userId: ids.userId,
		role: ids.role,
		workspaceId: ids.workspaceId,
		assignmentKey: `${ids.workspaceId}:${ids.userId}:${ids.role}`
	});

	// Core entity write/read assertions.
	emit('channel', 'create', {
		channelId: ids.channelId,
		channelType: 'group',
		row: {
			channel_id: ids.channelId,
			channel_type: 'group',
			name: 'Smoke Main',
			description: 'initial',
			min_role: 'guest',
			voice_settings_json: null,
			watch_queue_enabled: 0,
			created_at: 1700000000010,
			created_by: ids.stableUserId,
			persist_messages: 0,
			is_archived: 0
		}
	});
	emit('channel', 'update_settings', {
		channelId: ids.channelId,
		row: {
			channel_id: ids.channelId,
			channel_type: 'group',
			name: 'Smoke Main Updated',
			description: 'updated',
			min_role: 'member',
			voice_settings_json: '{"bitrate":64000}',
			watch_queue_enabled: 1,
			created_at: 1700000000010,
			created_by: ids.stableUserId,
			persist_messages: 1,
			is_archived: 0
		}
	});
	emit('channel', 'update_avatar', {
		channelId: ids.channelId,
		avatarUrl: '/uploads/smoke.png',
		row: {
			channel_id: ids.channelId,
			channel_type: 'group',
			name: 'Smoke Main Updated',
			description: 'updated',
			min_role: 'member',
			voice_settings_json: '{"bitrate":64000}',
			watch_queue_enabled: 1,
			created_at: 1700000000010,
			created_by: ids.stableUserId,
			persist_messages: 1,
			is_archived: 0,
			avatar: '/uploads/smoke.png'
		}
	});
	emit('channel', 'archive', {
		channelId: ids.channelId,
		row: {
			channel_id: ids.channelId,
			channel_type: 'group',
			name: 'Smoke Main Updated',
			description: 'updated',
			min_role: 'member',
			voice_settings_json: '{"bitrate":64000}',
			watch_queue_enabled: 1,
			created_at: 1700000000010,
			created_by: ids.stableUserId,
			persist_messages: 1,
			is_archived: 1,
			avatar: '/uploads/smoke.png'
		}
	});

	emit('user', 'create', {
		userId: ids.userId,
		username: 'SmokeUser',
		handle: 'smoke_user',
		row: {
			user_id: ids.userId,
			username: 'SmokeUser',
			handle: 'smoke_user',
			password_hash: 'x',
			created_at: 1700000000020,
			color: '#336699',
			profile_picture: null,
			bio: null,
			is_active: 1
		}
	});
	emit('user', 'update', {
		userId: ids.userId,
		row: {
			user_id: ids.userId,
			username: 'SmokeUser',
			handle: 'smoke_user',
			password_hash: 'x',
			created_at: 1700000000020,
			color: '#224466',
			profile_picture: '/uploads/u.png',
			bio: 'updated',
			is_active: 1
		}
	});
	emit('user', 'delete', {
		userId: ids.userId,
		row: {
			user_id: ids.userId,
			username: 'SmokeUser',
			handle: 'smoke_user',
			password_hash: 'x',
			created_at: 1700000000020,
			color: '#224466',
			profile_picture: '/uploads/u.png',
			bio: 'updated',
			is_active: 0
		}
	});

	emit('channel_member', 'add_member', {
		channelId: ids.channelId,
		userId: ids.stableUserId,
		role: 'member',
		row: {
			channel_id: ids.channelId,
			user_id: ids.stableUserId,
			username: 'SmokeUser',
			registered_user_id: ids.userId,
			joined_at: 1700000000030,
			role: 'member'
		}
	});
	emit('channel_member', 'update_member', {
		channelId: ids.channelId,
		userId: ids.stableUserId,
		role: 'admin',
		row: {
			channel_id: ids.channelId,
			user_id: ids.stableUserId,
			username: 'SmokeUser',
			registered_user_id: ids.userId,
			joined_at: 1700000000030,
			role: 'admin'
		}
	});
	emit('channel_member', 'remove_member', {
		channelId: ids.channelId,
		userId: ids.stableUserId
	});

	emit('session', 'create', {
		sessionId: ids.sessionId,
		userId: ids.userId,
		isTemporary: false,
		row: {
			session_id: ids.sessionId,
			user_id: ids.userId,
			username: 'SmokeUser',
			color: '#224466',
			profile_picture: '/uploads/u.png',
			created_at: 1700000000040,
			expires_at: 1700000005040,
			is_temporary: 0
		}
	});
	emit('session', 'update', {
		sessionId: ids.sessionId,
		row: {
			session_id: ids.sessionId,
			user_id: ids.userId,
			username: 'SmokeUser',
			color: '#112233',
			profile_picture: '/uploads/u.png',
			created_at: 1700000000040,
			expires_at: 1700000005040,
			is_temporary: 0,
			last_seen: 1700000004040
		}
	});
	emit('session', 'cleanup', {
		now: 1700000010000,
		sessionIds: [ids.sessionId]
	});
	emit('session', 'create', {
		sessionId: ids.deleteSessionId,
		userId: ids.userId,
		isTemporary: true,
		row: {
			session_id: ids.deleteSessionId,
			user_id: ids.userId,
			username: 'SmokeUser',
			color: '#112233',
			profile_picture: null,
			created_at: 1700000000060,
			expires_at: null,
			is_temporary: 1
		}
	});
	emit('session', 'delete', {
		sessionId: ids.deleteSessionId
	});

	emit('rbac', 'assign_role', {
		userId: ids.userId,
		role: ids.role,
		workspaceId: ids.workspaceId,
		assignedBy: ids.userId,
		assignmentKey: `${ids.workspaceId}:${ids.userId}:${ids.role}`
	});
	emit('rbac', 'remove_role', {
		userId: ids.userId,
		role: ids.role,
		workspaceId: ids.workspaceId,
		assignmentKey: `${ids.workspaceId}:${ids.userId}:${ids.role}`
	});

	emit('message', 'create', {
		messageId: ids.messageId,
		channelId: ids.channelId,
		senderId: ids.stableUserId,
		createdAt: 1700000000070,
		row: {
			message_id: ids.messageId,
			channel_id: ids.channelId,
			sender_id: ids.stableUserId,
			sender_username: 'SmokeUser',
			message_type: 'text',
			content: 'hello',
			is_spoiler: 0,
			is_pinned: 0,
			is_edited: 0,
			created_at: 1700000000070
		}
	});
	emit('message', 'update', {
		messageId: ids.messageId,
		row: {
			message_id: ids.messageId,
			channel_id: ids.channelId,
			sender_id: ids.stableUserId,
			sender_username: 'SmokeUser',
			message_type: 'text',
			content: 'hello edited',
			is_spoiler: 0,
			is_pinned: 1,
			is_edited: 1,
			reactions_json: '{"thumbs_up":["user-910001"]}',
			created_at: 1700000000070
		}
	});
	emit('message', 'softDelete', {
		messageId: ids.messageId,
		deletedAt: 1700000000080,
		row: {
			message_id: ids.messageId,
			channel_id: ids.channelId,
			sender_id: ids.stableUserId,
			sender_username: 'SmokeUser',
			message_type: 'text',
			content: 'hello edited',
			is_spoiler: 0,
			is_pinned: 1,
			is_edited: 1,
			created_at: 1700000000070,
			deleted_at: 1700000000080
		}
	});
	emit('message', 'create', {
		messageId: ids.otherMessageId,
		channelId: ids.channelId,
		senderId: ids.stableUserId,
		createdAt: 1700000000090,
		row: {
			message_id: ids.otherMessageId,
			channel_id: ids.channelId,
			sender_id: ids.stableUserId,
			sender_username: 'SmokeUser',
			message_type: 'text',
			content: 'other',
			is_spoiler: 0,
			is_pinned: 0,
			is_edited: 0,
			created_at: 1700000000090
		}
	});
	emit('message', 'purgeDeleted', {
		cutoff: 1700000010000,
		messageIds: [ids.messageId]
	});

	emit('channel', 'create', {
		channelId: ids.deleteChannelId,
		channelType: 'group',
		row: {
			channel_id: ids.deleteChannelId,
			channel_type: 'group',
			name: 'Smoke Delete',
			description: '',
			min_role: 'guest',
			created_at: 1700000000100,
			created_by: ids.stableUserId,
			persist_messages: 0,
			is_archived: 0
		}
	});
	emit('channel_member', 'add_member', {
		channelId: ids.deleteChannelId,
		userId: ids.stableUserId,
		role: 'member',
		row: {
			channel_id: ids.deleteChannelId,
			user_id: ids.stableUserId,
			username: 'SmokeUser',
			registered_user_id: ids.userId,
			joined_at: 1700000000110,
			role: 'member'
		}
	});
	emit('message', 'create', {
		messageId: ids.deleteMessageId,
		channelId: ids.deleteChannelId,
		senderId: ids.stableUserId,
		createdAt: 1700000000120,
		row: {
			message_id: ids.deleteMessageId,
			channel_id: ids.deleteChannelId,
			sender_id: ids.stableUserId,
			sender_username: 'SmokeUser',
			message_type: 'text',
			content: 'delete me',
			is_spoiler: 0,
			is_pinned: 0,
			is_edited: 0,
			created_at: 1700000000120
		}
	});
	emit('channel', 'delete', {
		channelId: ids.deleteChannelId
	});
	emit('message', 'clearAll', {
		count: 1
	});

	const channelRows = decodeSqlRows(sql(`SELECT channel_id, archived, row_json FROM state_channel WHERE channel_id = ${escapeSqlLiteral(ids.channelId)} LIMIT 1`).json);
	assert(channelRows.length === 1, 'state_channel main row missing');
	assert(channelRows[0].archived === true, 'state_channel archive projection mismatch');
	const channelJson = JSON.parse(channelRows[0].row_json || '{}');
	assert(channelJson.name === 'Smoke Main Updated', 'state_channel row_json update_settings mismatch');
	assert(channelJson.watch_queue_enabled === 1, 'state_channel row_json watch_queue_enabled mismatch');
	assert(channelJson.avatar === '/uploads/smoke.png', 'state_channel row_json update_avatar mismatch');

	const deletedChannelRows = decodeSqlRows(sql(`SELECT channel_id FROM state_channel WHERE channel_id = ${escapeSqlLiteral(ids.deleteChannelId)} LIMIT 1`).json);
	assert(deletedChannelRows.length === 0, 'state_channel delete did not remove row');

	const userRows = decodeSqlRows(sql(`SELECT user_id, active, deleted, username_lc, handle_lc, row_json FROM state_user WHERE user_id = ${ids.userId} LIMIT 1`).json);
	assert(userRows.length === 1, 'state_user row missing');
	assert(userRows[0].active === false, 'state_user delete projection active mismatch');
	assert(userRows[0].deleted === true, 'state_user delete projection deleted mismatch');
	assert(userRows[0].username_lc === 'smokeuser', 'state_user username_lc mismatch');
	assert(userRows[0].handle_lc === 'smoke_user', 'state_user handle_lc mismatch');

	const memberRows = decodeSqlRows(sql(`SELECT member_key, active, role, row_json FROM state_channel_member WHERE member_key = ${escapeSqlLiteral(`${ids.channelId}:${ids.stableUserId}`)} LIMIT 1`).json);
	assert(memberRows.length === 1, 'state_channel_member row missing');
	assert(memberRows[0].active === false, 'state_channel_member remove projection mismatch');
	assert(memberRows[0].role === 'admin', 'state_channel_member update projection mismatch');

	const deletedMemberRows = decodeSqlRows(sql(`SELECT member_key FROM state_channel_member WHERE member_key = ${escapeSqlLiteral(`${ids.deleteChannelId}:${ids.stableUserId}`)} LIMIT 1`).json);
	assert(deletedMemberRows.length === 0, 'state_channel delete cascade did not remove members');

	const sessionRows = decodeSqlRows(sql(`SELECT session_id, deleted, row_json FROM state_session WHERE session_id = ${escapeSqlLiteral(ids.sessionId)} LIMIT 1`).json);
	assert(sessionRows.length === 1, 'state_session cleanup row missing');
	assert(sessionRows[0].deleted === true, 'state_session cleanup projection mismatch');
	const deletedSessionRows = decodeSqlRows(sql(`SELECT session_id, deleted FROM state_session WHERE session_id = ${escapeSqlLiteral(ids.deleteSessionId)} LIMIT 1`).json);
	assert(deletedSessionRows.length === 1 && deletedSessionRows[0].deleted === true, 'state_session delete projection mismatch');

	const rbacRows = decodeSqlRows(sql(`SELECT assignment_key, active FROM state_rbac_assignment WHERE assignment_key = ${escapeSqlLiteral(`${ids.workspaceId}:${ids.userId}:${ids.role}`)} LIMIT 1`).json);
	assert(rbacRows.length === 1, 'state_rbac_assignment row missing');
	assert(rbacRows[0].active === false, 'state_rbac_assignment remove projection mismatch');

	const messageRows = decodeSqlRows(sql(`SELECT message_id FROM state_message WHERE message_id = ${escapeSqlLiteral(ids.messageId)} LIMIT 1`).json);
	assert(messageRows.length === 0, 'state_message purgeDeleted projection mismatch');
	const deleteMessageRows = decodeSqlRows(sql(`SELECT message_id FROM state_message WHERE message_id = ${escapeSqlLiteral(ids.deleteMessageId)} LIMIT 1`).json);
	assert(deleteMessageRows.length === 0, 'state_channel delete cascade did not remove messages');
	const finalMessageCountRows = decodeSqlRows(sql('SELECT COUNT(*) AS count FROM state_message').json);
	assert(Number(finalMessageCountRows[0]?.count || 0) === 0, 'state_message clearAll projection mismatch');

	const summary = {
		ok: true,
		server: options.server,
		database: options.database,
		reducer: options.reducer,
		eventsApplied: eventCounter,
		checks: [
			'channel:create/update_settings/update_avatar/archive/delete',
			'channel_member:add_member/update_member/remove_member',
			'user:create/update/delete',
			'session:create/update/cleanup/delete',
			'rbac:assign_role/remove_role',
			'message:create/update/softDelete/purgeDeleted/clearAll'
		]
	};

	if (options.json) {
		console.log(JSON.stringify(summary, null, 2));
	} else {
		console.log('[state-plane-stdb-primary-smoke] PASS');
		console.log(`  server=${summary.server}`);
		console.log(`  database=${summary.database}`);
		console.log(`  reducer=${summary.reducer}`);
		console.log(`  eventsApplied=${summary.eventsApplied}`);
	}
}

try {
	main();
} catch (error) {
	console.error('[state-plane-stdb-primary-smoke] FAILED:', error instanceof Error ? error.message : String(error));
	process.exit(1);
}
