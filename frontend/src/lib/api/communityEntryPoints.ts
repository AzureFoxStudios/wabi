import { authSessionGeneration, getAuthToken } from '$lib/authSession';
import { verifyCommunityRoster, type CommunityEntry, type SignedCommunityRoster } from '$lib/communityRoster';
import { normalizeServerUrl } from '$lib/serverUrl';

function authenticatedSource(serverUrl: string): { server: string; token: string; generation: number } {
	const server = normalizeServerUrl(serverUrl);
	const token = server ? getAuthToken(server) : null;
	if (!server || !token) throw new Error('Sign in before managing community entry points');
	return { server, token, generation: authSessionGeneration(server) };
}

function sameSession(source: { server: string; token: string; generation: number }): boolean {
	return getAuthToken(source.server) === source.token &&
		authSessionGeneration(source.server) === source.generation;
}

async function errorMessage(response: Response): Promise<string> {
	try {
		const body = await response.json() as { error?: unknown; message?: unknown };
		if (typeof body.error === 'string') return body.error;
		if (typeof body.message === 'string') return body.message;
	} catch {
		// Use the status when the server did not send JSON.
	}
	return `Request failed (${response.status})`;
}

export async function readCommunityEntryPoints(serverUrl: string): Promise<SignedCommunityRoster | null> {
	const source = authenticatedSource(serverUrl);
	const response = await fetch(`${source.server}/api/community/roster`, {
		headers: { Authorization: `Bearer ${source.token}` },
		signal: AbortSignal.timeout(10000)
	});
	if (!sameSession(source)) throw new Error('The account session changed while loading entry points');
	if (response.status === 404) return null;
	if (!response.ok) throw new Error(await errorMessage(response));
	const roster = await verifyCommunityRoster(await response.json());
	if (!roster) throw new Error('The server returned an invalid signed entry-point roster');
	return roster;
}

export async function publishCommunityEntryPoints(
	serverUrl: string,
	password: string,
	expectedVersion: number,
	entries: CommunityEntry[]
): Promise<SignedCommunityRoster> {
	const source = authenticatedSource(serverUrl);
	if (!password) throw new Error('Enter your account password to publish entry points');
	const stepup = await fetch(`${source.server}/api/auth/stepup`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${source.token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ password }),
		signal: AbortSignal.timeout(10000)
	});
	if (!sameSession(source)) throw new Error('The account session changed before publishing');
	if (!stepup.ok) throw new Error(await errorMessage(stepup));
	const proof = await stepup.json() as { stepupToken?: unknown };
	if (typeof proof.stepupToken !== 'string' || !proof.stepupToken) {
		throw new Error('The server did not return a step-up token');
	}
	if (!sameSession(source)) throw new Error('The account session changed before publishing');
	const response = await fetch(`${source.server}/api/community/roster`, {
		method: 'PUT',
		headers: {
			Authorization: `Bearer ${source.token}`,
			'X-Stepup-Token': proof.stepupToken,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ expectedVersion, entries }),
		signal: AbortSignal.timeout(10000)
	});
	if (!sameSession(source)) throw new Error('The account session changed while publishing');
	if (!response.ok) throw new Error(await errorMessage(response));
	const roster = await verifyCommunityRoster(await response.json());
	if (!roster || roster.body.version !== expectedVersion + 1) {
		throw new Error('The server returned an invalid signed entry-point update');
	}
	return roster;
}
