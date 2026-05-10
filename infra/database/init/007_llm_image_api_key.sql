-- Separate encrypted API Key for text-to-image calls.
-- When empty, runtime image generation falls back to api_key_ciphertext.
ALTER TABLE llm_provider_settings
ADD COLUMN IF NOT EXISTS image_api_key_ciphertext TEXT NOT NULL DEFAULT '';
