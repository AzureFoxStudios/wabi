/**
 * Application-wide constants for the Wabi backend.
 *
 * All magic strings and hardcoded values should be defined here.
 * Import from this file instead of using inline string literals.
 */
import { join } from 'path';

// ─── Workspace ────────────────────────────────────────────────────────────────

/** The ID of the single shared workspace that all users collaborate in. */
export const DEFAULT_WORKSPACE_ID = 'default-workspace';

// ─── Default channels ─────────────────────────────────────────────────────────

/** The ID of the default text channel that is always present. */
export const DEFAULT_TEXT_CHANNEL_ID = 'general';

/** The ID of the default voice channel that is always present. */
export const DEFAULT_VOICE_CHANNEL_ID = 'voice';

// ─── File system paths ────────────────────────────────────────────────────────

/** Root directory for all server-side persistent data (messages, business data). */
export const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');

/** Root directory for uploaded files (profile pictures, attachments, emojis). */
export const UPLOADS_DIR = process.env.UPLOADS_DIR || join(process.cwd(), 'uploads');

/** Default directory for the compiled frontend static assets. */
export const DEFAULT_STATIC_DIR = join(process.cwd(), '..', 'frontend', 'build');

/** Sub-directory name (under DATA_DIR) for business workspace JSON files. */
export const BUSINESS_DATA_DIR_NAME = 'business';

// ─── Roles ────────────────────────────────────────────────────────────────────

/**
 * Canonical role name constants.
 * Use these instead of bare string literals to prevent typos and enable
 * find-all-references from IDEs.
 */
export const ROLES = {
  OWNER:  'owner',
  ADMIN:  'admin',
  MOD:    'mod',
  MEMBER: 'member',
  GUEST:  'guest',
} as const;

export type RoleName = typeof ROLES[keyof typeof ROLES];

/** Roles that are considered privileged (can manage other users and settings). */
export const PRIVILEGED_ROLES: RoleName[] = [ROLES.OWNER, ROLES.ADMIN];

/** Roles that can moderate voice channels and create breakout rooms. */
export const MODERATOR_ROLES: RoleName[] = [ROLES.OWNER, ROLES.ADMIN, ROLES.MOD];
