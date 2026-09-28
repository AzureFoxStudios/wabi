import { expect, mock, test } from 'bun:test';
import { get, writable } from 'svelte/store';
const personal = writable(true);
let activePersonal = true;
personal.subscribe(value => { activePersonal = value; });
mock.module('$app/environment', () => ({ browser: true }));
mock.module('./personalWorkspace', () => ({ personalWorkspace: personal, isPersonalWorkspace: () => activePersonal }));
mock.module('$lib/serverUrl', () => ({ getServerUrl: () => 'https://disposable.invalid' }));
mock.module('$lib/authSession', () => ({ getAuthToken: () => null }));
mock.module('$lib/localMockApi', () => ({ isLocalMockApiMode: () => false, getLocalMockUsers: () => [] }));
const { ensurePlannerDirectory, plannerDirectoryUsers } = await import('./plannerUsers');

test('personal mode makes no directory request and rejects a community reply arriving after a switch', async () => {
    const original = globalThis.fetch;
    const pending: Array<(response: Response) => void> = [];
    globalThis.fetch = Object.assign(mock(() => new Promise<Response>(resolve => { pending.push(resolve); })), { preconnect: original.preconnect });
    const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0));
    try {
        ensurePlannerDirectory(); expect(pending).toHaveLength(0); expect(get(plannerDirectoryUsers)).toEqual([]);
        personal.set(false); ensurePlannerDirectory(); expect(pending).toHaveLength(1);
        personal.set(true);
        pending[0](new Response(JSON.stringify([{ user_id: 1, username: 'Old community member' }])));
        await turn(); expect(get(plannerDirectoryUsers)).toEqual([]);
        ensurePlannerDirectory(); expect(pending).toHaveLength(1);
        personal.set(false); ensurePlannerDirectory(); expect(pending).toHaveLength(2);
        pending[1](new Response(JSON.stringify([{ user_id: 2, username: 'Current community member' }])));
        await turn(); expect(get(plannerDirectoryUsers)[0].username).toBe('Current community member');
    } finally { globalThis.fetch = original; personal.set(true); }
});
