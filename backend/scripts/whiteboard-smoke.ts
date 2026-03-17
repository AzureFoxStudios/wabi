import { randomBytes } from 'crypto';
import { existsSync, unlinkSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

type UserRow = {
	user_id: number;
	username: string;
	color: string;
	profile_picture: string | null;
};

type ChannelRow = {
	channel_id: string;
	name: string;
	channel_type: string;
	min_role: string | null;
};

type DatabaseLike = {
	prepare: (sql: string) => {
		get: () => unknown;
	};
};

const ONE_BY_ONE_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9p6vF2sAAAAASUVORK5CYII=',
	'base64'
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..', '..');

process.env.DATA_DIR = join(repoRoot, 'data');
process.env.DATABASE_PATH = join(process.env.DATA_DIR, 'chat.db');
process.env.UPLOADS_DIR = join(repoRoot, 'uploads');

function getBaseUrl(): string {
	const configured = process.env.WABI_SMOKE_BASE_URL?.trim();
	if (configured) {
		return configured.replace(/\/+$/, '');
	}
	const port = (process.env.PORT || '8080').trim() || '8080';
	return `http://127.0.0.1:${port}`;
}

function requireSmokeUser(db: DatabaseLike): UserRow {
	const user = db
		.prepare(
			`
			SELECT user_id, username, color, profile_picture
			FROM users
			WHERE is_active = 1
			ORDER BY user_id ASC
			LIMIT 1
		`
		)
		.get() as UserRow | undefined;

	if (!user) {
		throw new Error('No active registered user found for whiteboard smoke test.');
	}
	return user;
}

function requireSmokeChannel(db: DatabaseLike): ChannelRow {
	const channel = db
		.prepare(
			`
			SELECT channel_id, name, channel_type, min_role
			FROM channels
			WHERE channel_type NOT IN ('dm', 'group', 'thread_private')
			ORDER BY
				CASE channel_type
					WHEN 'text' THEN 0
					WHEN 'public' THEN 1
					WHEN 'thread_public' THEN 2
					ELSE 3
				END,
				channel_id ASC
			LIMIT 1
		`
		)
		.get() as ChannelRow | undefined;

	if (!channel) {
		throw new Error('No eligible channel found for whiteboard smoke test.');
	}
	return channel;
}

async function expectOk(response: Response, context: string): Promise<any> {
	const payload = await response.json().catch(() => null);
	if (!response.ok) {
		throw new Error(`${context} failed (${response.status}): ${JSON.stringify(payload)}`);
	}
	return payload;
}

async function main(): Promise<void> {
	const [{ default: db }, { generateToken }, { sessionRepository }, { whiteboardRepository }, { UPLOADS_DIR }] =
		await Promise.all([
			import('../src/db/database.js'),
			import('../src/auth/jwt.js'),
			import('../src/db/repositories/sessionRepository.js'),
			import('../src/db/repositories/whiteboardRepository.js'),
			import('../src/constants.js')
		]);

	const baseUrl = getBaseUrl();
	const user = requireSmokeUser(db);
	const channel = requireSmokeChannel(db);
	const board = whiteboardRepository.getOrCreateForChannel(channel.channel_id, `user-${user.user_id}`);

	const createdAt = Date.now();
	const sessionId = `whiteboard-smoke-${randomBytes(8).toString('hex')}`;
	const expiresAt = createdAt + 60 * 60 * 1000;
	const session = {
		session_id: sessionId,
		user_id: user.user_id,
		username: user.username,
		color: user.color,
		profile_picture: user.profile_picture || undefined,
		created_at: createdAt,
		expires_at: expiresAt,
		is_temporary: 0,
		socket_id: null,
		last_seen: createdAt
	};

	let uploadedFileId = '';
	try {
		sessionRepository.create(session);
		const token = generateToken({
			sessionId,
			userId: user.user_id,
			isTemporary: false
		});

		const formData = new FormData();
		formData.append('file', new Blob([ONE_BY_ONE_PNG], { type: 'image/png' }), 'whiteboard-smoke.png');

		const uploadResponse = await fetch(
			`${baseUrl}/api/whiteboard/boards/${encodeURIComponent(board.boardId)}/images`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`
				},
				body: formData
			}
		);
		const uploadPayload = await expectOk(uploadResponse, 'Whiteboard image upload');
		if (typeof uploadPayload?.fileId !== 'string' || uploadPayload.fileId.trim().length === 0) {
			throw new Error(`Whiteboard image upload returned no fileId: ${JSON.stringify(uploadPayload)}`);
		}
		if (typeof uploadPayload?.fileUrl !== 'string' || !/\/api\/whiteboard\/boards\/.+\/files\/.+/.test(uploadPayload.fileUrl)) {
			throw new Error(`Whiteboard image upload returned unexpected fileUrl: ${JSON.stringify(uploadPayload)}`);
		}
		uploadedFileId = uploadPayload.fileId;

		const readUrl = new URL(uploadPayload.fileUrl, `${baseUrl}/`).toString();
		const authorizedRead = await fetch(readUrl, {
			headers: {
				Authorization: `Bearer ${token}`
			}
		});
		if (!authorizedRead.ok) {
			throw new Error(`Authorized whiteboard file read failed (${authorizedRead.status})`);
		}
		const contentType = authorizedRead.headers.get('content-type') || '';
		if (!contentType.toLowerCase().startsWith('image/png')) {
			throw new Error(`Authorized whiteboard file read returned unexpected content-type: ${contentType}`);
		}
		const readBytes = Buffer.from(await authorizedRead.arrayBuffer());
		if (readBytes.length !== ONE_BY_ONE_PNG.length) {
			throw new Error(`Authorized whiteboard file read returned ${readBytes.length} bytes, expected ${ONE_BY_ONE_PNG.length}`);
		}

		const headResponse = await fetch(readUrl, {
			method: 'HEAD',
			headers: {
				Authorization: `Bearer ${token}`
			}
		});
		if (!headResponse.ok) {
			throw new Error(`Whiteboard file HEAD failed (${headResponse.status})`);
		}

		const unauthorizedRead = await fetch(readUrl);
		if (unauthorizedRead.ok) {
			throw new Error('Whiteboard file read unexpectedly succeeded without authentication.');
		}

		console.log(
			JSON.stringify(
				{
					ok: true,
					baseUrl,
					userId: user.user_id,
					username: user.username,
					channelId: channel.channel_id,
					channelType: channel.channel_type,
					boardId: board.boardId,
					fileId: uploadedFileId,
					unauthorizedStatus: unauthorizedRead.status
				},
				null,
				2
			)
		);
	} finally {
		sessionRepository.delete(sessionId);

		if (uploadedFileId) {
			const candidate = join(UPLOADS_DIR, uploadedFileId);
			if (existsSync(candidate)) {
				try {
					unlinkSync(candidate);
				} catch (error) {
					console.warn(`[whiteboard-smoke] Failed to delete temporary upload ${uploadedFileId}:`, error);
				}
			}
		}
	}
}

main().catch((error) => {
	console.error('[whiteboard-smoke] FAILED', error);
	process.exitCode = 1;
});
