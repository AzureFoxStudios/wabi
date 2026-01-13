import { IncomingMessage, ServerResponse } from 'http';
import { verifyToken } from '../auth/jwt.js';
import { sessionRepository } from '../db/repositories/sessionRepository.js';

/**
 * HTTP Authentication Middleware
 * Extracts and verifies JWT tokens from Authorization header
 * Sets req.userId and req.sessionId for protected endpoints
 * Pattern follows Socket.IO auth middleware (server.ts:1085-1120)
 */
export function authMiddleware(
	req: IncomingMessage,
	res: ServerResponse,
	next: () => void
): void {
	try {
		const authHeader = req.headers.authorization;

		if (!authHeader || !authHeader.startsWith('Bearer ')) {
			// No auth token provided - caller must handle 401
			next();
			return;
		}

		const token = authHeader.slice(7); // Remove 'Bearer ' prefix

		try {
			// Verify JWT and extract payload
			const payload = verifyToken(token);

			// Check if session exists in database (for registered users)
			const dbSession = sessionRepository.findById(payload.sessionId);

			if (!dbSession || (dbSession.expires_at && dbSession.expires_at < Date.now())) {
				// Token valid but session expired in database
				(req as any).auth = { valid: false, reason: 'session_expired' };
				next();
				return;
			}

			// Auth successful - set properties on request
			(req as any).userId = payload.userId;
			(req as any).sessionId = payload.sessionId;
			(req as any).isRegistered = true;
			(req as any).auth = { valid: true };

			next();
		} catch (error) {
			// Token verification failed
			(req as any).auth = { valid: false, reason: 'invalid_token' };
			next();
		}
	} catch (error) {
		console.error('Auth middleware error:', error);
		(req as any).auth = { valid: false, reason: 'middleware_error' };
		next();
	}
}

/**
 * Helper function to require authentication on a route
 * Call this in route handlers to enforce auth requirement
 * Usage:
 *   if (!requireAuth(req, res)) return;
 */
export function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
	const auth = (req as any).auth;

	if (!auth || !auth.valid) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Missing or invalid authorization' }));
		return false;
	}

	return true;
}

/**
 * Get authenticated user ID from request
 * Returns null if not authenticated
 */
export function getUserId(req: IncomingMessage): number | null {
	return (req as any).userId || null;
}

/**
 * Get session ID from request
 * Returns null if not authenticated
 */
export function getSessionId(req: IncomingMessage): string | null {
	return (req as any).sessionId || null;
}
