import { getAuthToken } from '../authSession';
import { createChannelMembership } from '../channelMembership';
import { fetchWithTimeout, getApiBase } from './utils';
import { captureGroupAccess } from '../groupAccess';

const membership = createChannelMembership({
	server: getApiBase,
	token: getAuthToken,
	fetch: fetchWithTimeout,
	access: captureGroupAccess
});

export const ensureChannelMembership = membership.ensure;
export const fetchChannel = membership.fetchChannel;
