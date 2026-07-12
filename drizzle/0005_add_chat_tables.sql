-- Chat sessions table
CREATE TABLE IF NOT EXISTS chat_sessions (
  id            SERIAL PRIMARY KEY,
  device_id     TEXT NOT NULL,
  email         TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending',
  admin_avatar  TEXT NOT NULL DEFAULT '',
  admin_name    TEXT NOT NULL DEFAULT '',
  admin_online  BOOLEAN NOT NULL DEFAULT FALSE,
  discord_channel_id TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Chat messages table
CREATE TABLE IF NOT EXISTS chat_messages (
  id          SERIAL PRIMARY KEY,
  session_id  INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  sender      TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL DEFAULT 'text',
  image_data  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast polling
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_device_id ON chat_sessions(device_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_status ON chat_sessions(status);
