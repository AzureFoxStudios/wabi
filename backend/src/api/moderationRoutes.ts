import { IncomingMessage, ServerResponse } from 'http';
import { verifyToken } from '../auth/jwt.js';
import { sessionRepository } from '../db/repositories/sessionRepository.js';
import { moderationTriggerRepository } from '../db/repositories/moderationTriggerRepository.js';
import { getUserRoles } from '../auth/roleMiddleware.js';

function parseBody(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
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

function writeJson(res: ServerResponse, status: number, body: Record<string, any>) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function getAuthenticatedUserId(req: IncomingMessage): number | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  try {
    const token = authHeader.slice(7);
    const payload = verifyToken(token);
    const dbSession = sessionRepository.findById(payload.sessionId);
    if (!dbSession || (dbSession.expires_at && dbSession.expires_at < Date.now())) {
      return null;
    }
    return payload.userId;
  } catch {
    return null;
  }
}

function isModerator(userId: number): boolean {
  const roles = getUserRoles(userId);
  return roles.includes('owner') || roles.includes('admin') || roles.includes('mod');
}

export async function handleListModerationTriggers(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return writeJson(res, 401, { success: false, error: 'Unauthorized' });
  if (!isModerator(userId)) return writeJson(res, 403, { success: false, error: 'Forbidden' });

  const triggers = moderationTriggerRepository.listAll(true);
  writeJson(res, 200, { success: true, triggers });
}

export async function handleCreateModerationTrigger(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return writeJson(res, 401, { success: false, error: 'Unauthorized' });
  if (!isModerator(userId)) return writeJson(res, 403, { success: false, error: 'Forbidden' });

  try {
    const body = await parseBody(req);
    const pattern = typeof body.pattern === 'string' ? body.pattern.trim() : '';
    const action = body.action === 'ban' ? 'ban' : 'timeout';
    const duration = typeof body.duration === 'string' ? body.duration.trim() : null;
    const severity = Math.max(1, Math.min(10, parseInt(String(body.severity ?? 5), 10) || 5));
    const enabled = body.enabled === false ? 0 : 1;

    if (!pattern) return writeJson(res, 400, { success: false, error: 'pattern is required' });

    const id = moderationTriggerRepository.create({ pattern, action, duration, severity, enabled, created_by: userId });
    writeJson(res, 201, { success: true, id });
  } catch (error) {
    writeJson(res, 400, { success: false, error: error instanceof Error ? error.message : 'Invalid request' });
  }
}

export async function handleUpdateModerationTrigger(req: IncomingMessage, res: ServerResponse, triggerId: number): Promise<void> {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return writeJson(res, 401, { success: false, error: 'Unauthorized' });
  if (!isModerator(userId)) return writeJson(res, 403, { success: false, error: 'Forbidden' });

  try {
    const body = await parseBody(req);
    const updates: Record<string, any> = {};

    if (typeof body.pattern === 'string') updates.pattern = body.pattern.trim();
    if (body.action === 'timeout' || body.action === 'ban') updates.action = body.action;
    if (body.duration === null || typeof body.duration === 'string') updates.duration = body.duration;
    if (body.severity !== undefined) updates.severity = Math.max(1, Math.min(10, parseInt(String(body.severity), 10) || 5));
    if (body.enabled !== undefined) updates.enabled = body.enabled ? 1 : 0;

    const updated = moderationTriggerRepository.update(triggerId, updates);
    if (!updated) return writeJson(res, 404, { success: false, error: 'Trigger not found or no changes' });

    writeJson(res, 200, { success: true });
  } catch (error) {
    writeJson(res, 400, { success: false, error: error instanceof Error ? error.message : 'Invalid request' });
  }
}

export async function handleDeleteModerationTrigger(req: IncomingMessage, res: ServerResponse, triggerId: number): Promise<void> {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return writeJson(res, 401, { success: false, error: 'Unauthorized' });
  if (!isModerator(userId)) return writeJson(res, 403, { success: false, error: 'Forbidden' });

  const deleted = moderationTriggerRepository.delete(triggerId);
  if (!deleted) return writeJson(res, 404, { success: false, error: 'Trigger not found' });
  writeJson(res, 200, { success: true });
}
