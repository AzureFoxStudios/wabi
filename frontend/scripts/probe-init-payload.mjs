// Probe a live wabi-server socket init payload as a guest.
// Dumps exactly what a fresh client receives for the roster:
//   - users (online-only presence map)
//   - serverMembers (full registered-user directory incl. guests)
// Also prints profilePicture + isRegistered per user so avatar/guest bugs
// can be diagnosed from the wire.
//
// Usage:
//   node scripts/probe-init-payload.mjs [https://wabi.chat]
//   WABI_BASE=http://100.96.11.45:3001 node scripts/probe-init-payload.mjs
import { io } from 'socket.io-client';

const BASE = process.env.WABI_BASE || process.argv[2] || 'https://wabi.chat';

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
	sock.emit('join', 'init-probe-guest');
});

sock.on('init', (payload) => {
	console.log('\n=== init payload from', BASE, '===');
	console.log('channels:', (payload?.channels || []).length);
	const users = payload?.users || [];
	console.log('users (online):', users.length);
	for (const u of users) {
		console.log(
			`  ${u.username} | dbUserId=${u.dbUserId} | pfp=${u.profilePicture || '(none)'} | isRegistered=${u.isRegistered} | id=${u.id}`
		);
	}
	const members = payload?.serverMembers || [];
	console.log('serverMembers (offline roster):', members.length);
	for (const u of members) {
		console.log(
			`  ${u.username} | dbUserId=${u.dbUserId} | pfp=${u.profilePicture || '(none)'} | isRegistered=${u.isRegistered}`
		);
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
