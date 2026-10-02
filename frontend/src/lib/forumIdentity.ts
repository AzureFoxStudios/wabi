import { derived } from 'svelte/store';
import { currentUser, serverMembers, users } from './presenceIdentity';
import type { User } from './socket-types';

export function buildForumAuthorLookup(members: User[], online: User[], self: User | null): Map<number, User> {
 const lookup = new Map<number, User>();
 for (const user of [...members, ...online, ...(self ? [self] : [])]) {
  if (typeof user.dbUserId === 'number' && user.dbUserId > 0) lookup.set(user.dbUserId, user);
 }
 return lookup;
}
export const forumAuthors = derived([serverMembers, users, currentUser], ([members, online, self]) => buildForumAuthorLookup(members, online, self));
export function canManageForumPost(user: User | null, authorId: number): boolean {
 return !!user?.dbUserId && user.isRegistered !== false && (user.dbUserId === authorId || ['owner', 'admin', 'mod', 'moderator'].includes((user.highestRole || '').toLowerCase()));
}
