-- Migration 071: avatar columns on principals
ALTER TABLE g1.principals
    ADD COLUMN IF NOT EXISTS avatar_data        TEXT,
    ADD COLUMN IF NOT EXISTS avatar_content_type TEXT;
