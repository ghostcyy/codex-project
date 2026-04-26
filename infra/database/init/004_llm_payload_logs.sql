CREATE TABLE IF NOT EXISTS llm_call_payloads (
  id BIGSERIAL PRIMARY KEY,
  config_id BIGINT REFERENCES llm_provider_settings (id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  project_id VARCHAR(64) REFERENCES ppt_projects (id) ON DELETE SET NULL,
  message_id VARCHAR(64) REFERENCES ppt_messages (id) ON DELETE SET NULL,
  source VARCHAR(64) NOT NULL DEFAULT 'unknown',
  stage VARCHAR(128),
  request_payload JSONB,
  response_payload JSONB,
  status VARCHAR(16) NOT NULL DEFAULT 'success',
  error_message TEXT,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_llm_call_payloads_created_at ON llm_call_payloads (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_call_payloads_project_id ON llm_call_payloads (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_call_payloads_message_id ON llm_call_payloads (message_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_call_payloads_user_id ON llm_call_payloads (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_call_payloads_config_id ON llm_call_payloads (config_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_call_payloads_status ON llm_call_payloads (status, created_at DESC);
