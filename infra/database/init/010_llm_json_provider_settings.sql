-- Dedicated singleton configuration for structured JSON model calls.
-- V3 intent parsing and Stage 1 planning use this instead of the default text model.
CREATE TABLE IF NOT EXISTS llm_json_provider_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  name VARCHAR(128) NOT NULL DEFAULT 'Default JSON Model',
  provider_type VARCHAR(64) NOT NULL DEFAULT 'minimax',
  base_url TEXT NOT NULL DEFAULT 'https://api.minimax.io/v1',
  api_key_ciphertext TEXT NOT NULL DEFAULT '',
  model VARCHAR(128) NOT NULL DEFAULT 'MiniMax-Text-01',
  updated_by BIGINT REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO llm_json_provider_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- Reuse the active text-model credential unless the JSON model has been configured separately.
UPDATE llm_json_provider_settings json_config
SET
  api_key_ciphertext = COALESCE(NULLIF(text_config.api_key_ciphertext, ''), json_config.api_key_ciphertext),
  updated_at = NOW()
FROM llm_provider_settings text_config
WHERE json_config.id = 1
  AND text_config.enabled = TRUE
  AND json_config.api_key_ciphertext = '';
