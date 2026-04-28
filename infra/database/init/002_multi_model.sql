-- 升级模型配置表，支持多条记录并增加别名字段
ALTER TABLE llm_provider_settings
ADD COLUMN IF NOT EXISTS name VARCHAR(128) NOT NULL DEFAULT 'Default Model';

-- HTML-PPT 编排可按阶段覆盖模型 ID；未配置的阶段回退到主 model 字段。
ALTER TABLE llm_provider_settings
ADD COLUMN IF NOT EXISTS stage_model_overrides JSONB NOT NULL DEFAULT '{}'::JSONB;

-- 记录每次调用大模型消耗情况的日志表
CREATE TABLE IF NOT EXISTS llm_call_logs (
  id BIGSERIAL PRIMARY KEY,
  config_id BIGINT REFERENCES llm_provider_settings (id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_llm_call_logs_config_id ON llm_call_logs (config_id);
CREATE INDEX IF NOT EXISTS idx_llm_call_logs_user_id ON llm_call_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_llm_call_logs_created_at ON llm_call_logs (created_at DESC);
