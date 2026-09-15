export interface FrontendAppMetadataPolicy {
  displayName: string | null;
  iconUrl: string | null;
  bannerUrl: string | null;
  accentColor: string | null;
  description: string | null;
  tagline: string | null;
  launchPageFallbackEnabled: boolean;
  brandProfile?: string | null;
}

export type AuthPolicyMode = 'open' | 'invite' | 'verified';

export interface AuthPolicy {
  mode: AuthPolicyMode;
  allowGuest: boolean;
  allowRegister: boolean;
  emailVerifyRequired: boolean;
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

export type SafetyRuleMatch = 'contains' | 'equals' | 'starts_with' | 'ends_with';
export type SafetyRuleAction = 'flag' | 'delete' | 'warn' | 'timeout' | 'ban';

export interface SafetyRule {
  id: string;
  enabled: boolean;
  name: string;
  pattern: string;
  match: SafetyRuleMatch;
  caseSensitive: boolean;
  action: SafetyRuleAction;
  timeoutMinutes: number | null;
  reason: string | null;
}

export interface SafetyRulesPolicy {
  enabled: boolean;
  rules: SafetyRule[];
  defaultFlagChannelId: string | null;
}

export type ServerDefaultRetention = 'live' | '1h' | '24h' | '7d' | '30d' | 'forever';
export type ServerAnalyticsMode = 'off' | 'local_aggregate';
export type ServerExternalProcessingMode = 'none' | 'declared_integrations';

/**
 * Server-wide privacy defaults. Channel retention remains independently adjustable;
 * changing these defaults does not retroactively rewrite existing channel history.
 */
export interface ServerPrivacyPolicy {
  /** Default retention assigned to newly created community channels. */
  defaultRetention: ServerDefaultRetention;
  /** Safety rules inspect public/community spaces by default. This is an explicit opt-in for server-readable DMs/groups. */
  privateContentAutomation: boolean;
  /** Wabi never needs central analytics; this only describes local aggregate administration metrics. */
  analyticsMode: ServerAnalyticsMode;
  /** External processing is disabled unless the operator deliberately enables declared integrations. */
  externalProcessing: ServerExternalProcessingMode;
  /** User reports explicitly preserve the submitted message snapshot as moderation evidence. */
  reportEvidencePreservation: 'explicit_report';
}
