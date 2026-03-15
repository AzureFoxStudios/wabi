import { IncomingMessage, ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import { settingsRepository } from '../db/repositories/settingsRepository.js';
import { encryptionKeyRepository } from '../db/repositories/encryptionKeyRepository.js';
import {
	stateUserStore as userRepository,
	stateSessionStore as sessionRepository,
	stateRbacStore
} from '../state-plane/index.js';
import { hashPassword, verifyPassword } from '../auth/passwordHash.js';
import { generateToken } from '../auth/jwt.js';
import { assignRole, getUserRoles } from '../auth/roleMiddleware.js';
import { getAuthenticatedUserIdFromRequest, setAuthCookie } from '../auth/requestAuth.js';

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

// Simple in-memory rate limiting
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const loginCooldownMap = new Map<string, { failCount: number; stage: number; lockUntil: number; lastFailureAt: number }>();
const LOGIN_FAILURE_THRESHOLD = 5;
const LOGIN_COOLDOWN_STEPS_MS = [
	5 * 60 * 1000, // 5 minutes
	10 * 60 * 1000, // 10 minutes
	12 * 60 * 60 * 1000 // 12 hours
];
const LOGIN_STAGE_DECAY_MS = 24 * 60 * 60 * 1000; // 24 hours without failures drops one stage.

// Periodic cleanup of expired rate limit entries (every 5 minutes)
setInterval(() => {
	const now = Date.now();
	for (const [key, entry] of rateLimitMap) {
		if (now > entry.resetTime) rateLimitMap.delete(key);
	}
	for (const [key, entry] of loginCooldownMap) {
		if (now > entry.lockUntil && now - entry.lastFailureAt > LOGIN_STAGE_DECAY_MS) {
			loginCooldownMap.delete(key);
		}
	}
}, 5 * 60 * 1000).unref();

function checkRateLimit(key: string, maxAttempts: number, windowMs: number): boolean {
	const now = Date.now();
	const entry = rateLimitMap.get(key);

	if (!entry || now > entry.resetTime) {
		rateLimitMap.set(key, { count: 1, resetTime: now + windowMs });
		return true;
	}

	if (entry.count >= maxAttempts) {
		return false;
	}

	entry.count++;
	return true;
}

function normalizeLoginIdentifier(identifier: string): string {
	return identifier.trim().replace(/^@/, '').toLowerCase();
}

function normalizeIpIdentifier(ip: string): string {
	return `ip:${ip.trim().toLowerCase()}`;
}

function formatDuration(ms: number): string {
	const seconds = Math.max(1, Math.ceil(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.ceil(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.ceil(minutes / 60);
	return `${hours}h`;
}

function getCooldownMessage(stage: number, remainingMs: number): string {
	const duration = formatDuration(remainingMs);
	if (stage <= 0) {
		return `Invalid credentials. Cooldown warning: try again in ${duration}.`;
	}
	if (stage === 1) {
		return `Invalid credentials. Second cooldown triggered. Try again in ${duration}.`;
	}
	return `Invalid credentials. Long lockout triggered. Try again in ${duration}.`;
}

function applyLoginDecay(identifier: string): void {
	const key = normalizeLoginIdentifier(identifier);
	if (!key) return;
	const entry = loginCooldownMap.get(key);
	if (!entry) return;
	const now = Date.now();
	if (entry.lastFailureAt <= 0) return;
	const elapsed = now - entry.lastFailureAt;
	if (elapsed < LOGIN_STAGE_DECAY_MS) return;

	const decaySteps = Math.floor(elapsed / LOGIN_STAGE_DECAY_MS);
	const nextStage = Math.max(-1, entry.stage - decaySteps);
	const nextLockUntil = entry.lockUntil > now ? entry.lockUntil : 0;

	if (nextStage === -1 && nextLockUntil === 0) {
		loginCooldownMap.delete(key);
		return;
	}

	loginCooldownMap.set(key, {
		failCount: 0,
		stage: nextStage,
		lockUntil: nextLockUntil,
		lastFailureAt: now
	});
}

function getActiveLoginCooldown(identifier: string): { remainingMs: number; stage: number } | null {
	const key = normalizeLoginIdentifier(identifier);
	if (!key) return null;
	applyLoginDecay(key);
	const entry = loginCooldownMap.get(key);
	if (!entry) return null;
	const now = Date.now();
	if (entry.lockUntil <= now) return null;
	return {
		remainingMs: entry.lockUntil - now,
		stage: entry.stage
	};
}

function recordFailedLogin(identifier: string): { locked: boolean; stage: number; remainingMs?: number } {
	const key = normalizeLoginIdentifier(identifier);
	if (!key) return { locked: false, stage: 0 };
	applyLoginDecay(key);
	const now = Date.now();
	const current = loginCooldownMap.get(key);
	const baseline = !current || current.lockUntil <= now
		? { failCount: 0, stage: current?.stage ?? -1, lockUntil: 0, lastFailureAt: current?.lastFailureAt ?? now }
		: current;

	const failCount = baseline.failCount + 1;
	if (failCount < LOGIN_FAILURE_THRESHOLD) {
		loginCooldownMap.set(key, { ...baseline, failCount, lastFailureAt: now });
		return { locked: false, stage: baseline.stage + 1 };
	}

	const nextStage = Math.min(baseline.stage + 1, LOGIN_COOLDOWN_STEPS_MS.length - 1);
	const durationMs = LOGIN_COOLDOWN_STEPS_MS[nextStage];
	loginCooldownMap.set(key, { failCount: 0, stage: nextStage, lockUntil: now + durationMs, lastFailureAt: now });
	return { locked: true, stage: nextStage, remainingMs: durationMs };
}

function clearLoginFailureState(identifier: string): void {
	const key = normalizeLoginIdentifier(identifier);
	if (!key) return;
	loginCooldownMap.delete(key);
}

function clearLoginFailureStateForIp(ip: string): void {
	const key = normalizeIpIdentifier(ip);
	if (!key) return;
	loginCooldownMap.delete(key);
}

function getActiveIpCooldown(ip: string): { remainingMs: number; stage: number } | null {
	const key = normalizeIpIdentifier(ip);
	if (!key) return null;
	applyLoginDecay(key);
	const entry = loginCooldownMap.get(key);
	if (!entry) return null;
	const now = Date.now();
	if (entry.lockUntil <= now) return null;
	return { remainingMs: entry.lockUntil - now, stage: entry.stage };
}

function recordFailedIpLogin(ip: string): void {
	const key = normalizeIpIdentifier(ip);
	if (!key) return;
	recordFailedLogin(key);
}

function highestRoleLevel(roles: string[]): number {
	if (roles.includes('owner')) return 3;
	if (roles.includes('admin')) return 2;
	if (roles.includes('mod')) return 1;
	return 0;
}

// Validate username and password
function validateInput(username: string, password: string): { valid: boolean; error?: string } {
	if (!username || username.trim().length < 2) {
		return { valid: false, error: 'Username must be at least 2 characters' };
	}

	if (!password || password.length < 8) {
		return { valid: false, error: 'Password must be at least 8 characters' };
	}

	if (!/[a-z]/.test(password)) {
		return { valid: false, error: 'Password must contain at least one lowercase letter' };
	}
	if (!/[A-Z]/.test(password)) {
		return { valid: false, error: 'Password must contain at least one uppercase letter' };
	}
	if (!/[0-9]/.test(password)) {
		return { valid: false, error: 'Password must contain at least one number' };
	}

	if (username.length > 32) {
		return { valid: false, error: 'Username must be less than 32 characters' };
	}

	return { valid: true };
}

// Parse JSON body
function parseBody(req: IncomingMessage): Promise<Record<string, any>> {
	return new Promise((resolve, reject) => {
		let body = '';

		req.on('data', (chunk) => {
			body += chunk.toString();
		});

		req.on('end', () => {
			try {
				resolve(JSON.parse(body));
			} catch (error) {
				reject(new Error('Invalid JSON'));
			}
		});

		req.on('error', reject);
	});
}

// Generate a color for new users
function generateColor(): string {
	const colors = [
		'#FF6B6B', // Red
		'#4ECDC4', // Teal
		'#45B7D1', // Blue
		'#FFA07A', // Orange
		'#98D8C8', // Mint
		'#F7DC6F', // Yellow
		'#BB8FCE', // Purple
		'#85C1E2' // Light Blue
	];
	return colors[Math.floor(Math.random() * colors.length)];
}

function generateRegisteredSessionId(): string {
	return `reg-${Date.now()}-${randomBytes(18).toString('base64url')}`;
}

async function revokeRegisteredSessionsForUser(userId: number): Promise<number> {
	if (typeof (sessionRepository as { deleteRegisteredByUserIdAsync?: (targetUserId: number) => Promise<number> }).deleteRegisteredByUserIdAsync === 'function') {
		return await (sessionRepository as { deleteRegisteredByUserIdAsync: (targetUserId: number) => Promise<number> }).deleteRegisteredByUserIdAsync(userId);
	}
	return sessionRepository.deleteRegisteredByUserId(userId);
}

async function createRegisteredUser(
	user: Omit<Parameters<typeof userRepository.create>[0], never>
) {
	if (typeof (userRepository as { createAsync?: (payload: Omit<Parameters<typeof userRepository.create>[0], never>) => Promise<ReturnType<typeof userRepository.create>> }).createAsync === 'function') {
		return await (userRepository as {
			createAsync: (payload: Omit<Parameters<typeof userRepository.create>[0], never>) => Promise<ReturnType<typeof userRepository.create>>
		}).createAsync(user);
	}
	return userRepository.create(user);
}

async function createRegisteredSession(
	session: Parameters<typeof sessionRepository.create>[0]
): Promise<void> {
	if (typeof (sessionRepository as { createAsync?: (payload: Parameters<typeof sessionRepository.create>[0]) => Promise<void> }).createAsync === 'function') {
		await (sessionRepository as {
			createAsync: (payload: Parameters<typeof sessionRepository.create>[0]) => Promise<void>
		}).createAsync(session);
		return;
	}
	sessionRepository.create(session);
}

function getTestingAutoRole(): 'owner' | 'admin' | null {
	const configuredRole = (process.env.WABI_TEST_AUTO_ROLE || '').trim().toLowerCase();
	if (configuredRole === 'owner' || configuredRole === 'admin') {
		return configuredRole;
	}
	return null;
}

function maybeAutoAssignTestingRole(userId: number, username: string): void {
	const autoRole = getTestingAutoRole();
	if (!autoRole) return;

	assignRole(userId, autoRole, 'default-workspace');
	console.log(`[Auth] [TEST] Auto-assigned '${autoRole}' role to ${username} (user_id=${userId})`);
}

function maybeAssignWorkspaceOwnerIfMissing(userId: number, username: string): void {
	const workspaceId = 'default-workspace';
	if (stateRbacStore.workspaceHasOwner(workspaceId)) return;
	assignRole(userId, 'owner', workspaceId);
	console.log(`[Auth] Auto-assigned 'owner' role to ${username} (user_id=${userId}) because workspace ${workspaceId} had no owner`);
}

export async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const clientIp = req.socket.remoteAddress || 'unknown';
		const rateLimitKey = `register:${clientIp}`;

		// Rate limit: 5 registrations per 15 minutes
		if (!checkRateLimit(rateLimitKey, 5, 15 * 60 * 1000)) {
			res.writeHead(429, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Too many registration attempts. Try again later.' }));
			return;
		}

		const body = await parseBody(req);
		const { username, password, handle: rawHandle } = body;
		const normalizedUsername = typeof username === 'string' ? username.trim() : '';
		const normalizedPassword = typeof password === 'string' ? password : '';
		const normalizedRawHandle = typeof rawHandle === 'string' ? rawHandle.trim() : '';

		// Validate input
		const validation = validateInput(normalizedUsername, normalizedPassword);
		if (!validation.valid) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: validation.error }));
			return;
		}

		// Validate and normalize handle
		const handle = (normalizedRawHandle || normalizedUsername.replace(/\s+/g, ''))
			.replace(/^@/, '')
			.toLowerCase();

		if (!/^[a-z][a-z0-9_]{1,31}$/.test(handle)) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Handle must start with a letter, be 2-32 chars, and contain only lowercase letters, numbers, and underscores' }));
			return;
		}

		// Check if username already exists
		if (userRepository.findByUsername(normalizedUsername)) {
			res.writeHead(409, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Username already taken' }));
			return;
		}

		// Check if handle already exists
		if (userRepository.findByHandle(handle)) {
			res.writeHead(409, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Handle already taken' }));
			return;
		}

		// Hash password and create user
		const passwordHash = await hashPassword(normalizedPassword);
		const user = await createRegisteredUser({
			username: normalizedUsername,
			handle,
			password_hash: passwordHash,
			created_at: Date.now(),
			color: generateColor()
		});
		maybeAutoAssignTestingRole(user.user_id!, user.username);
		maybeAssignWorkspaceOwnerIfMissing(user.user_id!, user.username);

		// Create settings with defaults
		await settingsRepository.setAsync(user.user_id!, {
			offline_message_retention: '7d',
			allow_temp_user_messages: 1,
			home_experience: 'community'
		});

		// Create session
		const sessionId = generateRegisteredSessionId();
		await createRegisteredSession({
			session_id: sessionId,
			user_id: user.user_id!,
			username: user.username,
			color: user.color,
			created_at: Date.now(),
			expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
			is_temporary: 0
		});

		// Generate token
		const token = generateToken({
			sessionId,
			userId: user.user_id,
			isTemporary: false
		});

		setAuthCookie(res, token, SESSION_MAX_AGE_SECONDS);
		res.writeHead(201, { 'Content-Type': 'application/json' });
		res.end(
			JSON.stringify({
				token,
				mustChangePassword: false,
				user: {
					id: user.user_id,
					username: user.username,
					handle: user.handle,
					color: user.color,
					profilePicture: user.profile_picture,
					isRegistered: true
				}
			})
		);
	} catch (error) {
		console.error('[Auth] Register error:', error);
		const msg = error instanceof Error ? error.message : '';
		if (
			(msg.includes('UNIQUE constraint failed') && msg.includes('handle')) ||
			msg.includes('users_handle_key')
		) {
			res.writeHead(409, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Handle already taken' }));
		} else if (
			(msg.includes('UNIQUE constraint failed') && msg.includes('username')) ||
			msg.includes('users_username_key')
		) {
			res.writeHead(409, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Username already taken' }));
		} else {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Registration failed — please try again' }));
		}
	}
}

export async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const clientIp = req.socket.remoteAddress || 'unknown';
		const rateLimitKey = `login:${clientIp}`;

		// Coarse IP-level protection: keep this loose and let per-account cooldowns do the detailed work.
		if (!checkRateLimit(rateLimitKey, 120, 5 * 60 * 1000)) {
			res.writeHead(429, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Too many login requests from this network. Try again shortly.' }));
			return;
		}

		const body = await parseBody(req);
		const { username, password } = body;
		const normalizedUsername = typeof username === 'string' ? username.trim() : '';
		const normalizedPassword = typeof password === 'string' ? password : '';

		console.log('[Auth] Login attempt for:', normalizedUsername);

		// Validate input
		if (!normalizedUsername || !normalizedPassword) {
			console.log('[Auth] Missing username or password');
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Username or handle and password required' }));
			return;
		}

		const activeIpCooldown = getActiveIpCooldown(clientIp);
		if (activeIpCooldown) {
			res.writeHead(429, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				error: `Too many failed logins from this network. Try again in ${formatDuration(activeIpCooldown.remainingMs)}.`,
				code: 'IP_LOGIN_COOLDOWN',
				retry_after_ms: activeIpCooldown.remainingMs
			}));
			return;
		}

		const activeCooldown = getActiveLoginCooldown(normalizedUsername);
		if (activeCooldown) {
			res.writeHead(429, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				error: `Too many failed logins. Try again in ${formatDuration(activeCooldown.remainingMs)}.`,
				code: 'LOGIN_COOLDOWN',
				retry_after_ms: activeCooldown.remainingMs
			}));
			return;
		}

		// Find user by handle or username
		const user = userRepository.findByHandleOrUsername(normalizedUsername);
		if (!user) {
			console.log('[Auth] User not found for:', normalizedUsername);
			const lockState = recordFailedLogin(normalizedUsername);
			recordFailedIpLogin(clientIp);
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				error: lockState.locked ? getCooldownMessage(lockState.stage, lockState.remainingMs || 0) : 'Invalid credentials'
			}));
			return;
		}
		if (user.is_active === 0) {
			console.log('[Auth] Blocked login for inactive user:', normalizedUsername);
			recordFailedLogin(normalizedUsername);
			recordFailedIpLogin(clientIp);
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid credentials' }));
			return;
		}

		console.log('[Auth] User found:', user.user_id, user.username);

		// Verify password
		const isValid = await verifyPassword(normalizedPassword, user.password_hash);
		console.log('[Auth] Password verification result:', isValid);
		if (!isValid) {
			console.log('[Auth] Password mismatch for user:', normalizedUsername);
			const lockState = recordFailedLogin(normalizedUsername);
			recordFailedIpLogin(clientIp);
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				error: lockState.locked ? getCooldownMessage(lockState.stage, lockState.remainingMs || 0) : 'Invalid credentials'
			}));
			return;
		}
		clearLoginFailureState(normalizedUsername);
		clearLoginFailureStateForIp(clientIp);
		maybeAssignWorkspaceOwnerIfMissing(user.user_id!, user.username);
		const userSettings = settingsRepository.get(user.user_id!);

		// Enforce a single active login session per registered user.
		await revokeRegisteredSessionsForUser(user.user_id!);

		// Create session
		const sessionId = generateRegisteredSessionId();
		await createRegisteredSession({
			session_id: sessionId,
			user_id: user.user_id,
			username: user.username,
			color: user.color,
			profile_picture: user.profile_picture,
			created_at: Date.now(),
			expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
			is_temporary: 0
		});

		// Generate token
		const token = generateToken({
			sessionId,
			userId: user.user_id,
			isTemporary: false
		});

		setAuthCookie(res, token, SESSION_MAX_AGE_SECONDS);
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(
			JSON.stringify({
				token,
				mustChangePassword: userSettings.require_password_change === 1,
				user: {
					id: user.user_id,
					username: user.username,
					handle: user.handle,
					color: user.color,
					profilePicture: user.profile_picture,
					isRegistered: true
				}
			})
		);
	} catch (error) {
		console.error('[Auth] Login error:', error);
		const msg = error instanceof Error ? error.message : '';
		if (msg.includes('no such column') || msg.includes('handle')) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Server database needs migration' }));
		} else {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Login failed' }));
		}
	}
}

export async function handleChangePassword(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const userId = getAuthenticatedUserIdFromRequest(req);
		if (!userId) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'User not authenticated' }));
			return;
		}

		const body = await parseBody(req);
		const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
		const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

		if (!currentPassword || !newPassword) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Current and new passwords are required' }));
			return;
		}

		if (newPassword.length < 8) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'New password must be at least 8 characters' }));
			return;
		}
		if (!/[a-z]/.test(newPassword) || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'New password must contain uppercase, lowercase, and a number' }));
			return;
		}

		const user = userRepository.findById(userId);
		if (!user) {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'User not found' }));
			return;
		}

		const currentMatches = await verifyPassword(currentPassword, user.password_hash);
		if (!currentMatches) {
			res.writeHead(403, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Current password is incorrect' }));
			return;
		}

		const nextHash = await hashPassword(newPassword);
		userRepository.update(userId, { password_hash: nextHash });
		await settingsRepository.setAsync(userId, { require_password_change: 0 });

		// Revoke all existing sessions so stolen tokens are invalidated
		await revokeRegisteredSessionsForUser(userId);

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ success: true }));
	} catch (error) {
		console.error('[Auth] Change password error:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to change password' }));
	}
}

export async function handleAdminResetUserPassword(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const actorUserId = getAuthenticatedUserIdFromRequest(req);
		if (!actorUserId) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'User not authenticated' }));
			return;
		}

		const actorRoles = getUserRoles(actorUserId, 'default-workspace');
		const actorLevel = highestRoleLevel(actorRoles);
		if (actorLevel < 2) {
			res.writeHead(403, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Admin access required' }));
			return;
		}

		const body = await parseBody(req);
		const targetUserId = Number(body.targetUserId);
		const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
		const temporary = body.temporary === true;

		if (!Number.isFinite(targetUserId) || targetUserId <= 0 || !newPassword) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Target user and new password are required' }));
			return;
		}

		if (targetUserId === actorUserId) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Use your own password change flow for your account' }));
			return;
		}

		if (newPassword.length < 8) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'New password must be at least 8 characters' }));
			return;
		}

		const targetUser = userRepository.findById(targetUserId);
		if (!targetUser) {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Target user not found' }));
			return;
		}

		const targetRoles = getUserRoles(targetUserId, 'default-workspace');
		const targetLevel = highestRoleLevel(targetRoles);
		if (actorLevel <= targetLevel) {
			res.writeHead(403, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Insufficient privileges to reset this user password' }));
			return;
		}

		const nextHash = await hashPassword(newPassword);
		userRepository.update(targetUserId, { password_hash: nextHash });
		await settingsRepository.setAsync(targetUserId, {
			require_password_change: temporary ? 1 : 0
		});
		await revokeRegisteredSessionsForUser(targetUserId);
		clearLoginFailureState(targetUser.username);
		if (targetUser.handle) clearLoginFailureState(targetUser.handle);

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ success: true, temporary }));
	} catch (error) {
		console.error('[Auth] Admin reset password error:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to reset user password' }));
	}
}

export async function handleAdminClearLoginLockout(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const actorUserId = getAuthenticatedUserIdFromRequest(req);
		if (!actorUserId) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'User not authenticated' }));
			return;
		}

		const actorRoles = getUserRoles(actorUserId, 'default-workspace');
		const actorLevel = highestRoleLevel(actorRoles);
		if (actorLevel < 2) {
			res.writeHead(403, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Admin access required' }));
			return;
		}

		const body = await parseBody(req);
		const targetUserId = Number(body.targetUserId);
		const identifier = typeof body.identifier === 'string' ? body.identifier.trim() : '';
		const ip = typeof body.ip === 'string' ? body.ip.trim() : '';

		let cleared = 0;

		if (Number.isFinite(targetUserId) && targetUserId > 0) {
			const targetUser = userRepository.findById(targetUserId);
			if (targetUser) {
				const targetRoles = getUserRoles(targetUserId, 'default-workspace');
				const targetLevel = highestRoleLevel(targetRoles);
				if (actorLevel <= targetLevel) {
					res.writeHead(403, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'Insufficient privileges to clear lockout for this user' }));
					return;
				}
				const beforeSize = loginCooldownMap.size;
				clearLoginFailureState(targetUser.username);
				if (targetUser.handle) clearLoginFailureState(targetUser.handle);
				cleared += beforeSize - loginCooldownMap.size;
			}
		}

		if (identifier) {
			const beforeSize = loginCooldownMap.size;
			clearLoginFailureState(identifier);
			cleared += beforeSize - loginCooldownMap.size;
		}

		if (ip) {
			const beforeSize = loginCooldownMap.size;
			clearLoginFailureStateForIp(ip);
			cleared += beforeSize - loginCooldownMap.size;
		}

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ success: true, cleared }));
	} catch (error) {
		console.error('[Auth] Admin clear login lockout error:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to clear login lockout' }));
	}
}

export async function handleUpgrade(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const body = await parseBody(req);
		const { sessionId, password } = body;

		if (!sessionId || !password) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Session ID and password required' }));
			return;
		}

		// Validate password
		const validation = validateInput('temp', password); // Just validate password
		if (!validation.valid) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: validation.error }));
			return;
		}

		// Find temp session
		const tempSession = sessionRepository.findById(sessionId);
		if (!tempSession || !tempSession.is_temporary) {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Session not found' }));
			return;
		}

		// Check if username already registered
		if (userRepository.findByUsername(tempSession.username)) {
			res.writeHead(409, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Username already taken' }));
			return;
		}

		// Generate handle from username
		const handle = tempSession.username.replace(/\s+/g, '').toLowerCase();

		// Check if handle already taken
		if (userRepository.findByHandle(handle)) {
			res.writeHead(409, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Handle already taken — please register with a different username' }));
			return;
		}

		// Hash password and create registered user
		const passwordHash = await hashPassword(password);
		const user = userRepository.create({
			username: tempSession.username,
			handle,
			password_hash: passwordHash,
			created_at: tempSession.created_at,
			color: tempSession.color,
			profile_picture: tempSession.profile_picture
		});
		maybeAutoAssignTestingRole(user.user_id!, user.username);
		maybeAssignWorkspaceOwnerIfMissing(user.user_id!, user.username);

		// Create settings with defaults
		settingsRepository.set(user.user_id!, {
			offline_message_retention: '7d',
			allow_temp_user_messages: 1,
			home_experience: 'community'
		});

		// Update session to be registered
		const newSessionId = generateRegisteredSessionId();
		sessionRepository.delete(sessionId);
		sessionRepository.create({
			session_id: newSessionId,
			user_id: user.user_id,
			username: user.username,
			color: user.color,
			profile_picture: user.profile_picture,
			created_at: Date.now(),
			expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000,
			is_temporary: 0
		});

		// Generate token
		const token = generateToken({
			sessionId: newSessionId,
			userId: user.user_id,
			isTemporary: false
		});

		setAuthCookie(res, token, SESSION_MAX_AGE_SECONDS);
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(
			JSON.stringify({
				token,
				user: {
					id: user.user_id,
					username: user.username,
					handle: user.handle,
					color: user.color,
					profilePicture: user.profile_picture,
					isRegistered: true
				}
			})
		);
	} catch (error) {
		console.error('[Auth] Upgrade error:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Upgrade failed' }));
	}
}

// Get user settings
export async function handleGetUserSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const userId = getAuthenticatedUserIdFromRequest(req);
		if (!userId) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'User not authenticated' }));
			return;
		}

		// Get settings from database
		const settings = settingsRepository.get(userId);

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			offline_message_retention: settings.offline_message_retention,
			allow_temp_user_messages: settings.allow_temp_user_messages === 1,
			home_experience: settings.home_experience || 'community',
			require_password_change: settings.require_password_change === 1,
			payment_preferred_route: settings.payment_preferred_route || null
		}));
	} catch (error) {
		console.error('[Auth] Get settings error:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to load settings' }));
	}
}

// Get public key for a user
export async function handleGetPublicKey(req: IncomingMessage, res: ServerResponse, userId: number): Promise<void> {
	try {
		const authUserId = getAuthenticatedUserIdFromRequest(req);
		if (!authUserId) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Not authenticated' }));
			return;
		}

		const publicKey = encryptionKeyRepository.getPublicKey(userId);
		if (!publicKey) {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'No encryption keys found for this user' }));
			return;
		}

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ publicKey }));
	} catch (error) {
		console.error('[Auth] Get public key error:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to get public key' }));
	}
}

// Store or update encryption keys for the authenticated user
export async function handleStoreEncryptionKeys(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const userId = getAuthenticatedUserIdFromRequest(req);
		if (!userId) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Not authenticated' }));
			return;
		}

		const body = await parseBody(req);
		const { publicKey, privateKeyEncrypted } = body;

		if (!publicKey || !privateKeyEncrypted) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'publicKey and privateKeyEncrypted are required' }));
			return;
		}

		// Create or update encryption keys
		if (encryptionKeyRepository.hasKeys(userId)) {
			encryptionKeyRepository.update(userId, publicKey, privateKeyEncrypted);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ success: true }));
		} else {
			encryptionKeyRepository.create(userId, publicKey, privateKeyEncrypted);
			res.writeHead(201, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ success: true }));
		}
	} catch (error) {
		console.error('[Auth] Store encryption keys error:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to store encryption keys' }));
	}
}

// Save user settings
export async function handleSaveUserSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const userId = getAuthenticatedUserIdFromRequest(req);
		if (!userId) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'User not authenticated' }));
			return;
		}

		// Parse request body
		const body = await parseBody(req);
		const { offline_message_retention, allow_temp_user_messages, home_experience, payment_preferred_route } = body;

		// Validate retention period
		const validRetentions = ['1d', '7d', '30d', 'forever'];
		if (offline_message_retention && !validRetentions.includes(offline_message_retention)) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid retention period' }));
			return;
		}

		const validHomeExperiences = ['community', 'conversations'];
		if (home_experience !== undefined && !validHomeExperiences.includes(home_experience)) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid home experience mode' }));
			return;
		}

		let normalizedPreferredRoute: string | null | undefined;
		if (payment_preferred_route !== undefined) {
			if (payment_preferred_route === null || payment_preferred_route === '') {
				normalizedPreferredRoute = null;
			} else if (
				typeof payment_preferred_route === 'string' &&
				/^[A-Za-z]{2,8}$/.test(payment_preferred_route.trim())
			) {
				normalizedPreferredRoute = payment_preferred_route.trim().toUpperCase();
			} else {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Invalid payment preferred route' }));
				return;
			}
		}

		const existing = settingsRepository.get(userId);

		// Save settings
		settingsRepository.set(userId, {
			offline_message_retention: offline_message_retention || existing.offline_message_retention || '7d',
			allow_temp_user_messages:
				allow_temp_user_messages === undefined
					? existing.allow_temp_user_messages
					: allow_temp_user_messages ? 1 : 0,
			home_experience: home_experience || existing.home_experience || 'community',
			payment_preferred_route:
				normalizedPreferredRoute === undefined
					? existing.payment_preferred_route || null
					: normalizedPreferredRoute
		});

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ success: true }));
	} catch (error) {
		console.error('[Auth] Save settings error:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to save settings' }));
	}
}
