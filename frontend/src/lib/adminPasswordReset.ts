export interface PasswordResetContext {
	server: string;
	actorId: number | null;
	generation: number;
	token: string | null;
	allowed: boolean;
}

export interface PasswordResetState {
	pending: boolean;
	error: string;
	complete: boolean;
}

export function validateAdminPassword(password: string, confirmation: string): string | null {
	if (password.length < 8) return 'Use a password with at least 8 characters.';
	// The server hashes with bcrypt; longer UTF-8 passwords cannot be accepted.
	if (new TextEncoder().encode(password).length > 72) return 'Use a password no longer than 72 UTF-8 bytes.';
	if (password !== confirmation) return 'The passwords do not match.';
	return null;
}

/** Own one explicit reset request. Never retain passwords or settle into another account/server. */
export function createAdminPasswordReset(
	targetUserId: number,
	dependencies: {
		context: () => PasswordResetContext;
		reset: (token: string, targetUserId: number, password: string, temporary: false) => Promise<void>;
		changed: (state: PasswordResetState) => void;
	}
) {
	let pending = false;
	let disposed = false;
	let complete = false;
	const origin = dependencies.context();
	const current = () => {
		const next = dependencies.context();
		return !disposed && next.allowed && Boolean(next.token) && next.server === origin.server && next.actorId === origin.actorId && next.generation === origin.generation;
	};
	const publish = (state: PasswordResetState) => { if (!disposed) dependencies.changed(state); };
	return {
		async submit(password: string, confirmation: string): Promise<boolean> {
			if (pending || disposed || complete) return false;
			const context = dependencies.context();
			if (!current() || !context.token || !Number.isSafeInteger(targetUserId) || targetUserId <= 0 || targetUserId === context.actorId) {
				publish({ pending: false, complete: false, error: 'Your admin session or this account changed. Close this dialog and try again.' });
				return false;
			}
			const error = validateAdminPassword(password, confirmation);
			if (error) { publish({ pending: false, complete: false, error }); return false; }
			pending = true;
			publish({ pending: true, complete: false, error: '' });
			try {
				// Temporary passwords are not supported by the server. Do not promise forced rotation.
				await dependencies.reset(context.token, targetUserId, password, false);
				if (!current()) return false;
				complete = true;
				publish({ pending: false, complete: true, error: '' });
				return true;
			} catch {
				if (current()) publish({ pending: false, complete: false, error: 'The password reset could not be confirmed. Check the connection before trying again.' });
				return false;
			} finally { pending = false; }
		},
		dispose() { disposed = true; }
	};
}
