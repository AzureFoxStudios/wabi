export interface DeskPosterBlock {
  id: string;
  kind: 'text' | 'link' | 'role';
  text: string;
  x: number;
  y: number;
  width: number;
  url?: string | null;
  roleId?: string | null;
}

export interface FrontendAppMetadataPolicy {
  /** Compare-and-swap publication revision for server branding and poster content. */
  revision?: number;
  displayName: string | null;
  iconUrl: string | null;
  bannerUrl: string | null;
  /** Reference Desk motion artwork and its required still fallback. */
  deskBackgroundUrl?: string | null;
  deskStillUrl?: string | null;
  accentColor: string | null;
  description: string | null;
  deskWelcomeText?: string | null;
  deskHelpText?: string | null;
  deskHelpUrl?: string | null;
  deskHelpLabel?: string | null;
  deskPosterBlocks?: DeskPosterBlock[];
  deskStartingRoomId?: string | null;
  deskFocusedWelcome?: boolean;
  tagline: string | null;
  launchPageFallbackEnabled: boolean;
  brandProfile?: string | null;
  /** Server-wide identity marks shown for owner and staff roles. */
  ownerBadgeMark?: string | null;
  staffBadgeMark?: string | null;
  /** Community title face: one of the ids in frontend/src/lib/theme/displayFonts.ts (stored as plain JSON). */
  displayFont?: string | null;
}

export type AuthPolicyMode = 'open' | 'invite' | 'closed' | 'verified';

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
  /** Applies only to snapshots in new reports. Null means owner removal is manual. */
  reportEvidenceDays: 1 | 7 | 30 | 90 | null;
}
