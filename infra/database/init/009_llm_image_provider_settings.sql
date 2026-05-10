-- Dedicated singleton configuration for text-to-image model calls.
-- This keeps the text model's Default Model separate from the image model's Default Image Model.
CREATE TABLE IF NOT EXISTS llm_image_provider_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  name VARCHAR(128) NOT NULL DEFAULT 'Default Image Model',
  provider_type VARCHAR(64) NOT NULL DEFAULT 'openai-compatible',
  base_url TEXT NOT NULL DEFAULT 'https://mimimax.cn/v1',
  api_key_ciphertext TEXT NOT NULL DEFAULT '',
  model VARCHAR(128) NOT NULL DEFAULT 'image-01',
  updated_by BIGINT REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO llm_image_provider_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- One-time compatibility migration from the old mixed text/image config fields.
UPDATE llm_image_provider_settings image_config
SET
  base_url = COALESCE(NULLIF(text_config.image_base_url, ''), image_config.base_url),
  api_key_ciphertext = COALESCE(NULLIF(text_config.image_api_key_ciphertext, ''), image_config.api_key_ciphertext),
  updated_at = NOW()
FROM llm_provider_settings text_config
WHERE image_config.id = 1
  AND text_config.enabled = TRUE
  AND image_config.api_key_ciphertext = '';
