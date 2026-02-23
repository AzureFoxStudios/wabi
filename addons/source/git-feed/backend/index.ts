import type { BackendPlugin, PluginContext } from '../../../backend/src/plugins/types';
import { createHmac, timingSafeEqual } from 'node:crypto';

interface GitFeedEvent {
	id: string;
	channelId: string;
	provider: 'github' | 'gitlab' | 'gitea' | 'unknown';
	repository: string;
	action: string;
	actor: string;
	summary: string;
	link?: string;
	createdAt: number;
}

const STORAGE_KEY = 'events';
const MAX_EVENTS = 300;

let ctxRef: PluginContext | null = null;
let events: GitFeedEvent[] = [];

function sanitizeString(input: unknown, maxLen: number): string {
	if (typeof input !== 'string') return '';
	return input.trim().slice(0, maxLen);
}

function detectProvider(headers: Record<string, any>): GitFeedEvent['provider'] {
	if (headers['x-github-event']) return 'github';
	if (headers['x-gitlab-event']) return 'gitlab';
	if (headers['x-gitea-event']) return 'gitea';
	return 'unknown';
}

function verifyGithubSignature(secret: string, body: Buffer, signatureHeader: string | undefined): boolean {
	if (!secret) return true;
	if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
	const expected = Buffer.from(signatureHeader.slice('sha256='.length), 'hex');
	const computed = createHmac('sha256', secret).update(body).digest();
	if (expected.length !== computed.length) return false;
	return timingSafeEqual(expected, computed);
}

async function persist(): Promise<void> {
	if (!ctxRef) return;
	await ctxRef.storage.set(STORAGE_KEY, events);
}

function emitChannel(ctx: PluginContext, channelId: string): void {
	const feed = events.filter((event) => event.channelId === channelId);
	ctx.emitToChannel(channelId, 'gitfeed:state', { channelId, events: feed });
}

function parseSummary(provider: GitFeedEvent['provider'], payload: any): { repository: string; action: string; actor: string; summary: string; link?: string } {
	if (provider === 'github') {
		const repository = sanitizeString(payload?.repository?.full_name, 220) || 'unknown/repo';
		const actor = sanitizeString(payload?.sender?.login, 120) || 'unknown';
		const ref = sanitizeString(payload?.ref, 200).replace('refs/heads/', '');
		const commits = Array.isArray(payload?.commits) ? payload.commits.length : 0;
		const summary = commits > 0 ? `${actor} pushed ${commits} commit(s) to ${ref || 'unknown-branch'}` : `${actor} triggered ${sanitizeString(payload?.action, 80) || 'event'}`;
		const link = sanitizeString(payload?.compare || payload?.repository?.html_url, 600);
		return { repository, action: sanitizeString(payload?.action || 'push', 80), actor, summary, link };
	}

	const repository = sanitizeString(payload?.project?.path_with_namespace || payload?.repository?.full_name, 220) || 'unknown/repo';
	const actor = sanitizeString(payload?.user_username || payload?.sender?.login, 120) || 'unknown';
	const action = sanitizeString(payload?.object_kind || payload?.event_name || 'event', 80);
	const summary = `${actor} triggered ${action}`;
	const link = sanitizeString(payload?.project?.web_url || payload?.repository?.html_url, 600);
	return { repository, action, actor, summary, link };
}

const plugin: BackendPlugin = {
	name: 'git-feed',

	async onLoad(ctx: PluginContext) {
		ctxRef = ctx;
		const stored = await ctx.storage.get(STORAGE_KEY);
		events = Array.isArray(stored) ? stored : [];
		ctx.logger.info('Git Feed loaded', { events: events.length });
	},

	routes: [
		{
			method: 'get',
			path: '/state',
			handler: async (req, res) => {
				const channelId = sanitizeString(req.query?.channelId, 128);
				if (!channelId) {
					res.status(400).json({ success: false, error: 'channelId query is required' });
					return;
				}
				res.json({ success: true, channelId, events: events.filter((event) => event.channelId === channelId) });
			}
		},
		{
			method: 'post',
			path: '/ingest',
			handler: async (req, res) => {
				const body = await req.buffer();
				let payload: any = {};
				try {
					payload = JSON.parse(body.toString('utf-8'));
				} catch {
					res.status(400).json({ success: false, error: 'Invalid JSON payload' });
					return;
				}

				const channelId = sanitizeString(req.query?.channelId || payload?.channelId, 128);
				if (!channelId) {
					res.status(400).json({ success: false, error: 'channelId query (or payload.channelId) is required' });
					return;
				}

				const secret = process.env.GIT_FEED_WEBHOOK_SECRET || '';
				const signature = sanitizeString(req.headers['x-hub-signature-256'], 300);
				if (!verifyGithubSignature(secret, body, signature || undefined)) {
					res.status(401).json({ success: false, error: 'Webhook signature verification failed' });
					return;
				}

				const provider = detectProvider(req.headers as Record<string, any>);
				const parsed = parseSummary(provider, payload);
				const event: GitFeedEvent = {
					id: `git-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
					channelId,
					provider,
					repository: parsed.repository,
					action: parsed.action,
					actor: parsed.actor,
					summary: parsed.summary,
					link: parsed.link,
					createdAt: Date.now()
				};

				events = [...events, event].slice(-MAX_EVENTS);
				await persist();
				if (ctxRef) {
					emitChannel(ctxRef, channelId);
				}

				res.json({ success: true, event });
			}
		}
	],

	socketHandlers: {
		'gitfeed:get-state': (socket: any, data: any) => {
			const channelId = sanitizeString(data?.channelId, 128);
			if (!channelId) {
				socket.emit('gitfeed:error', { message: 'channelId is required' });
				return;
			}
			socket.emit('gitfeed:state', {
				channelId,
				events: events.filter((event) => event.channelId === channelId)
			});
		}
	}
};

export default plugin;
