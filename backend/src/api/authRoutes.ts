import { IncomingMessage, ServerResponse } from 'http';
import { userRepository } from '../db/repositories/userRepository.js';
import { sessionRepository } from '../db/repositories/sessionRepository.js';
import { settingsRepository } from '../db/repositories/settingsRepository.js';
import { hashPassword, verifyPassword } from '../auth/passwordHash.js';
import { generateToken } from '../auth/jwt.js';

// Simple in-memory rate limiting
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();

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

// Validate username and password
function validateInput(username: string, password: string): { valid: boolean; error?: string } {
	if (!username || username.trim().length < 2) {
		return { valid: false, error: 'Username must be at least 2 characters' };
	}

	if (!password || password.length < 8) {
		return { valid: false, error: 'Password must be at least 8 characters' };
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
		const { username, password } = body;

		// Validate input
		const validation = validateInput(username, password);
		if (!validation.valid) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: validation.error }));
			return;
		}

		// Check if username already exists
		if (userRepository.findByUsername(username)) {
			res.writeHead(409, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Username already taken' }));
			return;
		}

		// Hash password and create user
		const passwordHash = await hashPassword(password);
		const user = userRepository.create({
			username,
			password_hash: passwordHash,
			created_at: Date.now(),
			color: generateColor()
		});

		// Create settings with defaults
		settingsRepository.set(user.user_id!, {
			offline_message_retention: '7d',
			allow_temp_user_messages: 1
		});

		// Create session
		const sessionId = `reg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		sessionRepository.create({
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

		res.writeHead(201, { 'Content-Type': 'application/json' });
		res.end(
			JSON.stringify({
				token,
				user: {
					id: user.user_id,
					username: user.username,
					color: user.color,
					isRegistered: true
				}
			})
		);
	} catch (error) {
		console.error('[Auth] Register error:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Registration failed' }));
	}
}

export async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const clientIp = req.socket.remoteAddress || 'unknown';
		const rateLimitKey = `login:${clientIp}`;

		// Rate limit: 10 login attempts per 5 minutes
		if (!checkRateLimit(rateLimitKey, 10, 5 * 60 * 1000)) {
			res.writeHead(429, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Too many login attempts. Try again later.' }));
			return;
		}

		const body = await parseBody(req);
		const { username, password } = body;

		// Validate input
		if (!username || !password) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Username and password required' }));
			return;
		}

		// Find user
		const user = userRepository.findByUsername(username);
		if (!user) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid credentials' }));
			return;
		}

		// Verify password
		const isValid = await verifyPassword(password, user.password_hash);
		if (!isValid) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid credentials' }));
			return;
		}

		// Create session
		const sessionId = `reg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		sessionRepository.create({
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

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(
			JSON.stringify({
				token,
				user: {
					id: user.user_id,
					username: user.username,
					color: user.color,
					profilePicture: user.profile_picture,
					isRegistered: true
				}
			})
		);
	} catch (error) {
		console.error('[Auth] Login error:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Login failed' }));
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

		// Hash password and create registered user
		const passwordHash = await hashPassword(password);
		const user = userRepository.create({
			username: tempSession.username,
			password_hash: passwordHash,
			created_at: tempSession.created_at,
			color: tempSession.color,
			profile_picture: tempSession.profile_picture
		});

		// Create settings with defaults
		settingsRepository.set(user.user_id!, {
			offline_message_retention: '7d',
			allow_temp_user_messages: 1
		});

		// Update session to be registered
		const newSessionId = `reg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(
			JSON.stringify({
				token,
				user: {
					id: user.user_id,
					username: user.username,
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
		// Extract user ID from Authorization header (JWT token)
		const authHeader = req.headers.authorization;
		if (!authHeader || !authHeader.startsWith('Bearer ')) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Missing or invalid authorization' }));
			return;
		}

		// For now, we'll extract user ID from the session info
		// In a real app, you'd verify the JWT and extract user ID from the token payload
		// This is a simplified version - you may need to enhance JWT handling

		// Try to get user ID from request context (would be set by auth middleware in a full impl)
		const userId = (req as any).userId;
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
			allow_temp_user_messages: settings.allow_temp_user_messages === 1
		}));
	} catch (error) {
		console.error('[Auth] Get settings error:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to load settings' }));
	}
}

// Save user settings
export async function handleSaveUserSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		// Extract user ID from Authorization header
		const authHeader = req.headers.authorization;
		if (!authHeader || !authHeader.startsWith('Bearer ')) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Missing or invalid authorization' }));
			return;
		}

		const userId = (req as any).userId;
		if (!userId) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'User not authenticated' }));
			return;
		}

		// Parse request body
		const body = await parseBody(req);
		const { offline_message_retention, allow_temp_user_messages } = body;

		// Validate retention period
		const validRetentions = ['1d', '7d', '30d', 'forever'];
		if (offline_message_retention && !validRetentions.includes(offline_message_retention)) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid retention period' }));
			return;
		}

		// Save settings
		settingsRepository.set(userId, {
			offline_message_retention: offline_message_retention || '7d',
			allow_temp_user_messages: allow_temp_user_messages ? 1 : 0
		});

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ success: true }));
	} catch (error) {
		console.error('[Auth] Save settings error:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to save settings' }));
	}
}
