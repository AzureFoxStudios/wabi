#!/usr/bin/env node
// Measure the real Socket.IO init roster on an isolated Wabi server.
import { io } from 'socket.io-client';
import { performance } from 'node:perf_hooks';
const base = process.env.WABI_LOAD_URL || 'http://127.0.0.1:38001';
const username = process.env.WABI_LOAD_USER;
const password = process.env.WABI_LOAD_PASSWORD;
const runs = Number(process.argv[2] || 3);
if (!username || !password || !Number.isInteger(runs) || runs < 1) throw new Error('Set WABI_LOAD_USER and WABI_LOAD_PASSWORD; pass a positive run count.');
const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
if (!login.ok) throw new Error(`Login HTTP ${login.status}`);
const { accessToken } = await login.json();
for (let index = 0; index < runs; index++) {
  const started = performance.now();
  const result = await new Promise((resolve, reject) => {
    const socket = io(base, { transports: ['websocket'], reconnection: false, forceNew: true, timeout: 20000, auth: { token: accessToken } });
    const timer = setTimeout(() => { socket.close(); reject(new Error('init timeout')); }, 30000);
    socket.on('connect', () => socket.emit('join', username));
    socket.on('connect_error', error => { clearTimeout(timer); socket.close(); reject(error); });
    socket.on('init', payload => {
      clearTimeout(timer);
      const out = { run: index + 1, members: payload.serverMembers?.length || 0, online: payload.users?.length || 0, initBytes: Buffer.byteLength(JSON.stringify(payload)), initMs: Math.round(performance.now() - started) };
      socket.close(); resolve(out);
    });
  });
  console.log(JSON.stringify(result));
}
