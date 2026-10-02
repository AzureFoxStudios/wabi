import { test, expect } from 'bun:test';
import { buildForumAuthorLookup, canManageForumPost } from './forumIdentity';
import type { User } from './socket-types';
const member = (dbUserId:number, username:string, highestRole='member') => ({dbUserId,username,highestRole,isRegistered:true} as User);
test('offline authors remain available and self identity wins presence races', () => {
 const map=buildForumAuthorLookup([member(2,'Owner')],[member(3,'Online')],member(2,'Updated owner'));
 expect(map.get(2)?.username).toBe('Updated owner'); expect(map.get(3)?.username).toBe('Online'); expect(map.has(99)).toBe(false);
});
test('post actions follow ownership and staff roles', () => {
 expect(canManageForumPost(member(2,'Author'),2)).toBe(true);
 expect(canManageForumPost(member(3,'Other'),2)).toBe(false);
 expect(canManageForumPost(member(3,'Staff','moderator'),2)).toBe(true);
 expect(canManageForumPost(null,2)).toBe(false);
 expect(canManageForumPost({...member(2,'Guest','owner'),isRegistered:false},2)).toBe(false);
});
