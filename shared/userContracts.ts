export type HomeExperienceMode = 'community' | 'conversations';
export type OfflineMessageRetention = '1d' | '7d' | '30d' | 'forever';

export interface AuthUserProfile {
	id: number;
	username: string;
	handle?: string;
	color: string;
	profilePicture?: string;
	isRegistered: boolean;
}

export interface AuthResponse {
	/** Primary field going forward (A1 rotation). Backend serializes it. */
	accessToken: string;
	/** Legacy alias of accessToken — still serialized for older clients. */
	token?: string;
	refreshToken?: string;
	mustChangePassword?: boolean;
	user: AuthUserProfile;
}

/** Resolve the access token from either wire spelling (migration helper). */
export function authAccessToken(res: Pick<AuthResponse, 'accessToken' | 'token'>): string {
	return res.accessToken || res.token || '';
}

export interface UserSettingsResponse {
	offline_message_retention: OfflineMessageRetention;
	allow_temp_user_messages: boolean;
	home_experience: HomeExperienceMode;
	require_password_change: boolean;
	payment_preferred_route: string | null;
}

export interface UserSettingsPayload {
	offline_message_retention?: OfflineMessageRetention;
	allow_temp_user_messages?: boolean;
	home_experience?: HomeExperienceMode;
	payment_preferred_route?: string | null;
}

export interface FollowedChannelPollRequest {
	channelId: string;
	afterMessageId?: string | null;
	limit?: number;
}

export interface FollowedChannelPollChannelResult<TMessage = unknown> {
	channelId: string;
	channelName: string;
	channelType: string;
	cursorReset: boolean;
	messages: TMessage[];
}

export interface FollowedChannelPollResponse<TMessage = unknown> {
	success: boolean;
	serverTime: number;
	channels: FollowedChannelPollChannelResult<TMessage>[];
}
