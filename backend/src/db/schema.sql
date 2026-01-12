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

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_offline_messages_to_user ON offline_messages(to_user_id, delivered);
CREATE INDEX IF NOT EXISTS idx_offline_messages_expires_at ON offline_messages(expires_at);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE);
