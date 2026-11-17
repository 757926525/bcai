-- ==========================================
-- BCAI 工作台 — Cloudflare D1 数据库结构
-- 执行初始化: wrangler d1 execute bcai-db --file=./schema.sql
-- ==========================================

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('chat', 'code', 'repo')),
  model_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  repo_full_name TEXT,
  repo_branch TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused')),
  messages_json TEXT,
  storage_location TEXT NOT NULL DEFAULT 'd1',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  model_id TEXT,
  attachments_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('image', 'file')),
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  prompt TEXT,
  model_id TEXT,
  content_data TEXT NOT NULL,
  repo_path TEXT,
  storage_location TEXT NOT NULL DEFAULT 'd1',
  bucket_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_media_type ON media_assets(type, updated_at DESC);
