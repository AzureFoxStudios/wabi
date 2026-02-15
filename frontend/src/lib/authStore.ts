import { writable } from 'svelte/store';

/**
 * Auth error store - centralized handling of authentication failures
 * Shows errors when session expires, tokens are invalid, or auth fails
 */

export interface AuthError {
	message: string;
	type: 'session_expired' | 'invalid_token' | 'auth_failed' | 'connection_lost' | 'appeal_required';
	timestamp: number;
}

interface AuthState {
	error: AuthError | null;
	isAuthError: boolean;
	appealRequired: boolean;
}

const initialState: AuthState = {
	error: null,
	isAuthError: false,
	appealRequired: false
};

function createAuthStore() {
	const { subscribe, set, update } = writable<AuthState>(initialState);

	return {
		subscribe,

		/**
		 * Emit an authentication error
		 */
		setAuthError(message: string, type: AuthError['type'] = 'auth_failed') {
			set({
				error: {
					message,
					type,
					timestamp: Date.now()
				},
				isAuthError: true,
				appealRequired: false
			});
		},


		setAppealRequired() {
			set({
				error: {
					message: 'Account access restricted pending appeal.',
					type: 'appeal_required',
					timestamp: Date.now()
				},
				isAuthError: true,
				appealRequired: true
			});
		},

		clearAppealRequired() {
			update(state => ({ ...state, appealRequired: false }));
		},
		/**
		 * Clear the auth error
		 */
		clearAuthError() {
			set(initialState);
		},

		/**
		 * Check if error is session-related
		 */
		isSessionError(): boolean {
			let isSession = false;
			subscribe(state => {
				isSession = state.error?.type === 'session_expired' || state.error?.type === 'invalid_token';
			})();
			return isSession;
		}
	};
}

export const authStore = createAuthStore();
