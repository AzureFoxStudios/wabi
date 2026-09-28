/** The desktop profile owns the process; the normal server registry owns client accounts. */
import type { StarterChannel } from './api/auth';
export interface HostStatus {
	running: boolean;
	ready: boolean;
	setupRequired: boolean | null;
	localUrl: string | null;
	sharing: 'local' | 'lan';
	error: string | null;
	dataDirectory: string;
	logDirectory: string;
	backupIds: string[];
	binaryAvailable: boolean;
	buildRevision: string;
	testBuild: boolean;
	communityName: string | null;
	hasCommunity: boolean;
	serverId: string | null;
}

export interface HostAccount {
	accessToken: string;
	refreshToken: string;
	user: { id: number; username: string };
}

export type HostCommand = <T>(name: string, args?: Record<string, unknown>) => Promise<T>;
export type HostStateLabel = 'Starting' | 'Ready' | 'Stopped' | 'Failed';

export function hostStateLabel(host: HostStatus | null, starting = false): HostStateLabel {
	if (starting) return 'Starting';
	if (host?.error) return 'Failed';
	if (host?.running) return host.ready ? 'Ready' : 'Starting';
	return 'Stopped';
}

export function shouldOpenHosting(configuredUrl: string | null, host: HostStatus): boolean {
	return !configuredUrl || (host.hasCommunity && configuredUrl === host.localUrl && (!host.ready || host.setupRequired !== false));
}

export async function createHostedCommunity(
	command: HostCommand,
	input: { communityName: string; username: string; password: string; confirmation: string; starterChannels?: StarterChannel[] }
): Promise<{ host: HostStatus; account: HostAccount }> {
	const communityName = input.communityName.trim();
	const username = input.username.trim();
	if (!communityName || communityName.length > 80) throw new Error('Enter a community name of up to 80 characters.');
	if (username.length < 2 || username.length > 64) throw new Error('Use a username between 2 and 64 characters.');
	if (input.password.length < 8 || input.password !== input.confirmation) {
		throw new Error('Use at least eight characters and repeat the same password.');
	}
	if (input.starterChannels && (input.starterChannels.length > 12 || input.starterChannels.some(channel => !channel.name.trim() || !['text', 'voice'].includes(channel.kind)))) {
		throw new Error('Choose up to twelve named text or voice rooms.');
	}
	const started = await command<HostStatus>('host_start');
	if (!started.ready || !started.localUrl || started.setupRequired === null) {
		throw new Error(started.error || 'The community is not ready yet. Check Server status before trying again.');
	}
	if (!started.setupRequired) throw new Error('This computer already has a community. Sign in with its existing owner account.');
	const account = await command<HostAccount>('host_account', { username, password: input.password, register: true, communityName, starterChannels: input.starterChannels });
	return { host: started, account };
}

/** Probe before switching servers, so Join never exposes a first-owner setup flow. */
export async function checkCommunityForJoin(server: string, request: (url: string, options: RequestInit) => Promise<Response> = fetch): Promise<void> {
	let response: Response;
	try {
		response = await request(`${server}/api/setup/status`, {
			credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000)
		});
	} catch {
		throw new Error('Could not reach this community. Check the address, ask the host to start it, and make sure you are on the right network.');
	}
	if (!response.ok) throw new Error('This community could not be reached. Check its address and that the host is running.');
	const status: unknown = await response.json();
	if (!status || typeof status !== 'object' || !('setupRequired' in status) || typeof status.setupRequired !== 'boolean') {
		throw new Error('This address did not respond as a Wabi community. Check the address with its host.');
	}
	if (status.setupRequired) throw new Error('The host must finish creating their owner account before you can join. No new server has been started.');
}
