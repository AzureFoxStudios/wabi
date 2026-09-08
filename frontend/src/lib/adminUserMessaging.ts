import type { Channel, User } from './socket-types';
import type { CreateDMResult } from './socket';
import { findExistingDmChannel, getDmStableUserId } from './dmConversations';
import { getDmDirectoryKey } from './dmUserDirectory';

interface AdminMessagingContext {
	server: string;
	generation: number;
	self: User | null;
	online: boolean;
	active: boolean;
	channels: Channel[];
}

/** One People action owns one target; a late create result cannot reopen a retired admin view. */
export function createAdminUserMessaging(dependencies: {
	context: () => AdminMessagingContext;
	create: (userId: string) => Promise<CreateDMResult>;
	open: (channelId: string, user: User) => void;
	join: (channelId: string) => void;
	openNotes: () => void;
	leaveAdmin: () => void;
	changed: (state: { pendingUserId: string | null; error: string }) => void;
}) {
	let pending = false;
	let disposed = false;
	return {
		async open(user: User): Promise<boolean> {
			if (pending || disposed) return false;
			const origin = dependencies.context();
			const selfId = getDmStableUserId(origin.self);
			if (!origin.active || !selfId) return false;
			const current = () => {
				const next = dependencies.context();
				return !disposed && next.active && next.server === origin.server && next.generation === origin.generation && getDmStableUserId(next.self) === selfId;
			};
			if (getDmStableUserId(user) === selfId) {
				dependencies.openNotes();
				dependencies.leaveAdmin();
				return true;
			}
			dependencies.changed({ pendingUserId: null, error: '' });
			let channelId = findExistingDmChannel(origin.channels, user)?.id;
			if (!channelId) {
				if (!origin.online) {
					dependencies.changed({ pendingUserId: null, error: 'Reconnect before starting a new conversation.' });
					return false;
				}
				pending = true;
				dependencies.changed({ pendingUserId: getDmDirectoryKey(user), error: '' });
				try {
					const result = await dependencies.create(getDmDirectoryKey(user));
					if (!current()) return false;
					// Reuse a matching channel that arrived while creation was pending.
					// An uncorrelated error's channelId is not authority to open another person's DM.
					channelId = findExistingDmChannel(dependencies.context().channels, user)?.id || (result.ok ? result.channelId : undefined);
					if (!channelId) {
						dependencies.changed({ pendingUserId: null, error: result.ok === false ? result.error : 'The server did not return a conversation. Try again.' });
						return false;
					}
				} catch {
					if (current()) dependencies.changed({ pendingUserId: null, error: 'Could not start this conversation. Check your connection and try again.' });
					return false;
				} finally { pending = false; }
			}
			if (!current()) return false;
			dependencies.changed({ pendingUserId: null, error: '' });
			dependencies.open(channelId, user);
			dependencies.join(channelId);
			dependencies.leaveAdmin();
			return true;
		},
		dispose() { disposed = true; }
	};
}
