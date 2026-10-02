/** Server-sent events: tell connected browsers which subjects changed. */
import type { ServerResponse } from 'node:http';
import type { JournalEvent } from '@sabi/core';

const clients = new Set<ServerResponse>();

export function addClient(res: ServerResponse, head: number): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ head })}\n\n`);
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

export function broadcast(events: JournalEvent[]): void {
  if (!clients.size || !events.length) return;
  const payload = {
    head: events[events.length - 1].seq,
    events: events.filter((e) => e.type !== 'ledger.posted').map((e) => ({ seq: e.seq, type: e.type, subjectType: e.subjectType, subjectId: e.subjectId, actorId: e.actorId })),
  };
  const msg = `event: change\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of clients) c.write(msg);
}

setInterval(() => {
  for (const c of clients) c.write(': ping\n\n');
}, 25_000).unref();
