-- Registered user accounts
CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  color TEXT NOT NULL,
  profile_picture TEXT,
  bio TEXT,
  is_active INTEGER DEFAULT 1
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
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Theme preferences (appearance customization)
CREATE TABLE IF NOT EXISTS theme_preferences (
  user_id INTEGER PRIMARY KEY,
  theme_id TEXT DEFAULT 'dark',
  custom_theme TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER DEFAULT (strftime('%s', 'now')),
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

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_offline_messages_to_user ON offline_messages(to_user_id, delivered);
CREATE INDEX IF NOT EXISTS idx_offline_messages_expires_at ON offline_messages(expires_at);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_resource_visibility_resource ON resource_visibility(resource_id);
