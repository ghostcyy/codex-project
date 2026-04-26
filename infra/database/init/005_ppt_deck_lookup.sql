CREATE INDEX IF NOT EXISTS idx_ppt_messages_deck_render_id
ON ppt_messages (((meta -> 'deckRender' ->> 'deckId')))
WHERE role = 'assistant';
