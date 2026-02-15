import { writable, get } from 'svelte/store';
import { getAdminChannels, getAdminRoles, type AdminChannelListItem, type AdminRoleListItem } from './api';

export const adminChannels = writable<AdminChannelListItem[]>([]);
export const adminChannelsPage = writable(0);
export const adminChannelsHasMore = writable(true);

export const adminRoles = writable<AdminRoleListItem[]>([]);
export const adminRolesPage = writable(0);
export const adminRolesHasMore = writable(true);

export async function loadNextAdminChannels(token: string, limit = 50): Promise<void> {
	if (!get(adminChannelsHasMore)) return;
	const nextPage = get(adminChannelsPage) + 1;
	const res = await getAdminChannels(token, nextPage, limit);
	adminChannels.update((items) => [...items, ...res.items]);
	adminChannelsPage.set(res.page);
	adminChannelsHasMore.set(res.hasMore);
}

export async function loadNextAdminRoles(token: string, limit = 50): Promise<void> {
	if (!get(adminRolesHasMore)) return;
	const nextPage = get(adminRolesPage) + 1;
	const res = await getAdminRoles(token, nextPage, limit);
	adminRoles.update((items) => [...items, ...res.items]);
	adminRolesPage.set(res.page);
	adminRolesHasMore.set(res.hasMore);
}

export function resetAdminLazyLists() {
	adminChannels.set([]);
	adminChannelsPage.set(0);
	adminChannelsHasMore.set(true);
	adminRoles.set([]);
	adminRolesPage.set(0);
	adminRolesHasMore.set(true);
}
