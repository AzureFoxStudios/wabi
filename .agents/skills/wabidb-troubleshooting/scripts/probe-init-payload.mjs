// Probe a LIVE Wabi server's socket init payload as a guest.
// Dumps exactly what a fresh client (e.g. a user who "can't see others' avatars"
// or "isn't in the registry") receives: online `users` and the `serverMembers`
// offline roster, with profilePicture/isRegistered fields.
//
// Usage:
//   node probe-init-payload.mjs                  # defaults to https://wabi.chat
//   WABI_BASE=http://100.96.11.45:3001 node probe-init-payload.mjs
//
// Run from a dir where socket.io-client resolves (e.g. wabi/frontend).
// Contract: the frontend joins with `sock.emit('join', username)` (plain string).
import { io } from 'socket.io-client';

const BASE = process.env.WABI_BASE || 'https://wabi.chat';

const sock = io(BASE, {
	transports: ['websocket'],
	forceNew: true,
	timeout: 10000,
	reconnection: false
});

const finish = (code) => {
	try { sock.close(); } catch {}
	process.exit(code);
};

sock.on('connect', () => {
	console.log('connected:', sock.id);
	sock.emit('join', 'pfb-probe-guest');
});

sock.on('init', (payload) => {
	console.log('\n=== init payload ===');
	console.log('channels:', (payload?.channels || []).length);
	const users = payload?.users || [];
	console.log('users (online):', users.length);
	for (const u of users) {
		console.log(`  ${u.username} | dbUserId=${u.dbUserId} | pfp=${u.profilePicture || '(none)'} | isRegistered=${u.isRegistered ?? '?'} | id=${u.id}`);
	}
	const members = payload?.serverMembers || [];
	console.log('serverMembers (offline roster):', members.length);
	for (const u of members) {
		console.log(`  ${u.username} | dbUserId=${u.dbUserId} | pfp=${u.profilePicture || '(none)'} | isRegistered=${u.isRegistered ?? '?'}`);
	}
	console.log('\n=== done ===');
	finish(0);
});

sock.on('connect_error', (e) => {
	console.log('connect_error:', e.message);
	finish(1);
});

setTimeout(() => {
	console.log('TIMEOUT waiting for init');
	finish(1);
}, 15000);
