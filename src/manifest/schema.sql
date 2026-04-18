-- @qmediat.io/gemini-code-context-mcp — manifest schema v1
-- Local SQLite DB keeping workspace → cache_id + file → file_id mappings.

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_root       TEXT PRIMARY KEY,
  files_hash           TEXT NOT NULL,
  model                TEXT NOT NULL,
  system_prompt_hash   TEXT NOT NULL DEFAULT '',
  cache_id             TEXT,
  cache_expires_at     INTEGER,
  file_ids             TEXT NOT NULL DEFAULT '[]',
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  workspace_root       TEXT NOT NULL,
  relpath              TEXT NOT NULL,
  content_hash         TEXT NOT NULL,
  file_id              TEXT,
  uploaded_at          INTEGER,
  expires_at           INTEGER,
  PRIMARY KEY (workspace_root, relpath),
  FOREIGN KEY (workspace_root) REFERENCES workspaces(workspace_root) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);

CREATE TABLE IF NOT EXISTS usage_metrics (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_root       TEXT NOT NULL,
  tool_name            TEXT NOT NULL,
  model                TEXT,
  cached_tokens        INTEGER,
  uncached_tokens      INTEGER,
  cost_usd_micro       INTEGER,
  duration_ms          INTEGER NOT NULL,
  occurred_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_occurred_at ON usage_metrics(occurred_at);
CREATE INDEX IF NOT EXISTS idx_usage_workspace ON usage_metrics(workspace_root);

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
