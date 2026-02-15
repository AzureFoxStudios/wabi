import { IncomingMessage, ServerResponse } from 'http';
import { verifyToken } from '../auth/jwt.js';
import { verifyPassword } from '../auth/passwordHash.js';
import { getUserRoles } from '../auth/roleMiddleware.js';
import { banAppealRepository } from '../db/repositories/banAppealRepository.js';
import { sessionRepository } from '../db/repositories/sessionRepository.js';
import { userRepository } from '../db/repositories/userRepository.js';

function parseBody(req: IncomingMessage): Promise<Record<string, any>> {
	return new Promise((resolve, reject) => {
		let body = '';
		req.on('data', (chunk: any) => {
			body += chunk.toString();
		});
		req.on('end', () => {
			try {
				resolve(body ? JSON.parse(body) : {});
			} catch {
				reject(new Error('Invalid JSON'));
			}
		});
		req.on('error', reject);
	});
}

function getAuthedUserId(req: IncomingMessage): number | null {
	const authHeader = req.headers.authorization;
	if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

	try {
		const payload = verifyToken(authHeader.slice(7));
		const dbSession = sessionRepository.findById(payload.sessionId);
		if (!dbSession || (dbSession.expires_at && dbSession.expires_at < Date.now())) return null;
		return payload.userId;
	} catch {
		return null;
	}
}

function getAppealCooldownInfo(userId: number): { canAppeal: boolean; nextAppealAt: number | null } {
	const latestAppeal = banAppealRepository.getLatestForUser(userId);
	if (!latestAppeal) return { canAppeal: true, nextAppealAt: null };
	if (latestAppeal.status === 'pending') return { canAppeal: false, nextAppealAt: null };

	if (latestAppeal.status === 'denied') {
		const note = latestAppeal.decision_note || '';
		const match = note.match(/cooldown:(\d+)/i);
		if (match && latestAppeal.reviewed_at) {
			const cooldownMs = parseInt(match[1], 10) * 1000;
			const nextAppealAt = latestAppeal.reviewed_at + cooldownMs;
			if (nextAppealAt > Date.now()) {
				return { canAppeal: false, nextAppealAt };
			}
		}
	}

	return { canAppeal: true, nextAppealAt: null };
}

export async function handleSubmitBanAppeal(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const body = await parseBody(req);
		const username = String(body.username || '').trim();
		const password = String(body.password || '');
		const message = String(body.message || '').trim();

		if (!username || !password || message.length < 10) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Username, password, and a message (10+ chars) are required' }));
			return;
		}

		const user = userRepository.findByHandleOrUsername(username);
		if (!user) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid credentials' }));
			return;
		}

		const ok = await verifyPassword(password, user.password_hash);
		if (!ok) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid credentials' }));
			return;
		}

		if (user.is_active !== 0) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Your account is not currently restricted' }));
			return;
		}

		const cooldown = getAppealCooldownInfo(user.user_id!);
		if (!cooldown.canAppeal) {
			res.writeHead(429, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				error: 'Appeal cooldown active. Please wait before submitting another appeal.',
				nextAppealAt: cooldown.nextAppealAt
			}));
			return;
		}

		banAppealRepository.clearPendingForUser(user.user_id!);
		const appeal = banAppealRepository.create({ user_id: user.user_id!, message });

		res.writeHead(201, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ success: true, appeal }));
	} catch (error) {
		console.error('[BanAppeal] Submit error:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to submit appeal' }));
	}
}

export async function handleGetBanAppeals(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const userId = getAuthedUserId(req);
		if (!userId) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Authentication required' }));
			return;
		}

		const roles = getUserRoles(userId);
		if (!roles.some(role => ['owner', 'admin', 'mod'].includes(role))) {
			res.writeHead(403, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Moderator access required' }));
			return;
		}

		const pending = banAppealRepository.getPending().map((appeal) => ({
			...appeal,
			user: userRepository.findById(appeal.user_id)
				? {
					user_id: appeal.user_id,
					username: userRepository.findById(appeal.user_id)!.username,
					handle: userRepository.findById(appeal.user_id)!.handle
				}
				: null
		}));

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ appeals: pending }));
	} catch (error) {
		console.error('[BanAppeal] List error:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to fetch appeals' }));
	}
}

export async function handleReviewBanAppeal(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const reviewerId = getAuthedUserId(req);
		if (!reviewerId) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Authentication required' }));
			return;
		}

		const roles = getUserRoles(reviewerId);
		if (!roles.some(role => ['owner', 'admin', 'mod'].includes(role))) {
			res.writeHead(403, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Moderator access required' }));
			return;
		}

		const body = await parseBody(req);
		const appealId = Number(body.appealId);
		const decision = body.decision === 'approved' ? 'approved' : body.decision === 'denied' ? 'denied' : null;
		const decisionNote = String(body.decisionNote || '').trim();
		const cooldownSeconds = Number(body.cooldownSeconds || 0);

		if (!appealId || !decision) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'appealId and valid decision are required' }));
			return;
		}

		const appeal = banAppealRepository.findById(appealId);
		if (!appeal || appeal.status !== 'pending') {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Pending appeal not found' }));
			return;
		}

		let finalDecisionNote = decisionNote;
		if (decision === 'denied' && cooldownSeconds > 0) {
			finalDecisionNote = `${decisionNote}${decisionNote ? ' ' : ''}[cooldown:${cooldownSeconds}]`;
		}

		banAppealRepository.updateDecision(appealId, {
			status: decision,
			reviewed_by: reviewerId,
			decision_note: finalDecisionNote
		});

		if (decision === 'approved') {
			userRepository.update(appeal.user_id, { is_active: 1 });
		} else {
			userRepository.update(appeal.user_id, { is_active: 0 });
		}

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ success: true }));
	} catch (error) {
		console.error('[BanAppeal] Review error:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to review appeal' }));
	}
}

export { getAppealCooldownInfo };
