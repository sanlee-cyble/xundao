CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  original_name TEXT,
  input_path TEXT,
  run_dir TEXT NOT NULL,
  creators_path TEXT,
  results_path TEXT,
  output_path TEXT,
  source_type TEXT NOT NULL,
  template_id TEXT NOT NULL DEFAULT 'fuji',
  owner_user_id TEXT,
  workspace_id TEXT,
  state TEXT NOT NULL DEFAULT 'DRAFT',
  task_contract_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  task_contract_version INTEGER NOT NULL DEFAULT 1,
  confirmation_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TEXT,
  deleted_at TEXT,
  resumable BOOLEAN NOT NULL DEFAULT TRUE,
  progress_json JSONB NOT NULL DEFAULT '{"done":0,"total":0}'::jsonb,
  logs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  selected_fields_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS template_id TEXT NOT NULL DEFAULT 'fuji';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'DRAFT';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS task_contract_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS task_contract_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS confirmation_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS expires_at TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS deleted_at TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS resumable BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_source_type ON jobs (source_type);
CREATE INDEX IF NOT EXISTS idx_jobs_owner_user_id ON jobs (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_expires_at ON jobs (expires_at);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'media')),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_token_hash ON user_sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions (user_id);

CREATE TABLE IF NOT EXISTS pgy_connections (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('user', 'workspace')),
  owner_id TEXT NOT NULL,
  encrypted_state_path TEXT NOT NULL,
  masked_account_name TEXT,
  status TEXT NOT NULL,
  last_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disconnected_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_pgy_connections_owner ON pgy_connections (owner_type, owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pgy_connections_active_owner
  ON pgy_connections (owner_type, owner_id)
  WHERE disconnected_at IS NULL;

CREATE TABLE IF NOT EXISTS workspace_connection_grants (
  workspace_id TEXT NOT NULL,
  grantee_type TEXT NOT NULL CHECK (grantee_type IN ('role', 'user')),
  grantee_value TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, grantee_type, grantee_value)
);

CREATE INDEX IF NOT EXISTS idx_workspace_connection_grants_grantee
  ON workspace_connection_grants (grantee_type, grantee_value);

CREATE TABLE IF NOT EXISTS job_scope_groups (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  group_key TEXT NOT NULL,
  definition_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'PENDING',
  checkpoint_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_job_scope_groups_job_id ON job_scope_groups (job_id);

CREATE TABLE IF NOT EXISTS job_artifacts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  artifact_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_job_artifacts_job_id ON job_artifacts (job_id);
CREATE INDEX IF NOT EXISTS idx_job_artifacts_expires_at ON job_artifacts (expires_at);

CREATE TABLE IF NOT EXISTS candidate_pools (
  id TEXT PRIMARY KEY,
  name TEXT,
  filters_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  candidates_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  user_id TEXT,
  session_id TEXT,
  job_id TEXT,
  entity_type TEXT,
  entity_id TEXT,
  page TEXT,
  properties_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at ON analytics_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_name ON analytics_events (event_name);
CREATE INDEX IF NOT EXISTS idx_analytics_events_job ON analytics_events (job_id);
