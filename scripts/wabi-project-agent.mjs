#!/usr/bin/env node
// Narrow Wabi Project bridge for an external agent runtime. It never prints the bot token.
import { randomUUID } from 'node:crypto';

const origin = process.env.WABI_PROJECT_URL?.replace(/\/+$/, '');
const channelId = process.env.WABI_PROJECT_CHANNEL_ID;
const token = process.env.WABI_BOT_TOKEN;
const [command, ...args] = process.argv.slice(2);

function fail(message) { throw new Error(message); }
if (!origin || !channelId || !token) fail('Set WABI_PROJECT_URL, WABI_PROJECT_CHANNEL_ID and WABI_BOT_TOKEN.');
let server;
try { server = new URL(origin); } catch { fail('WABI_PROJECT_URL must be a URL.'); }
if (server.username || server.password || server.search || server.hash || server.pathname !== '/') fail('WABI_PROJECT_URL must be a bare origin.');
if (server.protocol !== 'https:' && !(server.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(server.hostname))) {
  fail('Use HTTPS, or loopback HTTP for a disposable local test.');
}
if (!/^[a-zA-Z0-9_-]{1,128}$/.test(channelId)) fail('Invalid project channel ID.');
const base = `${origin}/api`;

async function request(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) fail(`Wabi ${response.status}: ${data?.error ?? 'request failed'}`);
  return data;
}
const project = encodeURIComponent(channelId);
let result;
switch (command) {
  case 'list-cards':
    result = await request('GET', `/projects/${project}/tasks`);
    break;
  case 'list-pages':
    result = await request('GET', `/wiki/${project}/pages`);
    break;
  case 'create-card': {
    const [title, description = '', operationId = randomUUID()] = args;
    if (!title) fail('Usage: create-card TITLE [DESCRIPTION] [OPERATION_UUID]');
    result = await request('POST', `/projects/${project}/tasks`, {
      operationId, title, description, status: 'todo', priority: 'medium',
    });
    break;
  }
  case 'set-card-status': {
    const [taskId, status] = args;
    if (!taskId || !status) fail('Usage: set-card-status TASK_ID STATUS');
    const current = await request('GET', `/projects/${project}/tasks/${encodeURIComponent(taskId)}`);
    result = await request('PUT', `/projects/${project}/tasks/${encodeURIComponent(taskId)}`, {
      expectedRevision: current.revision, title: current.title, description: current.description,
      status, priority: current.priority, dueDateMillis: current.dueDateMillis,
      assigneeUserId: current.assigneeUserId,
    });
    break;
  }
  case 'claim-card': {
    const [taskId] = args;
    if (!taskId) fail('Usage: claim-card TASK_ID');
    const current = await request('GET', `/projects/${project}/tasks/${encodeURIComponent(taskId)}`);
    result = await request('POST', `/projects/${project}/tasks/${encodeURIComponent(taskId)}/claim`, { expectedRevision: current.revision });
    break;
  }
  case 'assign-card': {
    const [taskId, userId] = args;
    const assigneeUserId = userId === 'none' ? null : Number(userId);
    if (!taskId || (assigneeUserId !== null && (!Number.isSafeInteger(assigneeUserId) || assigneeUserId <= 0))) fail('Usage: assign-card TASK_ID USER_ID|none');
    const current = await request('GET', `/projects/${project}/tasks/${encodeURIComponent(taskId)}`);
    result = await request('PUT', `/projects/${project}/tasks/${encodeURIComponent(taskId)}`, {
      expectedRevision: current.revision, title: current.title, description: current.description,
      status: current.status, priority: current.priority, dueDateMillis: current.dueDateMillis, assigneeUserId,
    });
    break;
  }
  case 'create-page': {
    const [title, body = ''] = args;
    if (!title) fail('Usage: create-page TITLE [BODY]');
    result = await request('POST', `/wiki/${project}/pages`, { title, body });
    break;
  }
  case 'ping': {
    const [content] = args;
    if (!content) fail('Usage: ping MESSAGE');
    result = await request('POST', '/bot/send-message', { channel_id: channelId, content });
    break;
  }
  default:
    fail('Commands: list-cards, list-pages, create-card, set-card-status, claim-card, assign-card, create-page, ping');
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
