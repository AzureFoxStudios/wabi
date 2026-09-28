#!/usr/bin/env node
// Isolated-server Socket.IO connection ramp. Keeps successful clients online briefly.
import { io } from 'socket.io-client';
import { performance } from 'node:perf_hooks';
const base = process.env.WABI_LOAD_URL;
const prefix = process.env.WABI_LOAD_USER_PREFIX;
const sharedUser = process.env.WABI_LOAD_USER;
const password = process.env.WABI_LOAD_PASSWORD;
let sharedToken = process.env.WABI_LOAD_ACCESS_TOKEN;
const transports = (process.env.WABI_LOAD_TRANSPORTS || 'websocket').split(',').map(value => value.trim()).filter(Boolean);
const count = Number(process.argv[2] || 10);
const rampMs = Number(process.env.WABI_LOAD_RAMP_MS || 500);
const holdMs = Number(process.env.WABI_LOAD_HOLD_MS || 30000);
if (!base || (!prefix && !sharedUser) || (!password && !sharedToken) || (sharedToken && !sharedUser) || !transports.length || !Number.isInteger(count) || count < 1 || count > 1000) throw new Error('Set WABI_LOAD_URL and either WABI_LOAD_USER_PREFIX + WABI_LOAD_PASSWORD or WABI_LOAD_USER + WABI_LOAD_PASSWORD/WABI_LOAD_ACCESS_TOKEN; pass 1..1000 clients.');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sockets = [];
const results = [];
const errors = [];
async function connectUser(i) {
  const username = sharedUser || `${prefix}${String(i).padStart(5, '0')}`;
  const accessToken = sharedToken || await loginUser(username);
  const started = performance.now();
  const result = await new Promise((resolve, reject) => {
    const socket = io(base, { transports, reconnection: false, forceNew: true, timeout: 20000, auth: { token: accessToken } });
    sockets.push(socket);
    const timer = setTimeout(() => reject(new Error(`Init ${username}: timeout`)), 30000);
    socket.once('connect', () => socket.emit('join', username));
    socket.once('connect_error', error => { clearTimeout(timer); reject(error); });
    socket.once('init', payload => { clearTimeout(timer); resolve({ user: i, initMs: Math.round(performance.now() - started), members: payload.serverMembers?.length || 0, bytes: Buffer.byteLength(JSON.stringify(payload)) }); });
  });
  results.push(result);
}
async function loginUser(username) {
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  if (!login.ok) throw new Error(`Login ${username}: HTTP ${login.status}`);
  const { accessToken } = await login.json();
  return accessToken;
}
try {
  if (sharedUser && !sharedToken) sharedToken = await loginUser(sharedUser);
  const pending = [];
  for (let i = 1; i <= count; i++) {
    pending.push(connectUser(i).catch(error => { errors.push(String(error)); }));
    await sleep(rampMs);
  }
  await Promise.all(pending);
  if (errors.length) throw new Error(`${errors.length} client(s) failed: ${errors.slice(0, 3).join('; ')}`);
  const sorted = results.map(r => r.initMs).sort((a, b) => a - b);
  console.log(JSON.stringify({ clients: results.length, members: results[0]?.members, initBytes: results[0]?.bytes, initMsP50: sorted[Math.floor(sorted.length * .5)], initMsP95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * .95) - 1)], initMsMax: sorted.at(-1) }));
  await sleep(holdMs);
} finally { for (const socket of sockets) socket.close(); }
