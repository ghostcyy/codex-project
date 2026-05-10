-- Optional dedicated base URL for text-to-image calls.
-- When empty, runtime image generation falls back to base_url.
ALTER TABLE llm_provider_settings
ADD COLUMN IF NOT EXISTS image_base_url TEXT NOT NULL DEFAULT '';
