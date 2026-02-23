-- Registered user accounts
CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  handle TEXT UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  color TEXT NOT NULL,
  profile_picture TEXT,
  bio TEXT,
  is_active INTEGER DEFAULT 1,
  username_font_family TEXT DEFAULT 'inherit',
  username_font_size TEXT DEFAULT 'inherit',
  username_font_weight TEXT DEFAULT '600',
  username_font_style TEXT DEFAULT 'normal'
);

-- Unified sessions (temp + registered)
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  user_id INTEGER,
  username TEXT NOT NULL,
  color TEXT NOT NULL,
  profile_picture TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  is_temporary INTEGER DEFAULT 1,
  socket_id TEXT,
  last_seen INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Offline messages (registered recipients only)
CREATE TABLE IF NOT EXISTS offline_messages (
  message_id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user_id INTEGER,
  from_username TEXT NOT NULL,
  to_user_id INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  message_content TEXT NOT NULL,
  message_type TEXT DEFAULT 'text',
  gif_url TEXT,
  file_url TEXT,
  file_name TEXT,
  file_size INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  delivered INTEGER DEFAULT 0,
  FOREIGN KEY (to_user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (from_user_id) REFERENCES users(user_id) ON DELETE SET NULL
);

-- User settings (Signal-style retention)
CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER PRIMARY KEY,
  offline_message_retention TEXT DEFAULT '7d',
  allow_temp_user_messages INTEGER DEFAULT 1,
  business_private_mode INTEGER DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Application-wide settings (owner/admin managed)
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Theme preferences (appearance customization)
CREATE TABLE IF NOT EXISTS theme_preferences (
  user_id INTEGER PRIMARY KEY,
  theme_id TEXT DEFAULT 'midnight-blue',
  custom_theme TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER DEFAULT (strftime('%s', 'now')),
  uniform_font_enabled INTEGER DEFAULT 0,
  uniform_font_family TEXT DEFAULT 'inherit',
  uniform_font_size TEXT DEFAULT 'inherit',
  uniform_font_weight TEXT DEFAULT '600',
  uniform_font_style TEXT DEFAULT 'normal',
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- User roles (admin, mod, contributor, viewer, etc.)
CREATE TABLE IF NOT EXISTS user_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  role_name TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default-workspace',
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Role definitions
CREATE TABLE IF NOT EXISTS roles (
  role_name TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default-workspace',
  display_name TEXT,
  priority INTEGER NOT NULL DEFAULT 10,
  color TEXT,
  is_hoisted INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Resource visibility and privacy
CREATE TABLE IF NOT EXISTS resource_visibility (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id TEXT NOT NULL,
  min_role TEXT DEFAULT 'viewer',
  visibility_type TEXT DEFAULT 'public',
  is_anonymous INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE
);

-- Encryption keys for client-side encryption
CREATE TABLE IF NOT EXISTS user_encryption_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  public_key TEXT NOT NULL,
  private_key_encrypted TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Guest access codes for business hub
CREATE TABLE IF NOT EXISTS guest_codes (
  code TEXT PRIMARY KEY,
  description TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  created_by INTEGER,
  is_active INTEGER DEFAULT 1,
  FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_offline_messages_to_user ON offline_messages(to_user_id, delivered);
CREATE INDEX IF NOT EXISTS idx_offline_messages_expires_at ON offline_messages(expires_at);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_users_handle ON users(handle COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_resource_visibility_resource ON resource_visibility(resource_id);
CREATE INDEX IF NOT EXISTS idx_guest_codes_active ON guest_codes(is_active);

-- Initial guest code
INSERT OR IGNORE INTO guest_codes (code, description, is_active)
VALUES ('VIP2026', 'Default VIP guest access code', 1);

-- Channels table (DMs, groups, public)
CREATE TABLE IF NOT EXISTS channels (
  channel_id TEXT PRIMARY KEY,
  channel_type TEXT NOT NULL DEFAULT 'text',  -- 'text', 'voice', 'dm', 'group', 'thread_public', 'thread_private' (legacy 'public' supported)
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  min_role TEXT DEFAULT 'guest',
  voice_settings_json TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  persist_messages INTEGER DEFAULT 0,
  is_archived INTEGER DEFAULT 0,
  avatar TEXT,
  parent_channel_id TEXT,
  is_breakout INTEGER DEFAULT 0,
  breakout_index INTEGER,
  parent_message_id TEXT,
  thread_archived INTEGER DEFAULT 0,
  thread_locked INTEGER DEFAULT 0,
  thread_auto_archive_minutes INTEGER DEFAULT 1440,
  thread_last_activity_at INTEGER
);

-- Emoji-triggered role automation rules
CREATE TABLE IF NOT EXISTS emoji_role_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  emoji_id TEXT NOT NULL,
  role_name TEXT NOT NULL,
  remove_on_unreact INTEGER DEFAULT 0,
  workspace_id TEXT NOT NULL DEFAULT 'default-workspace',
  enabled INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Channel members (for DMs and groups)
CREATE TABLE IF NOT EXISTS channel_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  registered_user_id INTEGER,
  joined_at INTEGER NOT NULL,
  role TEXT DEFAULT 'member',  -- 'owner', 'admin', 'member'
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE,
  UNIQUE(channel_id, user_id)
);

-- Messages table (all message persistence)
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT UNIQUE NOT NULL,
  channel_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_username TEXT NOT NULL,
  sender_color TEXT,
  message_type TEXT NOT NULL DEFAULT 'text',
  content TEXT NOT NULL,
  gif_url TEXT,
  file_url TEXT,
  file_name TEXT,
  file_size INTEGER,
  files_json TEXT,
  attachment_encryption_json TEXT,
  reply_to_id TEXT,
  is_spoiler INTEGER DEFAULT 0,
  is_pinned INTEGER DEFAULT 0,
  is_edited INTEGER DEFAULT 0,
  reactions_json TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

-- Indexes for new tables
CREATE INDEX IF NOT EXISTS idx_channels_type ON channels(channel_type);
CREATE INDEX IF NOT EXISTS idx_channels_parent ON channels(parent_channel_id);
CREATE INDEX IF NOT EXISTS idx_channel_members_channel ON channel_members(channel_id);
CREATE INDEX IF NOT EXISTS idx_channel_members_user ON channel_members(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_id ON messages(message_id);
CREATE INDEX IF NOT EXISTS idx_emoji_role_rules_lookup ON emoji_role_rules(channel_id, message_id, emoji_id, workspace_id);

-- Relay servers (community-hosted file CDN nodes)
CREATE TABLE IF NOT EXISTS relays (
  relay_id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  region TEXT NOT NULL,
  api_key_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  last_health_ping INTEGER,
  registered_at INTEGER NOT NULL,
  approved INTEGER DEFAULT 0,
  latitude REAL,
  longitude REAL,
  bandwidth_mbps INTEGER,
  storage_gb INTEGER,
  syncthing_device_id TEXT,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_relays_status ON relays(status);
CREATE INDEX IF NOT EXISTS idx_relays_region ON relays(region);

-- Outbound webhooks (user-managed event subscriptions)
CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  target_url TEXT NOT NULL,
  secret TEXT NOT NULL,
  event_filters TEXT NOT NULL, -- JSON array of event names
  enabled INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|success|failed
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  response_code INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  delivered_at INTEGER,
  FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_webhooks_user ON webhooks(user_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_enabled ON webhooks(enabled);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(status, updated_at);
