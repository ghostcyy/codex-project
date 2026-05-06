CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  email VARCHAR(255) NOT NULL UNIQUE,
  display_name VARCHAR(128),
  password_hash VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS roles (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(128) NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS permissions (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(128) NOT NULL UNIQUE,
  name VARCHAR(128) NOT NULL,
  resource VARCHAR(128) NOT NULL,
  action VARCHAR(64) NOT NULL
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_id BIGINT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id BIGINT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  permission_id BIGINT NOT NULL REFERENCES permissions (id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS news_articles (
  id BIGSERIAL PRIMARY KEY,
  slug VARCHAR(128) NOT NULL UNIQUE,
  title VARCHAR(255) NOT NULL,
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  source_name VARCHAR(255) NOT NULL,
  source_url TEXT NOT NULL,
  publish_date TIMESTAMPTZ NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  created_by BIGINT REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS news_tags (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(64) NOT NULL UNIQUE,
  slug VARCHAR(64) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS article_tags (
  article_id BIGINT NOT NULL REFERENCES news_articles (id) ON DELETE CASCADE,
  tag_id BIGINT NOT NULL REFERENCES news_tags (id) ON DELETE CASCADE,
  PRIMARY KEY (article_id, tag_id)
);

CREATE TABLE IF NOT EXISTS operation_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  action VARCHAR(128) NOT NULL,
  target_type VARCHAR(128) NOT NULL,
  target_id VARCHAR(128),
  detail JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS llm_provider_settings (
  id BIGSERIAL PRIMARY KEY,
  provider_type VARCHAR(64) NOT NULL DEFAULT 'minimax-cli',
  base_url TEXT NOT NULL,
  api_key_ciphertext TEXT NOT NULL,
  model VARCHAR(255) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by BIGINT REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ppt_projects (
  id VARCHAR(64) PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  template_id VARCHAR(128),
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ppt_messages (
  id VARCHAR(64) PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL REFERENCES ppt_projects (id) ON DELETE CASCADE,
  role VARCHAR(32) NOT NULL,
  content TEXT NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ppt_project_summaries (
  project_id VARCHAR(64) PRIMARY KEY REFERENCES ppt_projects (id) ON DELETE CASCADE,
  summary_text TEXT NOT NULL DEFAULT '',
  summarized_message_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ppt_v2_deck_jobs (
  id VARCHAR(64) PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  status VARCHAR(32) NOT NULL,
  stages JSONB NOT NULL DEFAULT '[]'::JSONB,
  result JSONB,
  error TEXT,
  model_calls INTEGER NOT NULL DEFAULT 0,
  allow_verification_failure BOOLEAN NOT NULL DEFAULT FALSE,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_news_articles_publish_date ON news_articles (publish_date DESC);
CREATE INDEX IF NOT EXISTS idx_news_articles_status ON news_articles (status);
CREATE INDEX IF NOT EXISTS idx_users_status ON users (status);
CREATE INDEX IF NOT EXISTS idx_operation_logs_user_id ON operation_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_operation_logs_created_at ON operation_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_provider_settings_enabled ON llm_provider_settings (enabled);
CREATE INDEX IF NOT EXISTS idx_ppt_projects_user_id ON ppt_projects (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ppt_projects_status ON ppt_projects (status);
CREATE INDEX IF NOT EXISTS idx_ppt_messages_project_id ON ppt_messages (project_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_ppt_project_summaries_updated_at ON ppt_project_summaries (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ppt_v2_deck_jobs_user_updated ON ppt_v2_deck_jobs (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ppt_v2_deck_jobs_status ON ppt_v2_deck_jobs (status);
