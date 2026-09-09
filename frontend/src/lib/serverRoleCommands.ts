interface RoleCommandSocket {
	connected: boolean;
	on(event: string, listener: (payload: any) => void): unknown;
	off(event: string, listener: (payload: any) => void): unknown;
	emit(event: string, payload: unknown): unknown;
}

const pending = new WeakMap<RoleCommandSocket, Set<number>>();

/** Never queue administrative intent. Success means a correlated durable server receipt. */
export function requestServerRoleChange(socket: RoleCommandSocket, targetUserId: number, roleName: string, options: {
	isCurrent: () => boolean;
	onInvalidated: (cancel: () => void) => () => void;
	timeoutMs?: number;
	requestId?: string;
}): Promise<void> {
	if (!socket.connected || !options.isCurrent()) return Promise.reject(new Error('Reconnect before changing roles.'));
	if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0 || !['member', 'mod', 'admin', 'artist', 'developer'].includes(roleName)) {
		return Promise.reject(new Error('Choose a valid member role.'));
	}
	let targets = pending.get(socket);
	if (!targets) { targets = new Set(); pending.set(socket, targets); }
	if (targets.has(targetUserId)) return Promise.reject(new Error('A role change for this member is already in progress.'));
	targets.add(targetUserId);
	const requestId = options.requestId ?? crypto.randomUUID();
	return new Promise<void>((resolve, reject) => {
		let done = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let unsubscribe = () => {};
		const finish = (error?: Error) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			socket.off('assign-role-success', onSuccess);
			socket.off('assign-role-error', onError);
			socket.off('disconnect', onDisconnect);
			socket.off('auth-revoked', onDisconnect);
			unsubscribe();
			targets!.delete(targetUserId);
			error ? reject(error) : resolve();
		};
		const onDisconnect = () => finish(new Error('Connection changed before the role change was confirmed. Check the member’s role after reconnecting.'));
		const onSuccess = (payload: any) => {
			if (payload?.requestId !== requestId || payload.targetUserId !== targetUserId) return;
			if (!options.isCurrent()) { onDisconnect(); return; }
			const expected = { member: 'Member', mod: 'Moderator', admin: 'Admin', artist: 'Artist', developer: 'Developer' }[roleName];
			if (payload.role !== expected) { finish(new Error('The server returned an unexpected role. Reload the member list to verify it.')); return; }
			finish();
		};
		const onError = (payload: any) => {
			if (payload?.requestId !== requestId) return;
			finish(new Error(typeof payload.error === 'string' ? payload.error : 'The server could not change this role.'));
		};
		socket.on('assign-role-success', onSuccess);
		socket.on('assign-role-error', onError);
		socket.on('disconnect', onDisconnect);
		socket.on('auth-revoked', onDisconnect);
		unsubscribe = options.onInvalidated(onDisconnect);
		if (done) { unsubscribe(); return; }
		timer = setTimeout(() => finish(new Error('The server did not confirm the role change. Reload the member list before trying again.')), options.timeoutMs ?? 10_000);
		try { socket.emit('assign-role', { targetUserId, roleName, requestId }); }
		catch { onDisconnect(); }
	});
}
