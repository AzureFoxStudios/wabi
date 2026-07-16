export interface FrontendAppMetadataPolicy {
  displayName: string | null;
  iconUrl: string | null;
  bannerUrl: string | null;
  accentColor: string | null;
  description: string | null;
  tagline: string | null;
  launchPageFallbackEnabled: boolean;
}

export interface PaymentAccessPolicy {
  enabled: boolean;
  allowGuest: boolean;
  allowedRoleNames: string[];
}

export interface PaymentAccountLink {
  userId: number;
  workspaceId: string;
  pluginId: string;
  providerAccountRef: string;
  displayLabel: string | null;
  metadata: Record<string, unknown> | null;
  linkedAt: number;
  updatedAt: number;
}

export interface PaymentDonationConfig {
  enabled: boolean;
  providerPluginId: string | null;
  methodId: string | null;
  currency: string;
  countryCode: string | null;
  suggestedAmountsMinor: number[];
  headline: string;
  description: string;
}

export type CommunityNodeAccessMode = 'open' | 'approval_required' | 'whitelist_only';

export interface CommunityNodeAllowedUser {
  userId: number;
  username: string;
}

export interface CommunityNodeAccessPolicy {
  mode: CommunityNodeAccessMode;
  allowedUsers: CommunityNodeAllowedUser[];
}

export interface CommunityNodeAnnouncementsPolicy {
  enabled: boolean;
  channelId: string | null;
  onlineTemplate: string;
  offlineTemplate: string;
}
