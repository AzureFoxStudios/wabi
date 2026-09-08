export interface AdminBadgeSocket {
	id?: string;
	connected: boolean;
	on(event: string, listener: (payload: any) => void): unknown;
	off(event: string, listener: (payload: any) => void): unknown;
	emit(event: string, payload: unknown): unknown;
}

interface BadgeContext {
	server: string;
	actorId: number | null;
	generation: number;
	online: boolean;
	active: boolean;
	socket: AdminBadgeSocket | null;
}

export interface PendingAdminBadge {
	targetUserId: number;
	username: string;
	badgeId: string;
	operation: 'assign' | 'remove';
}

export interface AdminBadgeMutationState {
	pending: PendingAdminBadge | null;
	error: string;
	status: string;
}

const pendingSockets = new WeakSet<AdminBadgeSocket>();
const unknownOutcome = 'The badge change could not be confirmed. Check this member’s badges before trying again.';
const disconnectedOutcome = 'Connection changed before the badge change was confirmed. Check this member’s badges after reconnecting before trying again.';

/** Own a bounded badge command, without optimistically editing the member roster. */
export function createAdminBadgeMutation(deps: {
	context: () => BadgeContext;
	canManageTarget: (userId: number) => boolean;
	changed: (state: AdminBadgeMutationState) => void;
	requestId?: () => string;
	scheduleTimeout?: (callback: () => void) => () => void;
}) {
	type Attempt = PendingAdminBadge & { origin: BadgeContext; socket: AdminBadgeSocket; socketId: string | undefined; cleanup: () => void };
	let pending: Attempt | null = null;
	let disposed = false;
	const publish = (state: AdminBadgeMutationState) => { if (!disposed) deps.changed(state); };
	function finish(attempt: Attempt, error = '', status = '') {
		if (pending !== attempt) return;
		pending = null;
		attempt.cleanup();
		pendingSockets.delete(attempt.socket);
		publish({ pending: null, error, status });
	}
	function isCurrent(attempt: Attempt): boolean {
		if (disposed || pending !== attempt) return false;
		const context = deps.context();
		if (context.server !== attempt.origin.server || context.actorId !== attempt.origin.actorId || context.generation !== attempt.origin.generation) {
			// A new account/session must not inherit names, errors or success from the old one.
			finish(attempt);
			return false;
		}
		if (context.socket !== attempt.socket || context.socket?.id !== attempt.socketId || !context.online || !attempt.socket.connected) {
			finish(attempt, disconnectedOutcome);
			return false;
		}
		if (!context.active || !deps.canManageTarget(attempt.targetUserId)) {
			finish(attempt, unknownOutcome);
			return false;
		}
		return true;
	}
	return {
		change(operation: PendingAdminBadge['operation'], user: { dbUserId: number; username: string }, badgeId: string): boolean {
			if (disposed || pending) return false;
			const origin = deps.context();
			const socket = origin.socket;
			if (!origin.active || !origin.actorId || !deps.canManageTarget(user.dbUserId) || !Number.isSafeInteger(user.dbUserId) || user.dbUserId <= 0 || !badgeId.trim()) {
				publish({ pending: null, error: 'This account is no longer available for badge changes.', status: '' });
				return false;
			}
			if (!origin.online || !socket?.connected) {
				publish({ pending: null, error: 'Reconnect before changing badges.', status: '' });
				return false;
			}
			if (pendingSockets.has(socket)) {
				publish({ pending: null, error: 'Another badge change is in progress. Wait for it to finish.', status: '' });
				return false;
			}
			const requestId = deps.requestId?.() ?? crypto.randomUUID();
			const command: PendingAdminBadge = { operation, targetUserId: user.dbUserId, username: user.username, badgeId };
			const attempt: Attempt = { ...command, origin, socket, socketId: socket.id, cleanup: () => {} };
			pending = attempt;
			pendingSockets.add(socket);
			let cancelTimeout = () => {};
			const onUpdate = (payload: any) => {
				if (!isCurrent(attempt)) return;
				if (payload?.dbUserId !== user.dbUserId || !Array.isArray(payload.badges) ||
					!payload.badges.every((badge: any) => badge && typeof badge.id === 'string' && badge.id.trim())) return;
				const present = payload.badges.some((badge: { id: string }) => badge.id === badgeId);
				if (present !== (operation === 'assign')) return;
				// A public update confirms the desired state, not who caused it.
				finish(attempt, '', `Badge list updated for ${user.username}.`);
			};
			const onError = (payload: any) => {
				if (!isCurrent(attempt)) return;
				if (payload?.requestId !== requestId || payload.targetUserId !== user.dbUserId || payload.badgeId !== badgeId) return;
				const error = payload.error === 'Not authorized' || payload.error === 'Authentication required'
					? 'The server did not allow this badge change. Check your admin session and this member’s badges.'
					: payload.error === 'Unknown badge' || payload.error === 'Invalid badge request'
						? 'This badge is not available. Reload the member list before trying again.' : unknownOutcome;
				finish(attempt, error);
			};
			const onDisconnect = () => { if (isCurrent(attempt)) finish(attempt, disconnectedOutcome); };
			const errorEvent = `${operation}-badge-error`;
			attempt.cleanup = () => {
				cancelTimeout();
				socket.off('user-badges-updated', onUpdate);
				socket.off(errorEvent, onError);
				socket.off('disconnect', onDisconnect);
				socket.off('auth-revoked', onDisconnect);
			};
			socket.on('user-badges-updated', onUpdate);
			socket.on(errorEvent, onError);
			socket.on('disconnect', onDisconnect);
			socket.on('auth-revoked', onDisconnect);
			publish({ pending: command, error: '', status: '' });
			const schedule = deps.scheduleTimeout ?? ((callback) => { const timer = setTimeout(callback, 10_000); return () => clearTimeout(timer); });
			cancelTimeout = schedule(() => { if (isCurrent(attempt)) finish(attempt, unknownOutcome); });
			if (!isCurrent(attempt)) { cancelTimeout(); return false; }
			try { socket.emit(`${operation}-badge`, { targetUserId: user.dbUserId, badgeId, requestId }); }
			catch { finish(attempt, unknownOutcome); }
			return true;
		},
		reconcile() { if (pending) isCurrent(pending); },
		dispose() {
			disposed = true;
			if (pending) finish(pending);
		}
	};
}
